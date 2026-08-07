import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PHOTO_ACCEPT, decodeHeic, isHeicLike, normalizeImageMime } from "./heic";

const fixture = () =>
  new Uint8Array(readFileSync(new URL("./fixtures/tiny.heic", import.meta.url)));

describe("isHeicLike", () => {
  it("recognises the heic and heif mime types", () => {
    expect(isHeicLike("image/heic", "photo.bin")).toBe(true);
    expect(isHeicLike("image/heif", "photo.bin")).toBe(true);
    expect(isHeicLike("image/heic-sequence", "photo.bin")).toBe(true);
  });

  it("recognises the extensions when the mime is generic or empty", () => {
    expect(isHeicLike("", "IMG_0001.HEIC")).toBe(true);
    expect(isHeicLike("application/octet-stream", "shot.heif")).toBe(true);
  });

  it("leaves ordinary images alone", () => {
    expect(isHeicLike("image/jpeg", "photo.jpg")).toBe(false);
    expect(isHeicLike("image/png", "diagram.png")).toBe(false);
    expect(isHeicLike("", "notes.txt")).toBe(false);
  });
});

describe("normalizeImageMime", () => {
  it("fills in the heic mime when the picker left the type empty", () => {
    expect(normalizeImageMime("", "IMG_0001.HEIC")).toBe("image/heic");
    expect(normalizeImageMime("", "shot.heif")).toBe("image/heif");
  });

  it("never overrides a mime the platform did provide", () => {
    expect(normalizeImageMime("image/heic", "IMG_0001.HEIC")).toBe("image/heic");
    expect(normalizeImageMime("image/jpeg", "photo.jpg")).toBe("image/jpeg");
  });

  it("leaves non-heic files untouched", () => {
    expect(normalizeImageMime("", "notes.txt")).toBe("");
  });
});

describe("decodeHeic", () => {
  it("decodes a heic image to its RGBA pixels", async () => {
    const decoded = await decodeHeic(fixture());
    expect(decoded.width).toBe(8);
    expect(decoded.height).toBe(8);
    expect(decoded.data.length).toBe(8 * 8 * 4);
    // The fixture is a solid red square; HEVC is lossy, so ask only for
    // clearly-red, not exact values.
    expect(decoded.data[0]).toBeGreaterThan(200); // R
    expect(decoded.data[1]).toBeLessThan(60); // G
    expect(decoded.data[2]).toBeLessThan(60); // B
    expect(decoded.data[3]).toBe(255); // A
  });

  it("rejects bytes that are not a heic image", async () => {
    await expect(decodeHeic(new Uint8Array([1, 2, 3, 4]))).rejects.toThrow();
  });
});

/**
 * Measured on real iOS WebKit (iPhone 16 Pro simulator, a HEIC in the photo
 * library, six accept strings side by side): EVERY one of them came back as
 * JPEG, including `image/heic,image/heif` alone and `.heic,.heif` alone.
 * The accept attribute does not decide the format. iOS transcodes on the
 * photo-library path through a file input, and the page never sees the
 * original bytes. So this list exists only to say what the picker should
 * OFFER, and narrowing it buys nothing while costing formats.
 */
describe("what the photo picker declares it accepts", () => {
  it("offers images and videos without narrowing the formats a library holds", () => {
    expect(PHOTO_ACCEPT).toContain("image/*");
    expect(PHOTO_ACCEPT).toContain("video/*");
  });

  it("still names heic, so a device that DOES hand over the original is not refused", () => {
    // Files-app picks and non-Apple browsers can deliver real HEIC; the
    // decode fallback handles those, and the picker must not filter them out.
    expect(PHOTO_ACCEPT).toContain("image/heic");
    expect(PHOTO_ACCEPT).toContain(".heic");
  });
});
