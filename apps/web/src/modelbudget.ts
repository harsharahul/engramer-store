/**
 * How many readings the on-device model may start per app open.
 *
 * A phone that opens onto a large import would otherwise spend the whole
 * open, and its battery, reading mail with the model. Each open, and each
 * return to the front after the app was hidden, gets a fixed number; every
 * pass on the phone takes from it, whatever started the pass. A desktop has
 * no such limit; its passes are finite all the same.
 */

import { isHandheld } from "./analysisslot";

/** Model readings a phone starts per app open; the rest wait for the next. */
export const HANDHELD_MODEL_READS_PER_OPEN = 40;

let spent = 0;
let watching = false;

export function remainingModelReads(): number {
  ensureWatching();
  return isHandheld() ? Math.max(0, HANDHELD_MODEL_READS_PER_OPEN - spent) : Number.POSITIVE_INFINITY;
}

export function spendModelReads(count: number): void {
  spent += count;
}

/** A new open: the budget starts again. */
export function startOfOpen(): void {
  spent = 0;
}

interface Page extends EventTarget {
  visibilityState: string;
}

/** Counts a return to the front after the app was hidden as a new open. */
export function watchAppOpens(page: Page): void {
  let hidden = false;
  page.addEventListener("visibilitychange", () => {
    if (page.visibilityState === "hidden") {
      hidden = true;
    } else if (hidden) {
      hidden = false;
      startOfOpen();
    }
  });
}

function ensureWatching(): void {
  if (!watching && typeof document !== "undefined") {
    watching = true;
    watchAppOpens(document);
  }
}
