import { describe, expect, it } from "vitest";
import {
  DOUBLE_TAP_SCALE,
  IDENTITY,
  MAX_SCALE,
  MIN_SCALE,
  clamp,
  doubleTap,
  pan,
  pinch,
  type Box,
} from "./zoom";

/**
 * The viewer scales the image element itself rather than the page, so this
 * arithmetic has to hold up on its own: given where two fingers were and
 * where they are now, or where a tap landed, produce the translate/scale
 * that keeps the touched part of the picture under the fingers instead of
 * sliding out from underneath them.
 */

const box: Box = { width: 200, height: 200 };

describe("identity", () => {
  it("is scale 1 with no translation", () => {
    expect(IDENTITY).toEqual({ scale: 1, x: 0, y: 0 });
  });

  it("round-trips through clamp, pan and pinch unchanged", () => {
    expect(clamp(IDENTITY, box)).toEqual(IDENTITY);
    expect(pan(IDENTITY, 0, 0, box)).toEqual(IDENTITY);
    const from: [{ x: number; y: number }, { x: number; y: number }] = [
      { x: 10, y: 10 },
      { x: 190, y: 10 },
    ];
    expect(pinch(IDENTITY, from, from, box)).toEqual(IDENTITY);
  });
});

describe("pinch", () => {
  it("about the box center doubles scale and leaves translation at zero", () => {
    const from: [{ x: number; y: number }, { x: number; y: number }] = [
      { x: 80, y: 100 },
      { x: 120, y: 100 },
    ];
    const to: [{ x: number; y: number }, { x: number; y: number }] = [
      { x: 60, y: 100 },
      { x: 140, y: 100 },
    ];
    expect(pinch(IDENTITY, from, to, box)).toEqual({ scale: 2, x: 0, y: 0 });
  });

  it("anchored off-center produces the translation that keeps the anchor fixed", () => {
    // Hand-computed: fingers at (40,100) and (120,100), 80px apart, midpoint
    // (80,100); they move to (60,100) and (180,100), 120px apart, midpoint
    // (120,100). Distance grew by 1.5x, so scale goes to 1.5. The content
    // point that sat under (80,100) at scale 1 is the point 20px left of the
    // 100,100 box center, i.e. (80,100) itself (identity has no offset).
    // Placing it under the new midpoint (120,100) at scale 1.5 requires
    // x = 120 - 100 - 1.5*(80-100) = 20 + 30 = 50.
    const from: [{ x: number; y: number }, { x: number; y: number }] = [
      { x: 40, y: 100 },
      { x: 120, y: 100 },
    ];
    const to: [{ x: number; y: number }, { x: number; y: number }] = [
      { x: 60, y: 100 },
      { x: 180, y: 100 },
    ];
    const next = pinch(IDENTITY, from, to, box);
    expect(next).toEqual({ scale: 1.5, x: 50, y: 0 });

    // Confirm the anchor claim directly: both touch points, mapped through
    // the resulting transform, land back on `to`.
    const c = box.width / 2;
    const screen = (p: { x: number; y: number }) => c + next.scale * (p.x - c) + next.x;
    expect(screen(from[0])).toBeCloseTo(to[0].x);
    expect(screen(from[1])).toBeCloseTo(to[1].x);
  });

  it("caps scale at the maximum", () => {
    const from: [{ x: number; y: number }, { x: number; y: number }] = [
      { x: 95, y: 100 },
      { x: 105, y: 100 },
    ];
    const to: [{ x: number; y: number }, { x: number; y: number }] = [
      { x: 0, y: 100 },
      { x: 200, y: 100 },
    ];
    expect(pinch(IDENTITY, from, to, box)).toEqual({ scale: MAX_SCALE, x: 0, y: 0 });
  });

  it("floors scale at the minimum and resets translation", () => {
    const from: [{ x: number; y: number }, { x: number; y: number }] = [
      { x: 0, y: 100 },
      { x: 200, y: 100 },
    ];
    const to: [{ x: number; y: number }, { x: number; y: number }] = [
      { x: 95, y: 100 },
      { x: 105, y: 100 },
    ];
    expect(pinch(IDENTITY, from, to, box)).toEqual(IDENTITY);
  });
});

describe("pan", () => {
  it("moves the translation by the drag delta while there is room", () => {
    const zoomed = { scale: 2, x: 0, y: 0 };
    expect(pan(zoomed, 10, -5, box)).toEqual({ scale: 2, x: 10, y: -5 });
  });

  it("clamps at the edges so no gap opens between the image and the box", () => {
    const zoomed = { scale: 2, x: 0, y: 0 };
    // At scale 2 in a 200x200 box, the image is 400x400: it can move at
    // most (400-200)/2 = 100px in either direction before an edge shows.
    expect(pan(zoomed, 500, 500, box)).toEqual({ scale: 2, x: 100, y: 100 });
    expect(pan(zoomed, -500, -500, box)).toEqual({ scale: 2, x: -100, y: -100 });
  });

  it("cannot move at all while at rest", () => {
    expect(pan(IDENTITY, 40, 40, box)).toEqual(IDENTITY);
  });
});

describe("doubleTap", () => {
  it("zooms in to the double-tap scale, anchored at the tap point", () => {
    // Tap at (150,100): identity has no offset, so the content point under
    // the tap is (150,100) itself. Placing it back under (150,100) at scale
    // 2.5 requires x = 150 - 100 - 2.5*(150-100) = 50 - 125 = -75.
    const next = doubleTap(IDENTITY, { x: 150, y: 100 }, box);
    expect(next).toEqual({ scale: DOUBLE_TAP_SCALE, x: -75, y: 0 });
  });

  it("toggles back to identity on a second double-tap", () => {
    const zoomedIn = doubleTap(IDENTITY, { x: 150, y: 100 }, box);
    expect(doubleTap(zoomedIn, { x: 10, y: 10 }, box)).toEqual(IDENTITY);
  });
});

describe("clamp", () => {
  it("keeps scale within [MIN_SCALE, MAX_SCALE]", () => {
    expect(clamp({ scale: 0.2, x: 0, y: 0 }, box).scale).toBe(MIN_SCALE);
    expect(clamp({ scale: 40, x: 0, y: 0 }, box).scale).toBe(MAX_SCALE);
  });

  it("always resets translation to 0,0 once scale is back to 1", () => {
    expect(clamp({ scale: 1, x: 50, y: -30 }, box)).toEqual(IDENTITY);
    expect(clamp({ scale: 0.4, x: 999, y: 999 }, box)).toEqual(IDENTITY);
  });

  it("limits translation so the image never leaves a gap at the box edge", () => {
    // scale 3 in a 200x200 box: max offset is (600-200)/2 = 200px.
    expect(clamp({ scale: 3, x: 500, y: -500 }, box)).toEqual({ scale: 3, x: 200, y: -200 });
  });
});
