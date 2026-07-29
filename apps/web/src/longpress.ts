import { useRef } from "react";

const HOLD_MS = 450;
const MOVE_CANCEL_PX = 10;

/**
 * Long-press detection for touch. Spread the returned handlers onto an
 * element; the callback fires with the touch point after the finger holds
 * still long enough. The click that follows a completed long-press is
 * suppressed so the element's tap action does not also run.
 */
export function useLongPress(onLongPress: (x: number, y: number) => void) {
  const timer = useRef<number | null>(null);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);

  const cancel = () => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  };

  return {
    onTouchStart: (event: React.TouchEvent) => {
      cancel();
      const touch = event.touches[0];
      if (event.touches.length !== 1 || !touch) {
        return;
      }
      origin.current = { x: touch.clientX, y: touch.clientY };
      fired.current = false;
      timer.current = window.setTimeout(() => {
        timer.current = null;
        fired.current = true;
        if (origin.current) {
          onLongPress(origin.current.x, origin.current.y);
        }
      }, HOLD_MS);
    },
    onTouchMove: (event: React.TouchEvent) => {
      const touch = event.touches[0];
      if (timer.current === null || !origin.current || !touch) {
        return;
      }
      if (
        Math.abs(touch.clientX - origin.current.x) > MOVE_CANCEL_PX ||
        Math.abs(touch.clientY - origin.current.y) > MOVE_CANCEL_PX
      ) {
        cancel();
      }
    },
    onTouchEnd: (event: React.TouchEvent) => {
      cancel();
      if (fired.current) {
        // Swallow the synthetic click so a long-pressed card does not open.
        event.preventDefault();
        fired.current = false;
      }
    },
    onTouchCancel: () => {
      cancel();
      fired.current = false;
    },
  };
}
