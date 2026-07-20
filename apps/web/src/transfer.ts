import {
  encryptBytes,
  decryptBytes,
  encryptFileMetadata,
  generateKey,
  secretBoxSeal,
  type FileMetadata,
} from "@engramer/crypto";
import { api, uploadBlob, type FileDto } from "./api";

const TEXT_EXTRACT_LIMIT = 512 * 1024;
const TEXT_STORE_LIMIT = 100_000;
const THUMB_SIZE = 512;

const TEXTUAL_EXTENSIONS =
  /\.(txt|md|markdown|json|yaml|yml|toml|csv|log|ts|tsx|js|jsx|py|go|rs|java|c|h|cpp|rb|sh|css|html|xml|sql)$/i;

function isTextual(file: File): boolean {
  return file.type.startsWith("text/") || TEXTUAL_EXTENSIONS.test(file.name);
}

async function extractText(file: File): Promise<string | undefined> {
  if (!isTextual(file) || file.size > TEXT_EXTRACT_LIMIT) {
    return undefined;
  }
  try {
    const text = await file.text();
    return text.slice(0, TEXT_STORE_LIMIT);
  } catch {
    return undefined;
  }
}

interface Thumbnail {
  bytes: Uint8Array;
  width: number;
  height: number;
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
    bitmap.close();
    if (!blob) {
      return null;
    }
    return { bytes: new Uint8Array(await blob.arrayBuffer()), width, height };
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
      cleanup();
      if (!blob) {
        return resolve(null);
      }
      resolve({
        bytes: new Uint8Array(await blob.arrayBuffer()),
        width: videoWidth,
        height: videoHeight,
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

export interface UploadResult {
  dto: FileDto;
  fileKey: Uint8Array;
  meta: FileMetadata;
}

/**
 * The full client-side upload pipeline: fresh file key, thumbnail and search
 * text extraction, metadata and content encryption, then upload. Nothing
 * derived from the plaintext ever leaves this function unencrypted.
 */
export async function encryptAndUpload(
  file: File,
  folderId: string | null,
  masterKey: Uint8Array,
  onProgress: (fraction: number) => void,
): Promise<UploadResult> {
  const fileKey = generateKey();
  const [text, thumbnail] = await Promise.all([extractText(file), makeThumbnail(file)]);

  const meta: FileMetadata = {
    name: file.name,
    mime: file.type || "application/octet-stream",
    size: file.size,
    mtime: file.lastModified,
    ...(thumbnail ? { width: thumbnail.width, height: thumbnail.height } : {}),
    ...(text !== undefined ? { text } : {}),
  };

  const encryptedMeta = encryptFileMetadata(meta, fileKey);
  const encryptedKey = secretBoxSeal(fileKey, masterKey);
  const dto = await api.createFile(folderId, encryptedKey, encryptedMeta);

  const plaintext = new Uint8Array(await file.arrayBuffer());
  const ciphertext = encryptBytes(plaintext, fileKey);
  await uploadBlob(dto.id, "data", ciphertext, onProgress);

  if (thumbnail) {
    await uploadBlob(dto.id, "thumbnail", encryptBytes(thumbnail.bytes, fileKey));
  }

  const uploadedDto: FileDto = {
    ...dto,
    uploaded: true,
    size: ciphertext.length,
    thumbSize: thumbnail ? 1 : 0,
  };
  return { dto: uploadedDto, fileKey, meta };
}

export async function downloadAndDecrypt(fileId: string, fileKey: Uint8Array): Promise<Uint8Array> {
  const ciphertext = await api.downloadBlob(fileId, "data");
  return decryptBytes(ciphertext, fileKey);
}

export async function downloadThumbnail(fileId: string, fileKey: Uint8Array): Promise<Uint8Array> {
  const ciphertext = await api.downloadBlob(fileId, "thumbnail");
  return decryptBytes(ciphertext, fileKey);
}
