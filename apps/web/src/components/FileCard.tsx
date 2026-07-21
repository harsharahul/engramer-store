import { useEffect, useState, type CSSProperties } from "react";
import type { FileEntry } from "../store";
import { thumbnailUrl } from "../thumbs";
import { extension, fileKind, formatBytes, formatDate } from "../format";
import { StarGlyph } from "./Icon";
import { FolderArt, SheetArt } from "./FileArt";

/**
 * Grid tile. Selection-first interaction: click selects (and opens the
 * inspector), double-click opens, right-click gets the context menu. On
 * coarse pointers a single tap opens directly.
 */
export function FileCard(props: {
  file: FileEntry;
  index: number;
  selected: boolean;
  onSelect: (event: React.MouseEvent) => void;
  onOpen: () => void;
  onContextMenu: (event: React.MouseEvent) => void;
  onDragStart?: (event: React.DragEvent) => void;
}) {
  const { file } = props;
  const [thumb, setThumb] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (file.hasThumb) {
      void thumbnailUrl(file.id, file.key).then((url) => {
        if (!cancelled) {
          setThumb(url);
        }
      });
    }
    return () => {
      cancelled = true;
    };
  }, [file.id, file.hasThumb, file.key]);

  const coarse = window.matchMedia("(pointer: coarse)").matches;

  return (
    <div
      className={`card${props.selected ? " selected" : ""}`}
      style={{ "--i": Math.min(props.index, 20) } as CSSProperties}
      onClick={(e) => (coarse ? props.onOpen() : props.onSelect(e))}
      onDoubleClick={props.onOpen}
      onContextMenu={props.onContextMenu}
      draggable
      onDragStart={props.onDragStart}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          props.onOpen();
        }
      }}
      title={file.name}
    >
      <div className="art">
        {thumb ? (
          <img src={thumb} alt="" loading="lazy" />
        ) : (
          <SheetArt kind={fileKind(file.mime, file.name)} ext={extension(file.name)} />
        )}
        {file.category && <span className="category-chip">{file.category}</span>}
        <span className="select-ring" aria-hidden="true" />
      </div>
      <div className="label">
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
    </div>
  );
}

export function FolderCard(props: {
  name: string;
  count: number;
  index: number;
  onOpen: () => void;
  onContextMenu: (event: React.MouseEvent) => void;
  onDropFiles?: (event: React.DragEvent) => void;
}) {
  const [dropping, setDropping] = useState(false);

  return (
    <div
      className={`card folder-card${dropping ? " drop-target" : ""}`}
      style={{ "--i": Math.min(props.index, 20) } as CSSProperties}
      onClick={props.onOpen}
      onContextMenu={props.onContextMenu}
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
        <div className="name">{props.name}</div>
        <div className="sub">
          {props.count} item{props.count === 1 ? "" : "s"}
        </div>
      </div>
    </div>
  );
}
