/**
 * Zooming into an image inside the viewer.
 *
 * The transform lives on the image element itself, not the page: the chrome
 * around the viewer, the top bar and its buttons, has to stay put while a
 * photo is being examined, and the browser's own page zoom would blow that
 * chrome up along with the picture. So this module knows nothing about the
 * DOM; it just turns "here is where the fingers were and are now" into a new
 * `translate(x, y) scale(scale)`, and the component wires touch, wheel and
 * keyboard input into it.
 *
 * Reading `translate(x, y) scale(scale)` as a matrix, a point at offset `d`
 * from the box's center lands at `center + scale*d + (x, y)`: the
 * translation is a flat pixel shift, unaffected by the scale factor. That is
 * what makes `pan` a plain addition and lets `clamp` compute a translation
 * limit straight from the box size.
 *
 * `Pt` values are always relative to the box's own top-left corner, in the
 * box's own untransformed pixel space (what the image measures at scale 1).
 * `Box` carries no position because it does not need one here: the caller
 * converts screen coordinates into this local frame before calling in,
 * which is what keeps these functions pure and checkable by hand.
 */

export interface Pt {
  x: number;
  y: number;
}

export interface Box {
  width: number;
  height: number;
}

export interface ZoomState {
  scale: number;
  x: number;
  y: number;
}

export const IDENTITY: ZoomState = { scale: 1, x: 0, y: 0 };
export const MIN_SCALE = 1;
export const MAX_SCALE = 6;
export const DOUBLE_TAP_SCALE = 2.5;

function mid(a: Pt, b: Pt): Pt {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function dist(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function boxCenter(box: Box): Pt {
  return { x: box.width / 2, y: box.height / 2 };
}

/**
 * The content point currently sitting under screen point `at`: undo the
 * current translation, then undo the current scale, both around the box's
 * center, to recover where that point falls at scale 1.
 */
function contentUnder(at: Pt, s: ZoomState, box: Box): Pt {
  const c = boxCenter(box);
  return {
    x: c.x + (at.x - c.x - s.x) / s.scale,
    y: c.y + (at.y - c.y - s.y) / s.scale,
  };
}

/** The state that puts `content` under screen point `at` at `scale`. */
function placeContentAt(content: Pt, scale: number, at: Pt, box: Box): ZoomState {
  const c = boxCenter(box);
  return {
    scale,
    x: at.x - c.x - scale * (content.x - c.x),
    y: at.y - c.y - scale * (content.y - c.y),
  };
}

/**
 * Zoom to `newScale` while keeping whatever content point is currently
 * under `at` still under `at` afterward. Shared by anything that zooms
 * without the anchor itself moving: double-tap, ctrl+wheel, the keyboard
 * shortcuts.
 */
export function zoomAt(s: ZoomState, newScale: number, at: Pt, box: Box): ZoomState {
  return clamp(placeContentAt(contentUnder(at, s, box), newScale, at, box), box);
}

/**
 * Two fingers moving from `from` to `to`. Scale changes by however much the
 * distance between the fingers changed; the anchor is the midpoint, so the
 * point of the image caught between the fingers stays caught between them
 * rather than sliding out from underneath as the picture grows or shrinks.
 */
export function pinch(s: ZoomState, from: [Pt, Pt], to: [Pt, Pt], box: Box): ZoomState {
  const spread = dist(from[0], from[1]);
  const ratio = spread > 0 ? dist(to[0], to[1]) / spread : 1;
  const content = contentUnder(mid(from[0], from[1]), s, box);
  return clamp(placeContentAt(content, s.scale * ratio, mid(to[0], to[1]), box), box);
}

/** A one-finger drag while zoomed in: the translation moves by the drag delta. */
export function pan(s: ZoomState, dx: number, dy: number, box: Box): ZoomState {
  return clamp({ scale: s.scale, x: s.x + dx, y: s.y + dy }, box);
}

/**
 * Two taps close together in time and place. At rest, zooms in to
 * `DOUBLE_TAP_SCALE`, anchored at the tap; already zoomed in, snaps back to
 * `IDENTITY` regardless of where the second tap landed, matching what a
 * double-tap means everywhere else: toggle, not "zoom in again".
 */
export function doubleTap(s: ZoomState, at: Pt, box: Box): ZoomState {
  const newScale = s.scale > MIN_SCALE ? MIN_SCALE : DOUBLE_TAP_SCALE;
  return zoomAt(s, newScale, at, box);
}

/**
 * Scale within [MIN_SCALE, MAX_SCALE]; translation limited so the scaled
 * image edge never pulls in from the box edge and leaves a gap. At scale 1
 * the image exactly fills the box, so the limit is 0 and translation resets
 * to the origin, which is also why zooming back out always recenters.
 */
export function clamp(s: ZoomState, box: Box): ZoomState {
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, s.scale));
  const maxX = (box.width * (scale - 1)) / 2;
  const maxY = (box.height * (scale - 1)) / 2;
  return {
    scale,
    // `|| 0` turns a -0 (Math.min/max can produce one right at the resting
    // clamp of 0) into +0, so an object comparison against IDENTITY holds.
    x: Math.min(maxX, Math.max(-maxX, s.x)) || 0,
    y: Math.min(maxY, Math.max(-maxY, s.y)) || 0,
  };
}
