import { describe, expect, it } from "vitest";
import { fileBytes, mimeFromName } from "./native";

/**
 * Files from the shell's picker arrive as bytes and a name, with no type:
 * it hands over paths, not browser `File`s. Downstream everything branches
 * on the mime, so the name has to supply it. HEIC is recovered later by
 * normalizeImageMime, but nothing recovers a video, and a typeless .mov
 * would upload as an unplayable blob.
 */
describe("mimeFromName", () => {
  it("names the formats an iPhone library actually holds", () => {
    expect(mimeFromName("IMG_0001.HEIC")).toBe("image/heic");
    expect(mimeFromName("IMG_0002.jpg")).toBe("image/jpeg");
    expect(mimeFromName("IMG_0003.PNG")).toBe("image/png");
    expect(mimeFromName("IMG_0004.mov")).toBe("video/quicktime");
    expect(mimeFromName("IMG_0005.mp4")).toBe("video/mp4");
  });

  it("says nothing rather than guessing wrong", () => {
    // An empty type is honest and recoverable; a wrong one is neither.
    expect(mimeFromName("notes")).toBe("");
    expect(mimeFromName("archive.zzz")).toBe("");
  });
});

/**
 * The shell boundary carries no types: values arrive as JSON from another
 * process, and the old code asserted an ArrayBuffer rather than converting
 * to one. What actually arrives is an array of byte values, and
 * `new Blob([array])` does not complain, it stringifies. Every file a
 * watched folder uploaded became the text "37,80,68,70,..." at three and a
 * half times its size, and nothing noticed for months.
 */
describe("fileBytes", () => {
  const pdf = [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34];

  it("converts the array of byte values the shell actually sends", () => {
    const bytes = fileBytes(pdf);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect([...bytes]).toEqual(pdf);
  });

  it("keeps the bytes a file would be built from identical", () => {
    // The failure was silent because a Blob accepts both and only one is
    // the file: the array stringifies, the bytes do not.
    const asBytes = fileBytes(pdf);
    expect(new Blob([asBytes.slice().buffer as ArrayBuffer]).size).toBe(pdf.length);
    expect(new Blob([pdf as unknown as BlobPart]).size).toBeGreaterThan(pdf.length);
  });

  it("passes through what is already binary", () => {
    const view = new Uint8Array(pdf);
    expect(fileBytes(view)).toBe(view);
    expect([...fileBytes(view.buffer)]).toEqual(pdf);
  });

  it("refuses anything that is not file content", () => {
    expect(() => fileBytes(null)).toThrow();
    expect(() => fileBytes("not bytes")).toThrow();
    expect(() => fileBytes({ nope: true })).toThrow();
  });
});
