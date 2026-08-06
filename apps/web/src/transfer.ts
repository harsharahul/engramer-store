import {
  encryptBytes,
  utf8Encode,
  decryptContent,
  encryptFileMetadata,
  generateKey,
  secretBoxSeal,
  streamCiphertextSize,
  StreamEncryptor,
  STREAM_CHUNK_SIZE,
  ChunkedEncryptor,
  chunkedEncrypt,
  chunkedCiphertextSize,
  type FileMetadata,
  type Digester,
  contentDigest,
  createDigester,
  digestMatches,
} from "@engramer/crypto";
import {
  api,
  abortPartUpload,
  ApiError,
  beginPartUpload,
  completePartUpload,
  uploadBlob,
  uploadPart,
  UPLOAD_CANCELLED,
  type FileDto,
} from "./api";
import { categorize, type Analysis } from "./intel/categorize";
import { extractExif, extractText, isPdf } from "./intel/extract";
import { ocrEnabled, recognizeImage, recognizePdf, renderPdfPage } from "./intel/ocr";
import { embedImage, semanticEnabled } from "./intel/semantic";
import { factsEnabled, scanForFacts } from "./intel/scan";
import type { Fact, FactEvidence } from "./intel/facts";
import { encodeIndexPayload } from "./indexblob";
import { computeBlur } from "./intel/blur";
import { diag } from "./diag";

const THUMB_SIZE = 512;

interface Thumbnail {
  bytes: Uint8Array;
  width: number;
  height: number;
  /** ThumbHash placeholder, painted before any thumbnail request. */
  blur?: string;
}

function drawScaled(source: CanvasImageSource, width: number, height: number): Promise<Blob | null> {
  const scale = Math.min(1, THUMB_SIZE / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return Promise.resolve(null);
  }
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.82));
}

async function imageThumbnail(file: File): Promise<Thumbnail | null> {
  try {
    const bitmap = await createImageBitmap(file);
    const { width, height } = bitmap;
    const blob = await drawScaled(bitmap, width, height);
    const blur = computeBlur(bitmap, width, height);
    bitmap.close();
    if (!blob) {
      return null;
    }
    return { bytes: new Uint8Array(await blob.arrayBuffer()), width, height, blur };
  } catch {
    return null;
  }
}

/**
 * Analysis is a nicety; an upload must never wait on it forever. Mobile
 * browsers in particular can leave media decoding pending indefinitely, so
 * every step runs under a deadline and simply yields nothing when it lapses.
 */
export function withDeadline<T>(
  work: Promise<T>,
  ms: number,
  signal?: AbortSignal,
): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    const settle = (value: T | undefined) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(value);
    };
    // Cancelling mid-analysis abandons the step immediately; the worker it
    // fed may keep chewing briefly, but the upload flow moves on.
    const onAbort = () => settle(undefined);
    if (signal?.aborted) {
      return settle(undefined);
    }
    signal?.addEventListener("abort", onAbort);
    void work.then(settle).catch(() => settle(undefined));
  });
}

const THUMB_DEADLINE_MS = 10_000;
const ANALYSIS_DEADLINE_MS = 20_000;

// WebKit may not have painted a seeked-to frame when its event fires;
// capturing then yields black. Wait for a presented frame, with a timeout
// so a codec quirk can never wedge the pipeline.
function awaitPresentedFrame(video: HTMLVideoElement): Promise<void> {
  return new Promise((resolve) => {
    const v = video as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: () => void) => void;
    };
    if (typeof v.requestVideoFrameCallback === "function") {
      v.requestVideoFrameCallback(() => resolve());
    } else {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }
    setTimeout(resolve, 1_000);
  });
}

function seekTo(video: HTMLVideoElement, at: number): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const settle = () => {
      if (!done) {
        done = true;
        video.removeEventListener("seeked", settle);
        resolve();
      }
    };
    video.addEventListener("seeked", settle);
    video.currentTime = at;
    setTimeout(settle, 3_000);
  });
}

