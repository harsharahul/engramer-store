import {
  encryptBytes,
  utf8Encode,
  decryptBytes,
  encryptFileMetadata,
  generateKey,
  secretBoxSeal,
  type FileMetadata,
} from "@engramer/crypto";
import { api, uploadBlob, type FileDto } from "./api";
import { categorize, type Analysis } from "./intel/categorize";
import { extractExif, extractText } from "./intel/extract";
import { ocrEnabled, recognizeImage } from "./intel/ocr";
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

  const plaintext = new Uint8Array(await file.arrayBuffer());
  const ciphertext = encryptBytes(plaintext, fileKey);
  await uploadBlob(dto.id, "data", ciphertext, onProgress);

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
    size: ciphertext.length,
    thumbSize: prepared.thumbnail ? 1 : 0,
  };
  return { dto: uploadedDto, fileKey, meta: prepared.meta };
}

export async function downloadAndDecrypt(fileId: string, fileKey: Uint8Array): Promise<Uint8Array> {
  const ciphertext = await api.downloadBlob(fileId, "data");
  return decryptBytes(ciphertext, fileKey);
}

export async function downloadThumbnail(fileId: string, fileKey: Uint8Array): Promise<Uint8Array> {
  const ciphertext = await api.downloadBlob(fileId, "thumbnail");
  return decryptBytes(ciphertext, fileKey);
}
