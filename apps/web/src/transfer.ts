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
} from "@engramer/crypto";
import {
  api,
  abortPartUpload,
  ApiError,
  beginPartUpload,
  completePartUpload,
  uploadBlob,
  uploadPart,
  type FileDto,
} from "./api";
import { categorize, type Analysis } from "./intel/categorize";
import { extractExif, extractText, isPdf } from "./intel/extract";
import { ocrEnabled, recognizeImage, recognizePdf } from "./intel/ocr";
import { computeBlur } from "./intel/blur";

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

async function videoThumbnail(file: File): Promise<Thumbnail | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.muted = true;
    video.src = url;
    const cleanup = () => URL.revokeObjectURL(url);
    video.onloadeddata = () => {
      video.currentTime = Math.min(0.5, video.duration || 0);
    };
    video.onseeked = async () => {
      const { videoWidth, videoHeight } = video;
      const blob = await drawScaled(video, videoWidth, videoHeight);
      const blur = computeBlur(video, videoWidth, videoHeight);
      cleanup();
      if (!blob) {
        return resolve(null);
      }
      resolve({
        bytes: new Uint8Array(await blob.arrayBuffer()),
        width: videoWidth,
        height: videoHeight,
        blur,
      });
    };
    video.onerror = () => {
      cleanup();
      resolve(null);
    };
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
  /** Extracted search text; uploaded as a separate encrypted index blob. */
  text?: string;
}

/**
 * Client-side analysis phase: search text, EXIF, category, tags, thumbnail.
 * Everything computed here ships only inside encrypted metadata.
 */
export async function analyzeFile(file: File): Promise<PreparedFile> {
  let [text, exif, thumbnail] = await Promise.all([
    extractText(file),
    extractExif(file),
    makeThumbnail(file),
  ]);
  // Opt-in OCR: screenshots and scans become searchable, and the recognized
  // text sharpens categorization (a photographed invoice files as a receipt).
  if (text === undefined && file.type.startsWith("image/") && ocrEnabled()) {
    text = await recognizeImage(file).catch(() => undefined);
  }
  // A PDF with no text layer is a scan; its pages read like photos.
  if (text === undefined && isPdf(file.name, file.type) && ocrEnabled()) {
    text = await recognizePdf(file).catch(() => undefined);
  }
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
  };
  return { meta, analysis, thumbnail, text };
}

export interface UploadResult {
  dto: FileDto;
  fileKey: Uint8Array;
  meta: FileMetadata;
}

// Content larger than this (as ciphertext) travels in numbered parts, so no
// proxy body ceiling applies and a network blip costs one part, not the
// file. Eight stream chunks per part keeps every request near 32 MiB.
const PART_THRESHOLD = 64 * 1024 * 1024;
const CHUNKS_PER_PART = 8;
const PART_RETRYABLE = new Set([0, 429, 503]);
const PART_MAX_ATTEMPTS = 5;

async function sendPartWithRetry(
  fileId: string,
  session: string,
  partNo: number,
  payload: Uint8Array,
  onProgress: (fraction: number) => void,
): Promise<void> {
  let attempt = 0;
  for (;;) {
    try {
      return await uploadPart(fileId, session, partNo, payload, onProgress);
    } catch (err) {
      attempt++;
      if (!(err instanceof ApiError) || !PART_RETRYABLE.has(err.status) || attempt >= PART_MAX_ATTEMPTS) {
        throw err;
      }
      const wait = err.retryAfterMs ?? Math.min(15_000, 500 * 2 ** attempt);
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
    let sent = 0;
    let partNo = 0;
    for (let i = 0; i < chunkCount; i++) {
      const start = i * STREAM_CHUNK_SIZE;
      const slice = file.slice(start, Math.min(start + STREAM_CHUNK_SIZE, file.size));
      const plainChunk = new Uint8Array(await slice.arrayBuffer());
      const sealed =
        encryptor instanceof ChunkedEncryptor
          ? encryptor.seal(i, plainChunk)
          : encryptor.push(plainChunk, i === chunkCount - 1);
      pieces.push(sealed);
      pieceBytes += sealed.length;
      if ((i + 1) % CHUNKS_PER_PART === 0 || i === chunkCount - 1) {
        const body = new Uint8Array(pieceBytes);
        let offset = 0;
        for (const piece of pieces) {
          body.set(piece, offset);
          offset += piece.length;
        }
        pieces = [];
        pieceBytes = 0;
        partNo += 1;
        const base = sent;
        await sendPartWithRetry(fileId, session, partNo, body, (fraction) =>
          onProgress((base + fraction * body.length) / total),
        );
        sent += body.length;
      }
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
): Promise<UploadResult> {
  const fileKey = generateKey();
  const encryptedMeta = encryptFileMetadata(prepared.meta, fileKey);
  const encryptedKey = secretBoxSeal(fileKey, masterKey);
  const dto = await api.createFile(folderId, encryptedKey, encryptedMeta);

  const totalCiphertext = contentCiphertextSize(file);
  if (totalCiphertext > PART_THRESHOLD) {
    await uploadInParts(file, dto.id, fileKey, onProgress);
  } else {
    const plaintext = new Uint8Array(await file.arrayBuffer());
    const ciphertext = isMediaFile(file)
      ? chunkedEncrypt(plaintext, fileKey)
      : encryptBytes(plaintext, fileKey);
    await uploadBlob(dto.id, "data", ciphertext, onProgress);
  }

  if (prepared.thumbnail) {
    await uploadBlob(dto.id, "thumbnail", encryptBytes(prepared.thumbnail.bytes, fileKey));
  }
  if (prepared.text !== undefined) {
    // Search text travels as its own encrypted blob, keeping sync rows small.
    await uploadBlob(dto.id, "index", encryptBytes(utf8Encode(prepared.text), fileKey));
  }

  const uploadedDto: FileDto = {
    ...dto,
    uploaded: true,
    size: totalCiphertext,
    thumbSize: prepared.thumbnail ? 1 : 0,
  };
  return { dto: uploadedDto, fileKey, meta: prepared.meta };
}

export async function downloadAndDecrypt(fileId: string, fileKey: Uint8Array): Promise<Uint8Array> {
  const ciphertext = await api.downloadBlob(fileId, "data");
  return decryptContent(ciphertext, fileKey);
}

export async function downloadThumbnail(fileId: string, fileKey: Uint8Array): Promise<Uint8Array> {
  const ciphertext = await api.downloadBlob(fileId, "thumbnail");
  return decryptContent(ciphertext, fileKey);
}