/** How many frames represent a video in meaning search. */
const MEANING_FRAMES = 5;

/**
 * Frames spread across a video's timeline, so meaning search can match any
 * scene rather than only the poster. Short or duration-less clips yield
 * nothing extra; the poster alone already covers them.
 */
async function sampleVideoFrames(file: File): Promise<Blob[]> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    const frames: Blob[] = [];
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      URL.revokeObjectURL(url);
      video.removeAttribute("src");
      video.load();
      resolve(frames);
    };
    video.muted = true;
    video.playsInline = true;
    video.preload = "metadata";
    video.setAttribute("playsinline", "");
    video.setAttribute("muted", "");
    video.src = url;
    const timer = setTimeout(finish, 45_000);
    video.onerror = () => {
      clearTimeout(timer);
      finish();
    };
    video.onloadedmetadata = () => {
      void (async () => {
        const duration = video.duration;
        if (!Number.isFinite(duration) || duration <= 3 || !video.videoWidth) {
          clearTimeout(timer);
          return finish();
        }
        for (let i = 0; i < MEANING_FRAMES && !settled; i++) {
          await seekTo(video, duration * ((i + 0.5) / MEANING_FRAMES));
          await awaitPresentedFrame(video);
          const blob = await drawScaled(video, video.videoWidth, video.videoHeight);
          if (blob) {
            frames.push(blob);
          }
        }
        clearTimeout(timer);
        finish();
      })();
    };
  });
}

async function videoThumbnail(file: File): Promise<Thumbnail | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    let settled = false;
    const finish = (result: Thumbnail | null) => {
      if (settled) {
        return;
      }
      settled = true;
      URL.revokeObjectURL(url);
      video.removeAttribute("src");
      video.load();
      resolve(result);
    };
    // iOS refuses to decode a video that is not marked inline, and defers
    // loading entirely without an explicit preload hint; without both, the
    // data events never fire and this promise would hang the upload.
    video.muted = true;
    video.playsInline = true;
    video.preload = "metadata";
    video.setAttribute("playsinline", "");
    video.setAttribute("muted", "");
    video.src = url;
    // Mean luminance of a coarse sample; enough to tell a fade-from-black
    // opening frame from a real one.
    const frameLuminance = () => {
      const canvas = document.createElement("canvas");
      canvas.width = 16;
      canvas.height = 10;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        return 255;
      }
      ctx.drawImage(video, 0, 0, 16, 10);
      const data = ctx.getImageData(0, 0, 16, 10).data;
      let sum = 0;
      for (let i = 0; i < data.length; i += 4) {
        sum += 0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!;
      }
      return sum / (data.length / 4);
    };
    let retriedBlack = false;
    const capture = async () => {
      if (settled) {
        return;
      }
      const { videoWidth, videoHeight } = video;
      if (!videoWidth || !videoHeight) {
        return finish(null);
      }
      await awaitPresentedFrame(video);
      if (settled) {
        return;
      }
      // A pitch-black poster helps nobody; one seek deeper into the clip
      // rescues footage that fades in from black.
      if (
        !retriedBlack &&
        Number.isFinite(video.duration) &&
        video.duration > 2 &&
        frameLuminance() < 8
      ) {
        retriedBlack = true;
        video.currentTime = Math.min(video.duration / 2, 3);
        return;
      }
      const blob = await drawScaled(video, videoWidth, videoHeight);
      const blur = computeBlur(video, videoWidth, videoHeight);
      if (!blob) {
        return finish(null);
      }
      finish({
        bytes: new Uint8Array(await blob.arrayBuffer()),
        width: videoWidth,
        height: videoHeight,
        blur,
      });
    };
    video.onloadedmetadata = () => {
      // Seeking a hair into the clip avoids a black opening frame; some
      // browsers only paint after a seek completes, others right away.
      video.currentTime = Math.min(0.5, Number.isFinite(video.duration) ? video.duration / 2 : 0);
    };
    video.onloadeddata = () => void capture();
    video.onseeked = () => void capture();
    video.onerror = () => finish(null);
    setTimeout(() => finish(null), THUMB_DEADLINE_MS);
  });
}

