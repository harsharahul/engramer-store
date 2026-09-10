import { useEffect, useRef, useState, type RefObject } from "react";

/**
 * Rubber-band selection: drag on empty space, everything the rectangle
 * touches is selected. The arithmetic lives in pure functions so the hook
 * below is only wiring, and the rules are the Mac's: the band starts only
 * from empty space (a card is for dragging), ⇧ or ⌘ at the start keeps
 * what was already selected, and the view scrolls itself when the pointer
 * reaches an edge so a band can run past one screen.
 */

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Point {
  x: number;
  y: number;
}

/** Movement below this is a click, not a band. */
export const MARQUEE_THRESHOLD_PX = 4;
/** Within this distance of the top or bottom edge the view scrolls. */
export const AUTOSCROLL_EDGE_PX = 28;
const AUTOSCROLL_MAX_STEP = 22;

export function rectFromPoints(a: Point, b: Point): Rect {
  return {
    left: Math.min(a.x, b.x),
    top: Math.min(a.y, b.y),
    right: Math.max(a.x, b.x),
    bottom: Math.max(a.y, b.y),
  };
}

function intersects(a: Rect, b: Rect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

/** Ids of the cards the rectangle overlaps, in the cards' own order. */
export function hitsInRect(cards: ReadonlyArray<{ id: string; rect: Rect }>, band: Rect): string[] {
  return cards.filter((card) => intersects(card.rect, band)).map((card) => card.id);
}

export function marqueeSelection(
  base: ReadonlySet<string>,
  hits: readonly string[],
  extend: boolean,
): Set<string> {
  return extend ? new Set([...base, ...hits]) : new Set(hits);
}

/**
 * How far to scroll this frame for a pointer at `y` in a viewport spanning
 * `top`..`bottom`: nothing in the middle, faster toward and past an edge.
 */
export function autoScrollStep(
  y: number,
  top: number,
  bottom: number,
  edge = AUTOSCROLL_EDGE_PX,
  maxStep = AUTOSCROLL_MAX_STEP,
): number {
  if (y < top + edge) {
    const depth = Math.min(edge, top + edge - y);
    return -Math.ceil((depth / edge) * maxStep);
  }
  if (y > bottom - edge) {
    const depth = Math.min(edge, y - (bottom - edge));
    return Math.ceil((depth / edge) * maxStep);
  }
  return 0;
}

/** Elements a band must never start from: they have their own pointer job. */
const INTERACTIVE = "[data-file-id], .card, button, input, textarea, select, a, [contenteditable], .bulk-bar";

/** Whether a click landed on nothing in particular: the cue to clear. */
export function isEmptySpace(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(INTERACTIVE) === null;
}

export interface MarqueeBand {
  /** In the scroll container's content coordinates. */
  rect: Rect;
}

/**
 * Wires the band onto a scroll container. Cards announce themselves with a
 * `data-file-id` attribute; nothing else is needed from them. `onChange`
 * receives the ids under the band as it moves. The click the browser
 * synthesizes when a band ends is swallowed, so the container's own
 * empty-space click (which clears) never undoes a band just drawn.
 */
export function useMarquee(
  container: RefObject<HTMLElement | null>,
  handlers: {
    onChange: (ids: string[], extend: boolean) => void;
  },
): MarqueeBand | null {
  const [band, setBand] = useState<MarqueeBand | null>(null);
  const latest = useRef(handlers);
  latest.current = handlers;

  useEffect(() => {
    const element = container.current;
    if (!element) {
      return;
    }
    let origin: Point | null = null;
    let current: Point | null = null;
    let extend = false;
    let active = false;
    let frame: number | null = null;
    let swallowClick = false;

    const toContent = (event: PointerEvent): Point => {
      const box = element.getBoundingClientRect();
      return {
        x: event.clientX - box.left + element.scrollLeft,
        y: event.clientY - box.top + element.scrollTop,
      };
    };

    const cardsNow = () => {
      const box = element.getBoundingClientRect();
      const cards: Array<{ id: string; rect: Rect }> = [];
      for (const node of element.querySelectorAll<HTMLElement>("[data-file-id]")) {
        const id = node.dataset.fileId;
        if (!id) {
          continue;
        }
        const r = node.getBoundingClientRect();
        cards.push({
          id,
          rect: {
            left: r.left - box.left + element.scrollLeft,
            top: r.top - box.top + element.scrollTop,
            right: r.right - box.left + element.scrollLeft,
            bottom: r.bottom - box.top + element.scrollTop,
          },
        });
      }
      return cards;
    };

    let lastClientY = 0;
    const tick = () => {
      frame = null;
      if (!origin || !current) {
        return;
      }
      const box = element.getBoundingClientRect();
      const step = autoScrollStep(lastClientY, box.top, box.bottom);
      if (step !== 0) {
        const before = element.scrollTop;
        element.scrollTop = before + step;
        // The pointer stays put on screen while the content moves under it.
        current = { x: current.x, y: current.y + (element.scrollTop - before) };
      }
      const rect = rectFromPoints(origin, current);
      setBand({ rect });
      latest.current.onChange(hitsInRect(cardsNow(), rect), extend);
      if (step !== 0) {
        frame = requestAnimationFrame(tick);
      }
    };

    const onDown = (event: PointerEvent) => {
      if (event.button !== 0 || (event.pointerType !== "mouse" && event.pointerType !== "pen")) {
        return;
      }
      const target = event.target as HTMLElement | null;
      if (!target || target.closest(INTERACTIVE)) {
        return;
      }
      origin = toContent(event);
      current = origin;
      extend = event.shiftKey || event.metaKey || event.ctrlKey;
      active = false;
      lastClientY = event.clientY;
      element.setPointerCapture(event.pointerId);
    };

    const onMove = (event: PointerEvent) => {
      if (!origin) {
        return;
      }
      current = toContent(event);
      lastClientY = event.clientY;
      if (!active) {
        if (
          Math.abs(current.x - origin.x) < MARQUEE_THRESHOLD_PX &&
          Math.abs(current.y - origin.y) < MARQUEE_THRESHOLD_PX
        ) {
          return;
        }
        active = true;
        element.classList.add("marquee-active");
      }
      if (frame === null) {
        frame = requestAnimationFrame(tick);
      }
    };

    const finish = (event: PointerEvent) => {
      if (!origin) {
        return;
      }
      if (element.hasPointerCapture(event.pointerId)) {
        element.releasePointerCapture(event.pointerId);
      }
      if (frame !== null) {
        cancelAnimationFrame(frame);
        frame = null;
      }
      swallowClick = active;
      origin = null;
      current = null;
      active = false;
      element.classList.remove("marquee-active");
      setBand(null);
    };

    const onClick = (event: MouseEvent) => {
      if (swallowClick) {
        swallowClick = false;
        event.stopPropagation();
        event.preventDefault();
      }
    };

    element.addEventListener("pointerdown", onDown);
    element.addEventListener("pointermove", onMove);
    element.addEventListener("pointerup", finish);
    element.addEventListener("pointercancel", finish);
    element.addEventListener("click", onClick, true);
    return () => {
      element.removeEventListener("pointerdown", onDown);
      element.removeEventListener("pointermove", onMove);
      element.removeEventListener("pointerup", finish);
      element.removeEventListener("pointercancel", finish);
      element.removeEventListener("click", onClick, true);
      if (frame !== null) {
        cancelAnimationFrame(frame);
      }
    };
  }, [container]);

  return band;
}
