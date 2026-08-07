/**
 * How much per-file analysis may run at once.
 *
 * Reading a photo is the most expensive thing this app does: text
 * recognition, a full-resolution barcode decode, meaning embedding and
 * thumbnailing each hold a decoded bitmap, and a modern phone photo
 * decodes to tens of megabytes. Uploading several at once used to run all
 * of that in parallel, which exhausted the memory of an iPhone and had iOS
 * kill the app mid-upload — reported from a real device, every time, on
 * four photos.
 *
 * So the transfers stay overlapped, because that is where the waiting is,
 * and the reading is serialized on the devices that cannot afford it. A
 * phone analyses one photo at a time while another file is already on the
 * wire; a desktop does two.
 */

/** Roughly: a phone or tablet, where memory is tight and the OS is strict. */
export function isHandheld(): boolean {
  if (typeof navigator === "undefined" || typeof window === "undefined") {
    return false;
  }
  const coarse = window.matchMedia?.("(pointer: coarse)").matches === true;
  const touch = navigator.maxTouchPoints > 0;
  return coarse && touch;
}

/** Files whose transfers may overlap. */
export function uploadLanes(): number {
  return isHandheld() ? 2 : 4;
}

/** Files that may be READ at once; the memory-hungry half. */
export function analysisLanes(): number {
  return isHandheld() ? 1 : 2;
}

let active = 0;
const waiting: Array<() => void> = [];

/**
 * Runs `work` with an analysis slot held, so no more than `analysisLanes()`
 * files are being read at any moment. Always releases, including on
 * failure, or one bad file would wedge every later upload.
 */
export async function withAnalysisSlot<T>(work: () => Promise<T>): Promise<T> {
  const limit = analysisLanes();
  if (active >= limit) {
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  active += 1;
  try {
    return await work();
  } finally {
    active -= 1;
    waiting.shift()?.();
  }
}
