import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { FileEntry } from "../store";
import { thumbnailUrl } from "../thumbs";
import { blurUrl } from "../intel/blur";
import { extension, fileKind, formatBytes, formatDate } from "../format";
import { DotsGlyph, StarGlyph } from "./Icon";
import { FolderArt, KIND_ACCENTS, SheetArt } from "./FileArt";
import { useLongPress } from "../longpress";

/** Overflow trigger shown on cards and rows; long-press is undiscoverable alone. */
function MenuButton(props: { onMenu: (x: number, y: number) => void }) {
  return (
    <button
      className="item-menu"
      title="Actions"
      aria-label="Actions"
      onClick={(event) => {
        event.stopPropagation();
        const rect = event.currentTarget.getBoundingClientRect();
        props.onMenu(rect.left, rect.bottom + 4);
      }}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <DotsGlyph size={15} />
    </button>
  );
}

/**
 * Grid tile. Selection-first interaction: click selects (and opens the
 * inspector), double-click opens, right-click gets the context menu. On
 * coarse pointers a single tap opens directly and a long-press (or the
 * overflow button) opens the menu.
 */
export function FileCard(props: {
  file: FileEntry;
  index: number;
  selected: boolean;
  fresh?: boolean;
  onSelect: (event: React.MouseEvent) => void;
  onOpen: () => void;
  onMenu: (x: number, y: number) => void;
  onDragStart?: (event: React.DragEvent) => void;
}) {
  const { file } = props;
  const [thumb, setThumb] = useState<string | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const longPress = useLongPress(props.onMenu);

  // Thumbnails load only when the card approaches the viewport; until then
  // the ThumbHash placeholder (or the kind art) holds the frame.
  useEffect(() => {
    if (!file.hasThumb || !cardRef.current) {
      return;
    }
    let cancelled = false;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          observer.disconnect();
          void thumbnailUrl(file.id, file.key).then((url) => {
            if (!cancelled) {
              setThumb(url);
            }
          });
        }
      },
      { rootMargin: "400px" },
    );
    observer.observe(cardRef.current);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [file.id, file.hasThumb, file.key]);

  const placeholder = !thumb && file.blur ? blurUrl(file.blur) : null;

  const coarse = window.matchMedia("(pointer: coarse)").matches;

  return (
    <div
      ref={cardRef}
      className={`card${props.selected ? " selected" : ""}${props.fresh ? " fresh" : ""}`}
      style={{ "--i": Math.min(props.index, 20) } as CSSProperties}
      onClick={(e) => (coarse ? props.onOpen() : props.onSelect(e))}
      onDoubleClick={props.onOpen}
      onContextMenu={(e) => {
        e.preventDefault();
        props.onMenu(e.clientX, e.clientY);
      }}
      {...longPress}
      /* A draggable element claims the long-press for its drag lift on
         iOS, so the menu gesture only works with dragging off there. */
      draggable={!coarse}
      onDragStart={coarse ? undefined : props.onDragStart}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          props.onOpen();
        }
      }}
      title={file.name}
    >
      <div className="art" style={{ color: KIND_ACCENTS[fileKind(file.mime, file.name)] }}>
        {thumb ? (
          <img src={thumb} alt="" loading="lazy" />
        ) : placeholder ? (
          <img src={placeholder} alt="" className="blur-placeholder" />
        ) : (
          <SheetArt kind={fileKind(file.mime, file.name)} ext={extension(file.name)} />
        )}
        {file.corrupt && (
          <span
            className="corrupt-chip"
            title="This file does not match the digest recorded when it was uploaded. Download it to see what is left, then upload it again."
          >
            damaged
          </span>
        )}
        {file.category && <span className="category-chip">{file.category}</span>}
        <span className="select-ring" aria-hidden="true" />
      </div>
      <div className="label">
        <div className="label-text">
          <div className="name">
            {file.favorite && (
              <span className="fav-mark" title="Favorite">
                <StarGlyph filled size={11} />
              </span>
            )}
            {file.name}
          </div>
          <div className="sub">
            {formatBytes(file.size)} · {formatDate(file.mtime)}
          </div>
        </div>
        <MenuButton onMenu={props.onMenu} />
      </div>
    </div>
  );
}

export function FolderCard(props: {
  name: string;
  count: number;
  index: number;
  onOpen: () => void;
  onMenu: (x: number, y: number) => void;
  onDropFiles?: (event: React.DragEvent) => void;
}) {
  const [dropping, setDropping] = useState(false);
  const longPress = useLongPress(props.onMenu);

  return (
    <div
      className={`card folder-card${dropping ? " drop-target" : ""}`}
      style={{ "--i": Math.min(props.index, 20) } as CSSProperties}
      onClick={props.onOpen}
      onContextMenu={(e) => {
        e.preventDefault();
        props.onMenu(e.clientX, e.clientY);
      }}
      {...longPress}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          props.onOpen();
        }
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("application/x-engramer-files")) {
          e.preventDefault();
          e.stopPropagation();
          setDropping(true);
        }
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={(e) => {
        if (e.dataTransfer.types.includes("application/x-engramer-files")) {
          e.preventDefault();
          e.stopPropagation();
          setDropping(false);
          props.onDropFiles?.(e);
        }
      }}
      title={props.name}
    >
      <div className="art">
        <FolderArt />
      </div>
      <div className="label">
        <div className="label-text">
          <div className="name">{props.name}</div>
          <div className="sub">
            {props.count} item{props.count === 1 ? "" : "s"}
          </div>
        </div>
        <MenuButton onMenu={props.onMenu} />
      </div>
    </div>
  );
}