async function makeThumbnail(file: File): Promise<Thumbnail | null> {
  if (file.type.startsWith("image/")) {
    return imageThumbnail(file);
  }
  if (file.type.startsWith("video/")) {
    return videoThumbnail(file);
  }
  return null;
}

export interface PreparedFile {
  meta: FileMetadata;
  analysis: Analysis;
  thumbnail: Thumbnail | null;
  /** Extracted search text; uploaded inside the encrypted index blob. */
  text?: string;
  /** Semantic image embedding; rides in the same index blob. */
  clip?: Float32Array;
  /** All meaning vectors for videos: poster plus sampled frames. */
  clips?: Float32Array[];
  /** Where each fact came from; rides in the same index blob. */
  evidence?: FactEvidence[];
}

/**
 * Client-side analysis phase: search text, EXIF, category, tags, thumbnail.
 * Everything computed here ships only inside encrypted metadata.
 */
export async function analyzeFile(
  file: File,
  signal?: AbortSignal,
  onPhase?: (phase: string) => void,
): Promise<PreparedFile> {
  const cancelled = () => {
    if (signal?.aborted) {
      throw new ApiError(UPLOAD_CANCELLED, "upload cancelled");
    }
  };
  onPhase?.("analyzing");
  let [text, exif, thumbnail] = await Promise.all([
    withDeadline(extractText(file), ANALYSIS_DEADLINE_MS, signal),
    withDeadline(extractExif(file), ANALYSIS_DEADLINE_MS, signal),
    withDeadline(makeThumbnail(file), THUMB_DEADLINE_MS + 2_000, signal).then((t) => t ?? null),
  ]);
  cancelled();
  // Opt-in OCR: screenshots and scans become searchable, and the recognized
  // text sharpens categorization (a photographed invoice files as a receipt).
  if (text === undefined && file.type.startsWith("image/") && ocrEnabled()) {
    onPhase?.("reading text");
    text = await withDeadline(recognizeImage(file), ANALYSIS_DEADLINE_MS * 3, signal);
  }
  // A PDF with no text layer is a scan; its pages read like photos.
  if (text === undefined && isPdf(file.name, file.type) && ocrEnabled()) {
    onPhase?.("reading scanned pages");
    text = await withDeadline(recognizePdf(file), ANALYSIS_DEADLINE_MS * 6, signal);
  }
  cancelled();
  // Opt-in semantic indexing: photos become findable by what is in them,
  // and videos by their poster frame, which the thumbnail step already
  // extracted; decoding the video a second time would be wasted work.
  let clip: Float32Array | undefined;
  let clips: Float32Array[] | undefined;
  if (semanticEnabled() && (file.type.startsWith("image/") || file.type.startsWith("video/"))) {
    onPhase?.("indexing by meaning");
  }
  if (semanticEnabled()) {
    if (file.type.startsWith("image/")) {
      clip = await withDeadline(embedImage(file), 45_000, signal);
    } else if (file.type.startsWith("video/") && thumbnail) {
      clip = await withDeadline(
        embedImage(
          new Blob([thumbnail.bytes.slice().buffer as ArrayBuffer], { type: "image/jpeg" }),
        ),
        45_000,
        signal,
      );
      // Several frames across the timeline: any scene in the video should
      // answer a meaning query, not only its opening moment.
      const frames = (await withDeadline(sampleVideoFrames(file), 60_000, signal)) ?? [];
      if (frames.length > 0) {
        const vectors: Float32Array[] = clip ? [clip] : [];
        for (const frame of frames) {
          if (signal?.aborted) {
            break;
          }
          const vector = await withDeadline(embedImage(frame), 45_000, signal);
          if (vector) {
            vectors.push(vector);
          }
        }
        if (vectors.length > 1) {
          clips = vectors;
          clip ??= vectors[0];
        }
      }
    }
  }
  cancelled();
  // Opt-in: dates and reference numbers read out of the document itself.
  // Scanning must never fail an upload, so a failure here is swallowed the
  // same way extraction's already is; the file stores without facts.
  let facts: Fact[] = [];
  let evidence: FactEvidence[] = [];
  if (factsEnabled()) {
    onPhase?.("reading dates");
    // Bytes worth scanning for a barcode: an image as it is; for a PDF, its
    // first page rendered at recognition width, because a printed pass's
    // code needs more resolution than the thumbnail carries.
    const barcodeSource = file.type.startsWith("image/")
      ? file
      : isPdf(file.name, file.type)
        ? await withDeadline(renderPdfPage(file), ANALYSIS_DEADLINE_MS, signal).catch(() => null)
        : null;
    // Saved confirmations carry schema.org reservation data in their markup,
    // which text extraction strips; the reader wants the document as written.
    const keepsMarkup =
      file.type === "text/html" ||
      file.type === "message/rfc822" ||
      /\.(?:html?|eml)$/i.test(file.name);
    const raw = keepsMarkup
      ? await withDeadline(file.text(), ANALYSIS_DEADLINE_MS, signal).catch(() => undefined)
      : undefined;
    const found = await withDeadline(
      scanForFacts({
        name: file.name,
        mime: file.type || "application/octet-stream",
        text,
        ...(raw !== undefined ? { raw } : {}),
        ...(barcodeSource ? { file: barcodeSource } : {}),
        storedAt: file.lastModified || Date.now(),
      }),
      ANALYSIS_DEADLINE_MS * 2,
      signal,
    ).catch(() => undefined);
    if (found) {
      facts = found.facts;
      evidence = found.evidence;
      // A decoded barcode is text the document carries that no character
      // recognizer could reach, so it joins what search looks through.
      if (found.decoded.length > 0) {
        text = [text ?? "", ...found.decoded].join("\n").trim();
      }
    }
  }
  cancelled();
  const analysis = categorize({
    name: file.name,
    mime: file.type || "application/octet-stream",
    mtime: file.lastModified,
    text,
    exif,
  });
  const meta: FileMetadata = {
    name: file.name,
    mime: file.type || "application/octet-stream",
    size: file.size,
    mtime: file.lastModified,
    category: analysis.category,
    tags: analysis.tags,
    ...(thumbnail ? { width: thumbnail.width, height: thumbnail.height } : {}),
    ...(thumbnail?.blur ? { blur: thumbnail.blur } : {}),
    ...(text !== undefined ? { hasText: true } : {}),
    ...(clip ? { hasClip: true } : {}),
    ...(facts.length > 0 ? { facts } : {}),
  };
  return { meta, analysis, thumbnail, text, clip, clips, evidence };
}

