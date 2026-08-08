import { useEffect, useRef } from "react";
import { doubleTap, pan, pinch, zoomAt, type Box, type Pt, type ZoomState } from "../zoom";

/** Two taps count as one double-tap when they land this close in time and place. */
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_PX = 24;
/** Beyond this a pointer's own down-to-up travel is a drag, not a tap. */
const TAP_DRAG_PX = 10;
/** How much one ctrl+wheel notch or keyboard press changes the scale by. */
const WHEEL_ZOOM_STEP = 1.12;

/**
 * The image in the viewer, pinch-to-zoom and pan and double-tap capable.
 *
 * All the touch/wheel bookkeeping lives here; the arithmetic it calls into
 * lives in `zoom.ts` where it can be tested without a DOM. The one thing
 * this component cannot get from that module is where the box actually is
 * on screen: `zoom.ts` works in the box's own untransformed pixel space, so
 * every incoming client coordinate gets converted into that frame first, by
 * undoing the transform this component itself is applying.
 */
export function ZoomableImage(props: {
  src: string;
  alt: string;
  zoom: ZoomState;
  onZoomChange: (next: ZoomState | ((prev: ZoomState) => ZoomState)) => void;
  boxRef: React.MutableRefObject<Box>;
}) {
  const { zoom, onZoomChange } = props;
  const imgRef = useRef<HTMLImageElement>(null);
  // A ref mirror of the current zoom, read inside DOM event handlers so a
  // fast run of pointer events never sees a stale scale from a render that
  // has not committed yet.
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const pointers = useRef(new Map<number, Pt>());
  const downAt = useRef(new Map<number, Pt>());
  const lastTap = useRef<{ time: number; x: number; y: number } | null>(null);

  /**
   * The image's own untransformed box: undo the currently-applied
   * translate+scale from its painted (getBoundingClientRect) position to
   * recover where it would sit, and how big it would be, at rest. Touch
   * and wheel coordinates get the same treatment so both land in the box's
   * own top-left-origin frame that `zoom.ts` expects.
   */
  const layout = () => {
    const img = imgRef.current;
    if (!img) {
      return null;
    }
    const painted = img.getBoundingClientRect();
    const s = zoomRef.current;
    const width = painted.width / s.scale;
    const height = painted.height / s.scale;
    const centerX = painted.left + painted.width / 2 - s.x;
    const centerY = painted.top + painted.height / 2 - s.y;
    return { left: centerX - width / 2, top: centerY - height / 2, width, height };
  };

  const measureBox = () => {
    const rect = layout();
    if (rect) {
      props.boxRef.current = { width: rect.width, height: rect.height };
    }
  };

  useEffect(() => {
    const img = imgRef.current;
    if (!img) {
      return;
    }
    measureBox();
    const observer = new ResizeObserver(measureBox);
    observer.observe(img);
    window.addEventListener("resize", measureBox);

    // React registers its JSX onWheel as a passive listener on the root
    // (a perf default since React 17), so calling preventDefault() from a
    // React wheel handler is silently ignored: the browser's own
    // scroll/zoom would still run underneath the custom one. A native,
    // non-passive listener is the only way to actually stop it.
    const onWheelNative = (event: WheelEvent) => {
      if (!event.ctrlKey) {
        return;
      }
      event.preventDefault();
      const rect = layout();
      if (!rect) {
        return;
      }
      const box: Box = { width: rect.width, height: rect.height };
      const at: Pt = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      const factor = event.deltaY < 0 ? WHEEL_ZOOM_STEP : 1 / WHEEL_ZOOM_STEP;
      props.boxRef.current = box;
      onZoomChange((prev) => zoomAt(prev, prev.scale * factor, at, box));
    };
    img.addEventListener("wheel", onWheelNative, { passive: false });

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measureBox);
      img.removeEventListener("wheel", onWheelNative);
    };
    // Only `src` (a new file) needs to restart this: everything it closes
    // over (`onZoomChange`, `props.boxRef`, `imgRef`) is a stable
    // reference, so rerunning on every render would just re-observe and
    // re-bind to the same element.
  }, [props.src]);

  const onPointerDown = (event: React.PointerEvent<HTMLImageElement>) => {
    // Capture is what keeps a finger dragged past the image's edge still
    // reporting to it; losing it is a degraded gesture, not a broken one,
    // so it must not stop the pointer bookkeeping below from running.
    try {
      imgRef.current?.setPointerCapture(event.pointerId);
    } catch {
      // ignore
    }
    const pt = { x: event.clientX, y: event.clientY };
    pointers.current.set(event.pointerId, pt);
    downAt.current.set(event.pointerId, pt);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLImageElement>) => {
    const id = event.pointerId;
    if (!pointers.current.has(id)) {
      return;
    }
    const prevClient = pointers.current.get(id)!;
    const nowClient = { x: event.clientX, y: event.clientY };
    const ids = [...pointers.current.keys()];
    const rect = layout();
    if (rect && ids.length === 2) {
      const otherId = ids.find((each) => each !== id)!;
      const otherClient = pointers.current.get(otherId)!;
      const box: Box = { width: rect.width, height: rect.height };
      const toBox = (p: Pt): Pt => ({ x: p.x - rect.left, y: p.y - rect.top });
      const from: [Pt, Pt] = [toBox(prevClient), toBox(otherClient)];
      const to: [Pt, Pt] = [toBox(nowClient), toBox(otherClient)];
      props.boxRef.current = box;
      onZoomChange((prev) => pinch(prev, from, to, box));
    } else if (rect && ids.length === 1 && zoomRef.current.scale > 1) {
      const box: Box = { width: rect.width, height: rect.height };
      const dx = nowClient.x - prevClient.x;
      const dy = nowClient.y - prevClient.y;
      props.boxRef.current = box;
      onZoomChange((prev) => pan(prev, dx, dy, box));
    }
    pointers.current.set(id, nowClient);
  };

  const endPointer = (event: React.PointerEvent<HTMLImageElement>, tap: boolean) => {
    const id = event.pointerId;
    const down = downAt.current.get(id);
    const wasOnlyPointer = pointers.current.size === 1;
    pointers.current.delete(id);
    downAt.current.delete(id);
    if (!tap || !down || !wasOnlyPointer) {
      lastTap.current = null;
      return;
    }
    const nowClient = { x: event.clientX, y: event.clientY };
    if (Math.hypot(nowClient.x - down.x, nowClient.y - down.y) > TAP_DRAG_PX) {
      lastTap.current = null;
      return;
    }
    const now = Date.now();
    const last = lastTap.current;
    const isDoubleTap =
      last != null &&
      now - last.time <= DOUBLE_TAP_MS &&
      Math.hypot(nowClient.x - last.x, nowClient.y - last.y) <= DOUBLE_TAP_PX;
    if (isDoubleTap) {
      const rect = layout();
      if (rect) {
        const box: Box = { width: rect.width, height: rect.height };
        const at: Pt = { x: nowClient.x - rect.left, y: nowClient.y - rect.top };
        props.boxRef.current = box;
        onZoomChange((prev) => doubleTap(prev, at, box));
      }
      lastTap.current = null;
    } else {
      lastTap.current = { time: now, x: nowClient.x, y: nowClient.y };
    }
  };

  return (
    <img
      ref={imgRef}
      src={props.src}
      alt={props.alt}
      draggable={false}
      onLoad={measureBox}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(event) => endPointer(event, true)}
      onPointerCancel={(event) => endPointer(event, false)}
      style={{
        transform: `translate3d(${zoom.x}px, ${zoom.y}px, 0) scale(${zoom.scale})`,
        transformOrigin: "center",
        willChange: "transform",
        // Unconditional: at rest the first two-finger pinch would otherwise
        // race the browser's native page zoom, which can cancel the pointers
        // mid-gesture. The file-stepping swipe is script-driven on the parent
        // and does not depend on native touch handling, so nothing is lost.
        touchAction: "none",
      }}
    />
  );
}
