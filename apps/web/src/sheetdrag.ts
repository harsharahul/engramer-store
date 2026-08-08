import { useRef, useState } from "react";

/**
 * Drag-to-dismiss for bottom sheets, the way a hand actually uses one: a
 * decisive flick dismisses from anywhere, a slow drag has to cross half the
 * sheet before letting go means "close", and anything short of either
 * springs back. One shared reading of the gesture, so every sheet in the
 * app feels like the same object.
 */

/** A flick this fast (px/ms) dismisses regardless of distance dragged. */
export const FLICK_VELOCITY = 0.7;
/** A flick still needs a little travel, or a tap could read as one. */
export const FLICK_MIN_PX = 24;

export function shouldDismiss(offset: number, velocity: number, height: number): boolean {
  if (offset <= 0) {
    return false;
  }
  if (velocity >= FLICK_VELOCITY && offset >= FLICK_MIN_PX) {
    return true;
  }
  return height > 0 && offset >= height / 2;
}

/**
 * Touch handlers plus the transform they produce. Spread `handleProps` on
 * the sheet element (or just its grip area), give the same element
 * `style={sheetStyle}`, and pass the sheet's ref for the height reading.
 */
export function useSheetDrag(
  sheetRef: React.RefObject<HTMLElement | null>,
  onDismiss: () => void,
): {
  handleProps: {
    onTouchStart: (event: React.TouchEvent) => void;
    onTouchMove: (event: React.TouchEvent) => void;
    onTouchEnd: () => void;
    onTouchCancel: () => void;
  };
  sheetStyle: React.CSSProperties;
  dragging: boolean;
} {
  const start = useRef<{ y: number; time: number } | null>(null);
  const last = useRef<{ y: number; time: number } | null>(null);
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);

  const reset = () => {
    start.current = null;
    last.current = null;
    setDragging(false);
    setOffset(0);
  };

  return {
    handleProps: {
      onTouchStart: (event) => {
        const touch = event.touches[0];
        if (event.touches.length !== 1 || !touch) {
          return;
        }
        // A sheet whose body is scrolled should scroll, not dismiss.
        const scrollable = (event.target as HTMLElement).closest("[data-sheet-scroll]");
        if (scrollable && scrollable.scrollTop > 0) {
          return;
        }
        start.current = { y: touch.clientY, time: performance.now() };
        last.current = start.current;
        setDragging(true);
      },
      onTouchMove: (event) => {
        const touch = event.touches[0];
        if (!start.current || !touch) {
          return;
        }
        last.current = { y: touch.clientY, time: performance.now() };
        setOffset(Math.max(0, touch.clientY - start.current.y));
      },
      onTouchEnd: () => {
        if (!start.current || !last.current) {
          return;
        }
        const travelled = last.current.y - start.current.y;
        const elapsed = Math.max(1, last.current.time - start.current.time);
        const height = sheetRef.current?.getBoundingClientRect().height ?? 0;
        if (shouldDismiss(travelled, travelled / elapsed, height)) {
          reset();
          onDismiss();
        } else {
          reset();
        }
      },
      onTouchCancel: reset,
    },
    sheetStyle: dragging && offset > 0 ? { transform: `translateY(${offset}px)`, transition: "none" } : {},
    dragging,
  };
}
