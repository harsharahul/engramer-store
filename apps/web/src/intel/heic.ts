/**
 * HEIC decoding for browsers without a native decoder.
 *
 * iPhones photograph in HEIC, and keeping the original bytes is the point of
 * the vault, so the format has to be viewable everywhere the vault is.
 * Safari and the iOS/macOS shells decode it natively and never reach this
 * module; Chrome and Firefox cannot, so thumbnailing and preview fall back
 * to this decoder when the platform refuses the bytes.
 *
 * The decoder (libheif compiled to WebAssembly, embedded in its own chunk)
 * is heavy, so it loads lazily on first use and only on the fallback path.
 * The document CSP already allows WebAssembly ('wasm-unsafe-eval', required
 * by OCR), and the bundle variant carries its module inline, so nothing new
 * is fetched at runtime.
 */

const HEIC_MIMES = new Set([
  "image/heic",
  "image/heif",
  "image/heic-sequence",
  "image/heif-sequence",
]);

/** Whether these bytes are worth offering to the HEIC decoder at all. */
export function isHeicLike(mime: string, name: string): boolean {
  if (HEIC_MIMES.has(mime.toLowerCase())) {
    return true;
  }
  const ext = name.split(".").pop()?.toLowerCase();
  return ext === "heic" || ext === "heif";
}

/**
 * Some platforms hand over a picked HEIC with an empty type, and everything
 * downstream (thumbnailing, analysis, the stored metadata) branches on the
 * mime. The name still knows what it is; a provided mime is never overridden.
 */
export function normalizeImageMime(mime: string, name: string): string {
  if (mime || !isHeicLike("", name)) {
    return mime;
  }
  return name.toLowerCase().endsWith(".heif") ? "image/heif" : "image/heic";
}

export interface DecodedImage {
  width: number;
  height: number;
  /** RGBA, row-major, width * height * 4 bytes. */
  data: Uint8ClampedArray<ArrayBuffer>;
}

let decoderPromise: Promise<typeof import("heic-decode")["default"]> | null = null;

function getDecoder() {
  decoderPromise ??= import("heic-decode").then((m) => m.default);
  return decoderPromise;
}

/** Decodes a HEIC/HEIF image to raw pixels. Throws on anything else. */
export async function decodeHeic(bytes: Uint8Array): Promise<DecodedImage> {
  const decode = await getDecoder();
  const { width, height, data } = await decode({ buffer: bytes });
  return { width, height, data: new Uint8ClampedArray(data) };
}

/**
 * A bitmap for these bytes, decoding HEIC ourselves where the platform
 * cannot. Anything that is not HEIC fails exactly as it did before.
 */
export async function decodeImageBitmap(blob: Blob, name = ""): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(blob);
  } catch (err) {
    if (!isHeicLike(blob.type, name)) {
      throw err;
    }
    const { width, height, data } = await decodeHeic(new Uint8Array(await blob.arrayBuffer()));
    return await createImageBitmap(new ImageData(data, width, height));
  }
}

/**
 * Bytes an <img> on this platform can actually show. HEIC passes through
 * untouched where the platform decodes it (Safari, the shells); elsewhere it
 * is re-encoded to PNG. Everything else returns as-is.
 */
export async function displayableImage(blob: Blob, name: string): Promise<Blob> {
  if (!isHeicLike(blob.type, name)) {
    return blob;
  }
  try {
    (await createImageBitmap(blob)).close();
    return blob;
  } catch {
    // The platform refused the bytes; ours is the only decoder left.
  }
  const { width, height, data } = await decodeHeic(new Uint8Array(await blob.arrayBuffer()));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return blob;
  }
  ctx.putImageData(new ImageData(data, width, height), 0, 0);
  const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  return png ?? blob;
}

/**
 * What the photo-library picker declares it accepts.
 *
 * Deliberately free of `image/*`: iOS reads a wildcard as permission to
 * hand over whatever format it likes and transcodes HEIC to JPEG at pick
 * time, before the page sees a single byte. Naming the types outright is
 * what gets the originals, so the list is enumerated rather than widened.
 * The general Upload input stays accept-less and takes any file at all.
 */
export const PHOTO_ACCEPT = [
  "image/heic",
  "image/heif",
  ".heic",
  ".heif",
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/tiff",
  "video/quicktime",
  "video/mp4",
  ".mov",
  ".mp4",
].join(",");
