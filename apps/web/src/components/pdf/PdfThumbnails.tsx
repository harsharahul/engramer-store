import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";

/**
 * Small pictures of the pages, drawn when they scroll into view and kept
 * once drawn. The same list serves as the thumbnail sidebar (click to go
 * to a page) and as Pages mode's board (tap to select, with the plan's
 * order and turns shown), so there is one way pages look small.
 */

const WIDTH_SMALL = 120;
const WIDTH_LARGE = 168;

export function PdfThumbnails(props: {
  pdf: PDFDocumentProxy;
  current: number;
  /** Pages mode: the surviving pages in order; absent = every page in order. */
  order?: readonly number[];
  rotations?: Readonly<Record<number, number>>;
  picked?: ReadonlySet<number>;
  onPick: (pageNumber: number) => void;
  large?: boolean;
}) {
  const numbers = props.order ?? Array.from({ length: props.pdf.numPages }, (_, i) => i + 1);
  const width = props.large ? WIDTH_LARGE : WIDTH_SMALL;
  return (
    <div className={`pdfv-thumbs${props.large ? " large" : ""}`} role="list">
      {numbers.map((number, position) => (
        <Thumb
          key={number}
          pdf={props.pdf}
          number={number}
          position={position + 1}
          width={width}
          turn={props.rotations?.[number] ?? 0}
          current={number === props.current}
          picked={props.picked?.has(number) ?? false}
          selectable={Boolean(props.picked)}
          onPick={() => props.onPick(number)}
        />
      ))}
    </div>
  );
}

function Thumb(props: {
  pdf: PDFDocumentProxy;
  number: number;
  position: number;
  width: number;
  turn: number;
  current: boolean;
  picked: boolean;
  selectable: boolean;
  onPick: () => void;
}) {
  const host = useRef<HTMLButtonElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);
  const [drawn, setDrawn] = useState(false);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
        }
      },
      { rootMargin: "300px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible || drawn) return;
    let cancelled = false;
    void (async () => {
      try {
        const page = await props.pdf.getPage(props.number);
        const target = canvas.current;
        if (cancelled || !target) return;
        const base = page.getViewport({ scale: 1 });
        const ratio = Math.min(window.devicePixelRatio || 1, 2);
        const scale = props.width / base.width;
        const viewport = page.getViewport({ scale: scale * ratio });
        target.width = Math.floor(viewport.width);
        target.height = Math.floor(viewport.height);
        target.style.width = `${Math.floor(viewport.width / ratio)}px`;
        target.style.height = `${Math.floor(viewport.height / ratio)}px`;
        const context = target.getContext("2d");
        if (context) {
          await page.render({ canvas: target, canvasContext: context, viewport }).promise;
        }
        if (!cancelled) {
          setDrawn(true);
        }
      } catch {
        // A page that will not draw small still opens large; nothing to say here.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [visible, drawn, props.pdf, props.number, props.width]);

  return (
    <button
      ref={host}
      role="listitem"
      className={`pdfv-thumb${props.current ? " current" : ""}${props.picked ? " picked" : ""}`}
      aria-pressed={props.selectable ? props.picked : undefined}
      title={`Page ${props.number}`}
      onClick={props.onPick}
    >
      <span className="pdfv-thumb-frame" style={{ width: props.width, transform: props.turn ? `rotate(${props.turn}deg)` : undefined }}>
        <canvas ref={canvas} />
      </span>
      <span className="pdfv-thumb-label">
        {props.position}
        {props.position !== props.number ? ` (was ${props.number})` : ""}
        {props.turn ? ` · ${props.turn}°` : ""}
      </span>
    </button>
  );
}