export interface UploadResult {
  dto: FileDto;
  fileKey: Uint8Array;
  meta: FileMetadata;
}

// Content larger than this (as ciphertext) travels in numbered parts, so no
// proxy body ceiling applies and a network blip costs one part, not the
// file. The single-request path holds the whole file and its ciphertext in
// memory at once, which phones cannot afford, so the threshold stays low
// and the streaming path does the heavy lifting.
const PART_THRESHOLD = 12 * 1024 * 1024;
const CHUNKS_PER_PART = 4;
// Transfer-tool practice: retry network failures, timeouts, throttles, and
// server-side errors; give up immediately on any other client error.
const PART_RETRYABLE = new Set([0, 408, 429, 500, 502, 503, 504]);
const PART_MAX_ATTEMPTS = 6;
const PART_BLOCK_COOLDOWN_MS = 60_000;
// Parts are sized to the measured link, aiming near this transfer time:
// long enough to amortize request overhead, short enough that a retry
// repeats little work and no edge body-timeout can fire mid-part.
const PART_TIME_TARGET_MS = 8_000;
// Two chunks stay above S3's minimum size for non-final multipart parts.
const MIN_CHUNKS_PER_PART = 2;
// A little concurrency hides per-request latency without the memory cost
// of a wide window; phones hold at most this many part bodies at once.
const PARTS_IN_FLIGHT = 2;

