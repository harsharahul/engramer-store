import type { FolderActivity } from "../folderactivity";
import type { FileKind } from "../format";

/**
 * Illustrated art for cards: a layered folder and a document sheet with a
 * kind-specific pictogram. Each kind carries its own accent hue, kept in the
 * cool family so the ocean brand accent still leads.
 */

export const KIND_ACCENTS: Record<FileKind | "folder", string> = {
  folder: "#3b82f6",
  image: "#38bdf8",
  video: "#a78bfa",
  audio: "#34d399",
  pdf: "#f47272",
  text: "#60a5fa",
  doc: "#5b8def",
  sheet: "#3fb984",
  archive: "#93a4c3",
  slides: "#f59e0b",
  link: "#6ea8fe",
  other: "#8593ab",
};

const stroke = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

function kindPictogram(kind: FileKind) {
  switch (kind) {
    case "image":
      return (
        <>
          <circle cx="9.2" cy="9.5" r="1.3" />
          <path d="m6.5 15.5 3.4-3.2 2.6 2.3 2.3-2 2.7 2.9" />
        </>
      );
    case "video":
      return <path d="M9.8 8.6v6.8l5.8-3.4Z" />;
    case "audio":
      return (
        <>
          <path d="M9.3 14.7V8.9l6-1.4v5.8" />
          <circle cx="7.9" cy="14.8" r="1.5" />
          <circle cx="13.9" cy="13.4" r="1.5" />
        </>
      );
    case "pdf":
    case "text":
      return <path d="M8.2 9h7.6M8.2 12h7.6M8.2 15h4.8" />;
    case "doc":
      return <path d="M8.2 8.4h7.6M8.2 10.9h7.6M8.2 13.4h7.6M8.2 15.9h5.2" />;
    case "archive":
      return (
        <>
          <path d="M12 6.5v9.3" strokeDasharray="1.6 1.7" />
          <path d="M10.4 16.2h3.2v2.2a1.6 1.6 0 0 1-3.2 0Z" />
        </>
      );
    default:
      return (
        <>
          <path d="M9.6 10.2a2.4 2.4 0 1 1 3.4 2.2c-.7.3-1 .8-1 1.5v.4" />
          <circle cx="12" cy="16.6" r="0.4" fill="currentColor" stroke="none" />
        </>
      );
  }
}

/** A document sheet with a folded corner and a kind pictogram. */
export function SheetArt(props: { kind: FileKind; ext: string }) {
  const accent = KIND_ACCENTS[props.kind];
  return (
    <div className="sheet-art" style={{ color: accent }}>
      <svg viewBox="0 0 24 24" width="72" height="72" {...stroke} aria-hidden="true">
        <path d="M6 3.8h8.2L19 8.6v11.6a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4.8a1 1 0 0 1 1-1Z" opacity="0.9" />
        <path d="M14.2 3.8v4.8H19" opacity="0.55" />
        <g opacity="0.85">{kindPictogram(props.kind)}</g>
      </svg>
      {props.ext && <span className="sheet-ext">{props.ext}</span>}
    </div>
  );
}

/**
 * A layered folder: back panel, papers peeking out, front flap that lifts on
 * hover. Outline and stud follow the accent (via currentColor set in CSS).
 */
/**
 * The folder illustration. Its dot shows what is happening inside the
 * folder: it pulses while work is in hand, turns amber when something
 * failed, and rests otherwise (see folderactivity.ts).
 */
export function FolderArt({ activity }: { activity?: FolderActivity } = {}) {
  return (
    <svg
      className="folder-art"
      viewBox="0 0 96 72"
      width="112"
      height="84"
      aria-hidden="true"
      data-activity={activity}
    >
      <path
        d="M8 16a4 4 0 0 1 4-4h20l7 8h45a4 4 0 0 1 4 4v32a4 4 0 0 1-4 4H12a4 4 0 0 1-4-4Z"
        fill="currentColor"
        fillOpacity="0.16"
        stroke="currentColor"
        strokeOpacity="0.6"
        strokeWidth="1.5"
      />
      <rect className="folder-paper" x="18" y="14" width="60" height="34" rx="3"
        fill="var(--ink-1)" stroke="currentColor" strokeOpacity="0.28" strokeWidth="1.3" />
      <path className="folder-paper-lines" d="M25 22h36M25 28h28" stroke="currentColor"
        strokeOpacity="0.4" strokeWidth="1.3" strokeLinecap="round" fill="none" />
      <path
        className="folder-front"
        d="M8 26h80a4 4 0 0 1 4 4l-3.4 26a4 4 0 0 1-4 3.5H11.4a4 4 0 0 1-4-3.5L4 30a4 4 0 0 1 4-4Z"
        fill="currentColor"
        fillOpacity="0.14"
        stroke="currentColor"
        strokeOpacity="0.8"
        strokeWidth="1.5"
      />
      <circle className="folder-stud" cx="48" cy="43" r="2.6" fill="var(--accent-2)" />
    </svg>
  );
}

/**
 * The brand mark: the Liquid Glass app icon, in the active accent's
 * palette. The images are rendered by scripts/brand-glass.mjs; the
 * stylesheet picks the one matching data-accent.
 */
export function BrandMark({ size = 24 }: { size?: number }) {
  return <span aria-hidden="true" className="brand-mark" style={{ width: size, height: size }} />;
}

/** The "engram store" wordmark: bold + light, with a cyan full-stop. */
export function Wordmark() {
  return (
    <span className="wordmark">
      <span className="wm-engram">engram</span>
      <span className="wm-store">store</span>
      <span className="wm-dot" aria-hidden="true" />
    </span>
  );
}
