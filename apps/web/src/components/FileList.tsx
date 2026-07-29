import type { CSSProperties } from "react";
import type { FileEntry } from "../store";
import { extension, formatBytes, formatDate } from "../format";
import { DotsGlyph, StarGlyph } from "./Icon";
import { useLongPress } from "../longpress";

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

function FileRow(props: {
  file: FileEntry;
  index: number;
  selected: boolean;
  onSelect: (event: React.MouseEvent) => void;
  onOpen: () => void;
  onMenu: (x: number, y: number) => void;
  onDragStart?: (event: React.DragEvent) => void;
}) {
  const { file } = props;
  const longPress = useLongPress(props.onMenu);
  const coarse = window.matchMedia("(pointer: coarse)").matches;

  return (
    <div
      className={`row${props.selected ? " selected" : ""}`}
      style={{ "--i": Math.min(props.index, 20) } as CSSProperties}
      onClick={(e) => (coarse ? props.onOpen() : props.onSelect(e))}
      onDoubleClick={props.onOpen}
      onContextMenu={(e) => {
        e.preventDefault();
        props.onMenu(e.clientX, e.clientY);
      }}
      {...longPress}
      draggable
      onDragStart={props.onDragStart}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          props.onOpen();
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
    </div>
  );
}

/** List layout: sortable columns, same selection semantics as the grid. */
export function FileList(props: {
  files: FileEntry[];
  selection: ReadonlySet<string>;
  sort: SortState;
  onSort: (key: SortKey) => void;
  onSelect: (id: string, event: React.MouseEvent) => void;
  onOpen: (id: string) => void;
  onMenu: (id: string, x: number, y: number) => void;
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
        <span className="item-menu" aria-hidden="true" />
      </div>
      {props.files.map((file, i) => (
        <FileRow
          key={file.id}
          file={file}
          index={i}
          selected={props.selection.has(file.id)}
          onSelect={(e) => props.onSelect(file.id, e)}
          onOpen={() => props.onOpen(file.id)}
          onMenu={(x, y) => props.onMenu(file.id, x, y)}
          onDragStart={(e) => props.onDragStart?.(file.id, e)}
        />
      ))}
    </div>
  );
}
