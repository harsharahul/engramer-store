/**
 * ThumbHash placeholders: ~25 bytes inside the encrypted metadata that paint
 * a blurred stand-in the instant the grid renders, before any thumbnail
 * request happens. Computed at upload from the same source as the thumbnail.
 */
import { rgbaToThumbHash, thumbHashToDataURL } from "thumbhash";
import { fromB64, toB64 } from "@engramer/crypto";

const MAX_EDGE = 64; // thumbhash requires <=100px on each side

/** Computes a base64 ThumbHash from any drawable source. */
export function computeBlur(
  source: CanvasImageSource,
  width: number,
  height: number,
): string | undefined {
  try {
    const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return undefined;
    }
    ctx.drawImage(source, 0, 0, w, h);
    const rgba = ctx.getImageData(0, 0, w, h).data;
    return toB64(rgbaToThumbHash(w, h, rgba));
  } catch {
    return undefined;
  }
}

const urlCache = new Map<string, string>();

/** Renders a stored ThumbHash to a data URL, memoized per hash. */
export function blurUrl(blur: string): string | null {
  const cached = urlCache.get(blur);
  if (cached) {
    return cached;
  }
  try {
    const url = thumbHashToDataURL(fromB64(blur));
    urlCache.set(blur, url);
    return url;
  } catch {
    return null;
  }
}
