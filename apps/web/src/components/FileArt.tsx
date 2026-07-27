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
  archive: "#93a4c3",
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
export function FolderArt() {
  return (
    <svg className="folder-art" viewBox="0 0 96 72" width="112" height="84" aria-hidden="true">
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
 * The brand mark: an ocean shield-document with a folded corner and the
 * "face" of text bars, matching the app icon. Rendered on its rounded tile.
 */
export function BrandMark({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 512 512" aria-hidden="true" className="brand-mark">
      <defs>
        <linearGradient id="bm-tile" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" style={{ stopColor: "var(--brand-a)" }} />
          <stop offset="100%" style={{ stopColor: "var(--brand-b)" }} />
        </linearGradient>
        <linearGradient id="bm-sheet" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="#ffffff" />
          <stop offset="100%" stopColor="#dbeafe" />
        </linearGradient>
      </defs>
      <rect width="512" height="512" rx="120" fill="url(#bm-tile)" />
      <path
        d="M 168 176 Q 168 152 192 152 L 312 152 L 344 186 L 344 292 Q 344 356 256 396 Q 168 356 168 292 Z"
        fill="url(#bm-sheet)"
      />
      <path d="M 312 152 L 344 186 L 312 186 Z" fill="#93c5fd" />
      <rect x="200" y="228" width="66" height="13" rx="6.5" fill="#1e40af" />
      <rect x="274" y="228" width="40" height="13" rx="6.5" fill="#2563eb" />
      <rect x="200" y="258" width="44" height="13" rx="6.5" fill="#22d3ee" />
      <rect x="252" y="258" width="62" height="13" rx="6.5" fill="#1e40af" />
      <rect x="214" y="288" width="52" height="13" rx="6.5" fill="#2563eb" />
      <rect x="274" y="288" width="24" height="13" rx="6.5" fill="#22d3ee" />
      <rect x="226" y="318" width="40" height="13" rx="6.5" fill="#1e40af" />
    </svg>
  );
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
