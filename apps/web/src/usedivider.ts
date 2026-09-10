import { useRef, useState } from "react";

/**
 * A draggable divider between two columns. The caller decides what a
 * pointer position means (a width, a snap shut) and where to persist it;
 * this only turns pointer events into those calls, holds the capture so a
 * fast drag never escapes the handle, and keeps the page from selecting
 * text or changing cursor while the drag lasts. Double-click resets.
 */
export function useDivider(handlers: {
  /** The drag begins: a chance to note where things stood. */
  onStart?: () => void;
  onDrag: (clientX: number) => void;
  onEnd: () => void;
  onReset: () => void;
}) {
  const [active, setActive] = useState(false);
  const latest = useRef(handlers);
  latest.current = handlers;

  return {
    active,
    props: {
      onPointerDown: (event: React.PointerEvent<HTMLElement>) => {
        if (event.button !== 0) {
          return;
        }
        event.preventDefault();
        const target = event.currentTarget;
        target.setPointerCapture(event.pointerId);
        document.body.classList.add("resizing");
        setActive(true);
        latest.current.onStart?.();
        const move = (e: PointerEvent) => latest.current.onDrag(e.clientX);
        const up = () => {
          target.removeEventListener("pointermove", move);
          target.removeEventListener("pointerup", up);
          target.removeEventListener("pointercancel", up);
          document.body.classList.remove("resizing");
          setActive(false);
          latest.current.onEnd();
        };
        target.addEventListener("pointermove", move);
        target.addEventListener("pointerup", up);
        target.addEventListener("pointercancel", up);
      },
      onDoubleClick: () => latest.current.onReset(),
    },
  };
}