/** Full jitter keeps a fleet of retrying clients from re-arriving in step. */
export function retryDelay(attempt: number): number {
  return Math.random() * Math.min(15_000, 1_000 * 2 ** attempt);
}

/** Offline is a state to wait out, not an error to burn retry budget on. */
export function whenOnline(): Promise<void> {
  if (typeof navigator === "undefined" || navigator.onLine !== false) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const on = () => {
      window.removeEventListener("online", on);
      resolve();
    };
    window.addEventListener("online", on);
  });
}

async function sendPartWithRetry(
  fileId: string,
  session: string,
  partNo: number,
  payload: Uint8Array,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  let attempt = 0;
  let blockRetried = false;
  for (;;) {
    await whenOnline();
    if (signal?.aborted) {
      throw new ApiError(UPLOAD_CANCELLED, "upload cancelled");
    }
    try {
      // A part is only sent when the server holds as many bytes as it was
      // given; a short write must not count as a delivered part.
      const written = await uploadPart(fileId, session, partNo, payload, onProgress, signal);
      if (written !== null && written !== payload.length) {
        throw new Error(`part ${partNo} stored ${written} bytes of ${payload.length}`);
      }
      return;
    } catch (err) {
      if (!(err instanceof ApiError)) {
        throw err;
      }
      // Edge protections in front of a server sometimes reject a client
      // temporarily (address reputation, remediation windows). One patient
      // retry rescues a long upload; hammering would only entrench a block.
      if (err.status === 403 && !blockRetried) {
        blockRetried = true;
        await new Promise((resolve) => setTimeout(resolve, PART_BLOCK_COOLDOWN_MS));
        continue;
      }
      attempt++;
      if (!PART_RETRYABLE.has(err.status) || attempt >= PART_MAX_ATTEMPTS) {
        diag("upload", `part ${partNo} giving up after ${attempt} attempts (status ${err.status})`);
        throw err;
      }
      const wait = err.retryAfterMs ?? retryDelay(attempt);
      diag("upload", `part ${partNo} attempt ${attempt} got status ${err.status}; retrying in ${Math.round(wait)}ms`);
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

/**
 * Streams a large file through encryption and out in parts: at most one
 * part's ciphertext is in memory, and every request stays a bounded size.
 * The assembled server-side blob is byte-identical to a single-request
 * upload of the same file.
 */
function isMediaFile(file: File): boolean {
  return file.type.startsWith("video/") || file.type.startsWith("audio/");
}

/** Media uses the random-access chunked format so playback can seek. */
export function contentCiphertextSize(file: File): number {
  return isMediaFile(file) ? chunkedCiphertextSize(file.size) : streamCiphertextSize(file.size);
}

async function uploadInParts(
  file: File,
  fileId: string,
  fileKey: Uint8Array,
  onProgress: (fraction: number) => void,
  signal: AbortSignal | undefined,
  // Digested in the same pass that encrypts, so a file too large to hold at
  // once is never read twice.
  digester: Digester,
): Promise<number> {
  const total = contentCiphertextSize(file);
  const { session } = await beginPartUpload(fileId, total);
  try {
    const encryptor = isMediaFile(file)
      ? new ChunkedEncryptor(fileKey, file.size)
      : new StreamEncryptor(fileKey);
    const chunkCount = Math.max(1, Math.ceil(file.size / STREAM_CHUNK_SIZE));
    let pieces: Uint8Array[] = [encryptor.header];
    let pieceBytes = encryptor.header.length;
    let chunksInPart = 0;
    let chunksPerPart = CHUNKS_PER_PART;
    let partNo = 0;
    let settled = 0;
    // Encryption stays strictly sequential (the stream cipher demands it);
    // finished part bodies overlap on the network so latency does not
    // serialize with crypto. Parts land by number, so order is free.
    const inFlight = new Map<number, Promise<void>>();
    const partSent = new Map<number, number>();
    let uploadError: unknown = null;
    const report = () => {
      let moving = 0;
      for (const bytes of partSent.values()) {
        moving += bytes;
      }
      onProgress((settled + moving) / total);
    };
    const launch = (no: number, body: Uint8Array) => {
      const started = Date.now();
      const task = sendPartWithRetry(
        fileId,
        session,
        no,
        body,
        (fraction) => {
          partSent.set(no, fraction * body.length);
          report();
        },
        signal,
      )
        .then(() => {
          settled += body.length;
          // Size the next parts to the pace just measured: a slow or
          // retried part shrinks the window, a quick one restores it.
          const elapsed = Date.now() - started;
          const next =
            elapsed > PART_TIME_TARGET_MS * 2
              ? MIN_CHUNKS_PER_PART
              : elapsed < PART_TIME_TARGET_MS
                ? CHUNKS_PER_PART
                : chunksPerPart;
          if (next !== chunksPerPart) {
            diag("upload", `part pace ${Math.round(elapsed / 100) / 10}s; part size -> ${next} chunks`);
          }
          chunksPerPart = next;
        })
        .catch((err) => {
          uploadError ??= err;
        })
        .finally(() => {
          partSent.delete(no);
          inFlight.delete(no);
          report();
        });
      inFlight.set(no, task);
    };
    for (let i = 0; i < chunkCount; i++) {
      if (uploadError) {
        throw uploadError;
      }
      if (signal?.aborted) {
        throw new ApiError(UPLOAD_CANCELLED, "upload cancelled");
      }
      const start = i * STREAM_CHUNK_SIZE;
      const slice = file.slice(start, Math.min(start + STREAM_CHUNK_SIZE, file.size));
      const plainChunk = new Uint8Array(await slice.arrayBuffer());
      if (plainChunk.length !== slice.size) {
        throw new Error(`read ${plainChunk.length} bytes of a ${slice.size} byte slice`);
      }
      digester.update(plainChunk);
      const sealed =
        encryptor instanceof ChunkedEncryptor
          ? encryptor.seal(i, plainChunk)
          : encryptor.push(plainChunk, i === chunkCount - 1);
      pieces.push(sealed);
      pieceBytes += sealed.length;
      chunksInPart += 1;
      if (chunksInPart >= chunksPerPart || i === chunkCount - 1) {
        const body = new Uint8Array(pieceBytes);
        let offset = 0;
        for (const piece of pieces) {
          body.set(piece, offset);
          offset += piece.length;
        }
        pieces = [];
        pieceBytes = 0;
        chunksInPart = 0;
        partNo += 1;
        launch(partNo, body);
        while (inFlight.size >= PARTS_IN_FLIGHT) {
          await Promise.race(inFlight.values());
        }
      }
    }
    await Promise.all([...inFlight.values()]);
    if (uploadError) {
      throw uploadError;
    }
    await completePartUpload(fileId, session);
    return total;
  } catch (err) {
    // Free the server-side session; the error still surfaces in the tray.
    void abortPartUpload(fileId, session).catch(() => {});
    throw err;
  }
}

/** Encrypts a prepared file and uploads content plus thumbnail. */
export async function encryptAndUpload(
  file: File,
  folderId: string | null,
  masterKey: Uint8Array,
  prepared: PreparedFile,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<UploadResult> {
  const fileKey = generateKey();
  const encryptedMeta = encryptFileMetadata(prepared.meta, fileKey);
  const encryptedKey = secretBoxSeal(fileKey, masterKey);
  const dto = await api.createFile(folderId, encryptedKey, encryptedMeta);

  const totalCiphertext = contentCiphertextSize(file);
  let digest: string;
  try {
    if (totalCiphertext > PART_THRESHOLD) {
      const digester = createDigester();
      await uploadInParts(file, dto.id, fileKey, onProgress, signal, digester);
      digest = digester.final();
    } else {
      const plaintext = new Uint8Array(await file.arrayBuffer());
      // The size came from the operating system, the bytes came from reading
      // the file: two sources, so they can disagree, and when they do the
      // bytes are wrong. This is the check that exposed a watched folder
      // storing every file as a stringified array.
      if (plaintext.length !== file.size) {
        throw new Error(
          `read ${plaintext.length} bytes of a ${file.size} byte file; it was not uploaded`,
        );
      }
      digest = contentDigest(plaintext);
      const ciphertext = isMediaFile(file)
        ? chunkedEncrypt(plaintext, fileKey)
        : encryptBytes(plaintext, fileKey);
      const written = await uploadBlob(dto.id, "data", ciphertext, onProgress, signal);
      // An upload is not complete because it returned; it is complete when
      // what the server holds is the size of what was sent.
      if (written !== null && written !== ciphertext.length) {
        throw new Error(
          `upload stored ${written} bytes of ${ciphertext.length}; the file was not saved`,
        );
      }
    }
  } catch (err) {
    // A file whose content never landed must not linger as an empty row;
    // best-effort removal, since the error itself still needs surfacing.
    void api
      .trashFile(dto.id)
      .then(() => api.deleteForever(dto.id))
      .catch(() => {});
    throw err;
  }

  // Written after the content, not with the metadata that preceded it, so
  // the digest describes the bytes that actually landed.
  const withDigest = { ...prepared.meta, digest };
  const stamped = await api.patchFile(dto.id, {
    encryptedMeta: encryptFileMetadata(withDigest, fileKey),
  });

  if (prepared.thumbnail) {
    await uploadBlob(dto.id, "thumbnail", encryptBytes(prepared.thumbnail.bytes, fileKey), undefined, signal);
  }
  if (prepared.text !== undefined || prepared.clip) {
    // Search signals travel as their own encrypted blob, keeping sync rows
    // small: text and the semantic embedding share one envelope.
    await uploadBlob(
      dto.id,
      "index",
      encryptBytes(
        encodeIndexPayload({
          text: prepared.text,
          clip: prepared.clip,
          clips: prepared.clips,
          evidence: prepared.evidence,
        }),
        fileKey,
      ),
      undefined,
      signal,
    );
  }

  const uploadedDto: FileDto = {
    ...stamped,
    uploaded: true,
    size: totalCiphertext,
    thumbSize: prepared.thumbnail ? 1 : 0,
  };
  return { dto: uploadedDto, fileKey, meta: withDigest };
}

/**
 * A file's contents, checked against the digest taken when it was uploaded.
 *
 * A mismatch is reported rather than thrown: the bytes are handed back so a
 * reader can still rescue what is there, and the caller marks the file as
 * failing its check. Refusing outright would strand data behind a check that
 * could itself be wrong, which is the worse failure for a storage product.
 * Files stored before digests existed carry none and pass through unverified.
 */
export async function downloadAndDecrypt(
  fileId: string,
  fileKey: Uint8Array,
  expectedDigest?: string,
): Promise<Uint8Array> {
  const ciphertext = await api.downloadBlob(fileId, "data");
  const bytes = decryptContent(ciphertext, fileKey);
  if (!digestMatches(bytes, expectedDigest)) {
    diag(
      "integrity",
      `${fileId} does not match the digest recorded when it was uploaded ` +
        `(${bytes.length} bytes read)`,
    );
    throw new IntegrityError(bytes);
  }
  return bytes;
}

/**
 * Thrown when a file's contents disagree with the digest recorded at upload.
 * Carries the bytes so a caller can still offer them: something is better
 * than nothing when the alternative is an unreachable file.
 */
export class IntegrityError extends Error {
  readonly bytes: Uint8Array;
  constructor(bytes: Uint8Array) {
    super("this file does not match the digest recorded when it was uploaded");
    this.name = "IntegrityError";
    this.bytes = bytes;
  }
}

export async function downloadThumbnail(fileId: string, fileKey: Uint8Array): Promise<Uint8Array> {
  const ciphertext = await api.downloadBlob(fileId, "thumbnail");
  return decryptContent(ciphertext, fileKey);
}
