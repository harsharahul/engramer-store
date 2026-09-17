/**
 * Image edits as data, applied in one pass on a canvas. Rotation, flips,
 * a crop and simple markup (boxes, arrows, text, blur) are described
 * here; the editor keeps the description and draws a preview from it,
 * and saving renders it once onto the original pixels. The geometry is
 * pure so it can be checked without a canvas.
 */

export type Turn = 0 | 90 | 180 | 270;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type Mark =
  | { kind: "box"; rect: Rect; color: string }
  | { kind: "arrow"; from: { x: number; y: number }; to: { x: number; y: number }; color: string }
  | { kind: "text"; at: { x: number; y: number }; text: string; color: string; size: number }
  | { kind: "blur"; rect: Rect };

export interface ImageEdits {
  turn: Turn;
  flipH: boolean;
  flipV: boolean;
  /** In the coordinates of the turned and flipped image; absent = whole. */
  crop: Rect | null;
  /** In the coordinates of the turned and flipped image. */
  marks: Mark[];
}

export const NO_EDITS: ImageEdits = { turn: 0, flipH: false, flipV: false, crop: null, marks: [] };

export function isUntouched(edits: ImageEdits): boolean {
  return edits.turn === 0 && !edits.flipH && !edits.flipV && edits.crop === null && edits.marks.length === 0;
}

/** The image's size after the turn. */
export function turnedSize(width: number, height: number, turn: Turn): { width: number; height: number } {
  return turn === 90 || turn === 270 ? { width: height, height: width } : { width, height };
}

export function nextTurn(turn: Turn, by: 90 | -90): Turn {
  return ((((turn + by) % 360) + 360) % 360) as Turn;
}

/** A crop kept inside the image and at least one pixel each way. */
export function clampCrop(rect: Rect, width: number, height: number): Rect {
  const x = Math.min(Math.max(0, Math.round(rect.x)), Math.max(0, width - 1));
  const y = Math.min(Math.max(0, Math.round(rect.y)), Math.max(0, height - 1));
  const w = Math.max(1, Math.min(Math.round(rect.width), width - x));
  const h = Math.max(1, Math.min(Math.round(rect.height), height - y));
  return { x, y, width: w, height: h };
}

/** The largest centred crop of the given aspect (width/height) that fits. */
export function aspectCrop(width: number, height: number, aspect: number): Rect {
  let w = width;
  let h = Math.round(w / aspect);
  if (h > height) {
    h = height;
    w = Math.round(h * aspect);
  }
  return { x: Math.round((width - w) / 2), y: Math.round((height - h) / 2), width: w, height: h };
}

/** The saved image's size: the crop if any, else the turned image. */
export function outputSize(width: number, height: number, edits: ImageEdits): { width: number; height: number } {
  const turned = turnedSize(width, height, edits.turn);
  return edits.crop ? { width: edits.crop.width, height: edits.crop.height } : turned;
}

/**
 * Draws the edited image onto a canvas the size of the output. Works
 * with any drawable source (an image element or bitmap) of the original
 * pixels. Blur regions pixelate through a small intermediate canvas.
 */
export function renderEdits(
  source: CanvasImageSource,
  width: number,
  height: number,
  edits: ImageEdits,
  canvas: HTMLCanvasElement,
): void {
  const turned = turnedSize(width, height, edits.turn);
  const stage = document.createElement("canvas");
  stage.width = turned.width;
  stage.height = turned.height;
  const sc = stage.getContext("2d");
  if (!sc) {
    throw new Error("no canvas");
  }
  sc.save();
  sc.translate(turned.width / 2, turned.height / 2);
  sc.rotate((edits.turn * Math.PI) / 180);
  sc.scale(edits.flipH ? -1 : 1, edits.flipV ? -1 : 1);
  sc.drawImage(source, -width / 2, -height / 2, width, height);
  sc.restore();

  for (const mark of edits.marks) {
    if (mark.kind === "blur") {
      const { x, y, width: w, height: h } = clampCrop(mark.rect, turned.width, turned.height);
      const small = document.createElement("canvas");
      const factor = Math.max(1, Math.round(Math.max(w, h) / 12));
      small.width = Math.max(1, Math.round(w / factor));
      small.height = Math.max(1, Math.round(h / factor));
      const smc = small.getContext("2d")!;
      smc.drawImage(stage, x, y, w, h, 0, 0, small.width, small.height);
      sc.imageSmoothingEnabled = false;
      sc.drawImage(small, 0, 0, small.width, small.height, x, y, w, h);
      sc.imageSmoothingEnabled = true;
      continue;
    }
    const line = Math.max(2, Math.round(Math.max(turned.width, turned.height) / 300));
    sc.lineWidth = line;
    sc.strokeStyle = mark.color;
    sc.fillStyle = mark.color;
    sc.lineCap = "round";
    sc.lineJoin = "round";
    if (mark.kind === "box") {
      const r = mark.rect;
      sc.strokeRect(r.x, r.y, r.width, r.height);
    } else if (mark.kind === "arrow") {
      const { from, to } = mark;
      sc.beginPath();
      sc.moveTo(from.x, from.y);
      sc.lineTo(to.x, to.y);
      sc.stroke();
      const angle = Math.atan2(to.y - from.y, to.x - from.x);
      const head = line * 5;
      sc.beginPath();
      sc.moveTo(to.x, to.y);
      sc.lineTo(to.x - head * Math.cos(angle - Math.PI / 6), to.y - head * Math.sin(angle - Math.PI / 6));
      sc.lineTo(to.x - head * Math.cos(angle + Math.PI / 6), to.y - head * Math.sin(angle + Math.PI / 6));
      sc.closePath();
      sc.fill();
    } else if (mark.kind === "text") {
      sc.font = `600 ${mark.size}px -apple-system, system-ui, sans-serif`;
      sc.textBaseline = "top";
      sc.fillText(mark.text, mark.at.x, mark.at.y);
    }
  }

  const out = outputSize(width, height, edits);
  canvas.width = out.width;
  canvas.height = out.height;
  const oc = canvas.getContext("2d");
  if (!oc) {
    throw new Error("no canvas");
  }
  if (edits.crop) {
    const c = clampCrop(edits.crop, turned.width, turned.height);
    oc.drawImage(stage, c.x, c.y, c.width, c.height, 0, 0, c.width, c.height);
  } else {
    oc.drawImage(stage, 0, 0);
  }
}

/** The type the edited image is saved as: PNG stays PNG, everything else JPEG. */
export function outputMime(originalMime: string, name: string): "image/png" | "image/jpeg" {
  return originalMime === "image/png" || /\.png$/i.test(name) ? "image/png" : "image/jpeg";
}

/** The saved name: the original, with a HEIC or other odd extension turned into the output's. */
export function outputName(name: string, mime: "image/png" | "image/jpeg"): string {
  const wanted = mime === "image/png" ? "png" : "jpg";
  const match = /\.([a-z0-9]+)$/i.exec(name);
  if (!match) {
    return `${name}.${wanted}`;
  }
  const ext = match[1]!.toLowerCase();
  const keep = mime === "image/jpeg" ? ["jpg", "jpeg"] : ["png"];
  return keep.includes(ext) ? name : `${name.slice(0, -ext.length - 1)}.${wanted}`;
}
