import type { CSSProperties } from "react";
import type { FileEntry } from "../store";
import { extension, formatBytes, formatDate } from "../format";
import { StarGlyph } from "./Icon";

export type SortKey = "name" | "mtime" | "size";
export interface SortState {
  key: SortKey;
  dir: 1 | -1;
}

export function sortFiles(files: FileEntry[], sort: SortState): FileEntry[] {
  const sorted = [...files].sort((a, b) => {
    switch (sort.key) {
      case "size":
        return (a.size - b.size) * sort.dir;
      case "mtime":
        return (a.mtime - b.mtime) * sort.dir;
      default:
        return a.name.localeCompare(b.name) * sort.dir;
    }
  });
  return sorted;
}

/** List layout: sortable columns, same selection semantics as the grid. */
export function FileList(props: {
  files: FileEntry[];
  selection: ReadonlySet<string>;
  sort: SortState;
  onSort: (key: SortKey) => void;
  onSelect: (id: string, event: React.MouseEvent) => void;
  onOpen: (id: string) => void;
  onContextMenu: (id: string, event: React.MouseEvent) => void;
  onDragStart?: (id: string, event: React.DragEvent) => void;
}) {
  const arrow = (key: SortKey) =>
    props.sort.key === key ? (props.sort.dir === 1 ? " ↑" : " ↓") : "";

  return (
    <div className="rows list-view">
      <div className="row list-head" aria-hidden={false}>
        <span className="row-glyph" />
        <button className="col-name col-sort" onClick={() => props.onSort("name")}>
          Name{arrow("name")}
        </button>
        <button className="col-cat col-sort" disabled>
          Category
        </button>
        <button className="col-size col-sort" onClick={() => props.onSort("size")}>
          Size{arrow("size")}
        </button>
        <button className="col-date col-sort" onClick={() => props.onSort("mtime")}>
          Modified{arrow("mtime")}
        </button>
      </div>
      {props.files.map((file, i) => (
        <div
          key={file.id}
          className={`row${props.selection.has(file.id) ? " selected" : ""}`}
          style={{ "--i": Math.min(i, 20) } as CSSProperties}
          onClick={(e) => props.onSelect(file.id, e)}
          onDoubleClick={() => props.onOpen(file.id)}
          onContextMenu={(e) => props.onContextMenu(file.id, e)}
          draggable
          onDragStart={(e) => props.onDragStart?.(file.id, e)}
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              props.onOpen(file.id);
            }
          }}
        >
          <span className="row-glyph">{extension(file.name) || "FILE"}</span>
          <span className="col-name">
            {file.favorite && (
              <span className="fav-mark">
                <StarGlyph filled size={11} />
              </span>
            )}
            <span className="name">{file.name}</span>
          </span>
          <span className="col-cat">{file.category ?? ""}</span>
          <span className="col-size">{formatBytes(file.size)}</span>
          <span className="col-date">{formatDate(file.mtime)}</span>
        </div>
      ))}
    </div>
  );
}
