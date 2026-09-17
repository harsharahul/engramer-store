import { describe, expect, it } from "vitest";
import {
  NO_EDITS,
  aspectCrop,
  clampCrop,
  isUntouched,
  nextTurn,
  outputMime,
  outputName,
  outputSize,
  turnedSize,
} from "./imageedit";

/**
 * The geometry behind the image editor, checked without a canvas: how a
 * turn changes the size, how a crop is kept inside the picture, which
 * type and name the saved picture gets.
 */
describe("image edit geometry", () => {
  it("swaps the sides on a quarter turn", () => {
    expect(turnedSize(400, 300, 90)).toEqual({ width: 300, height: 400 });
    expect(turnedSize(400, 300, 180)).toEqual({ width: 400, height: 300 });
    expect(nextTurn(270, 90)).toBe(0);
    expect(nextTurn(0, -90)).toBe(270);
  });

  it("keeps a crop inside the image and never empty", () => {
    expect(clampCrop({ x: -10, y: -10, width: 500, height: 500 }, 400, 300)).toEqual({
      x: 0,
      y: 0,
      width: 400,
      height: 300,
    });
    expect(clampCrop({ x: 390, y: 290, width: 0, height: 0 }, 400, 300)).toEqual({
      x: 390,
      y: 290,
      width: 1,
      height: 1,
    });
  });

  it("finds the largest centred crop of an aspect", () => {
    expect(aspectCrop(400, 300, 1)).toEqual({ x: 50, y: 0, width: 300, height: 300 });
    expect(aspectCrop(400, 300, 16 / 9)).toEqual({ x: 0, y: 38, width: 400, height: 225 });
  });

  it("sizes the output from the crop or the turned image", () => {
    expect(outputSize(400, 300, { ...NO_EDITS, turn: 90 })).toEqual({ width: 300, height: 400 });
    expect(outputSize(400, 300, { ...NO_EDITS, crop: { x: 0, y: 0, width: 120, height: 80 } })).toEqual({
      width: 120,
      height: 80,
    });
    expect(isUntouched(NO_EDITS)).toBe(true);
    expect(isUntouched({ ...NO_EDITS, flipH: true })).toBe(false);
  });

  it("saves PNG as PNG and everything else as JPEG, renaming HEIC", () => {
    expect(outputMime("image/png", "a.png")).toBe("image/png");
    expect(outputMime("image/heic", "IMG_1.HEIC")).toBe("image/jpeg");
    expect(outputName("IMG_1.HEIC", "image/jpeg")).toBe("IMG_1.jpg");
    expect(outputName("photo.jpeg", "image/jpeg")).toBe("photo.jpeg");
    expect(outputName("shot.png", "image/png")).toBe("shot.png");
    expect(outputName("noext", "image/jpeg")).toBe("noext.jpg");
  });
});
