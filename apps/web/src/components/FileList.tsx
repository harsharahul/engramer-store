import type { CSSProperties } from "react";
import { useStore, type FileEntry } from "../store";
import { extension, formatBytes, formatDate } from "../format";
import { DotsGlyph, FolderGlyph, OfflineGlyph, StarGlyph } from "./Icon";
import { useLongPress } from "../longpress";
import { useDropTarget } from "../droptarget";
import { folderActivityLabel, type FolderActivity } from "../folderactivity";

export type SortKey = "name" | "mtime" | "size";
export interface SortState {
  key: SortKey;
  dir: 1 | -1;
}

/** What a folder shows in either layout: its name and how much it holds. */
export interface FolderRowData {
  id: string;
  name: string;
  count: number;
}

/**
 * Folders follow the same sort as files, always kept on top. Name sorts by
 * name in the chosen direction; size sorts by how many items a folder holds;
 * folders carry no date of their own, so a date sort leaves them by name.
 */
export function sortFolders<T extends FolderRowData>(folders: T[], sort: SortState): T[] {
  const byName = (a: T, b: T) => a.name.localeCompare(b.name);
  return [...folders].sort((a, b) => {
    switch (sort.key) {
      case "name":
        return byName(a, b) * sort.dir;
      case "size":
        return (a.count - b.count) * sort.dir || byName(a, b);
      default:
        return byName(a, b);
    }
  });
}

function FolderRow(props: {
  folder: FolderRowData;
  activity?: FolderActivity;
  index: number;
  onOpen: () => void;
  onMenu: (x: number, y: number) => void;
  onDropFiles?: (event: React.DragEvent) => void;
}) {
  const { folder } = props;
  const longPress = useLongPress(props.onMenu);
  // Same as the folder card: a drop lands in it, a lingering drag opens it.
  const drop = useDropTarget((event) => props.onDropFiles?.(event), { springLoad: props.onOpen });

  return (
    <div
      className={`row folder-row${drop.dropping ? " drop-target" : ""}`}
      style={{ "--i": Math.min(props.index, 20) } as CSSProperties}
      /* A folder opens on one click in both layouts, as its card does. */
      onClick={props.onOpen}
      onContextMenu={(e) => {
        e.preventDefault();
        props.onMenu(e.clientX, e.clientY);
      }}
      {...longPress}
      {...drop.props}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          props.onOpen();
        }
      }}
    >
      <span className="row-glyph folder-glyph">
        <FolderGlyph size={15} />
        {props.activity && <span className="folder-activity" data-activity={props.activity} />}
      </span>
      <span className="col-name">
        <span className="name">
          {folder.name}
          {props.activity && <span className="tw:sr-only">, {folderActivityLabel(props.activity)}</span>}
        </span>
      </span>
      <span className="col-cat">Folder</span>
      <span className="col-size">
        {folder.count} item{folder.count === 1 ? "" : "s"}
      </span>
      <span className="col-date" />
      <button
        className="item-menu"
        title="Actions"
        aria-label="Actions"
        onClick={(event) => {
          event.stopPropagation();
          const rect = event.currentTarget.getBoundingClientRect();
          props.onMenu(rect.left, rect.bottom + 4);
        }}
      >
        <DotsGlyph size={15} />
      </button>
    </div>
  );
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
  const keptOffline = useStore((s) =>
    s.offline.some((entry) => entry.fileId === file.id && entry.pinned && entry.complete),
  );
  const longPress = useLongPress(props.onMenu);
  const coarse = window.matchMedia("(pointer: coarse)").matches;

  return (
    <div
      data-file-id={file.id}
      className={`row${props.selected ? " selected" : ""}`}
      style={{ "--i": Math.min(props.index, 20) } as CSSProperties}
      /* Same rule as the card: a pointer selects, a finger opens. */
      onClick={(e) => (coarse ? props.onOpen() : props.onSelect(e))}
      onDoubleClick={coarse ? undefined : props.onOpen}
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
    >
      <span className="row-glyph">{extension(file.name) || "FILE"}</span>
      <span className="col-name">
        {file.favorite && (
          <span className="fav-mark">
            <StarGlyph filled size={11} />
          </span>
        )}
        {keptOffline && (
          <span className="fav-mark offline-mark" title="Available offline">
            <OfflineGlyph size={11} />
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

/**
 * List layout: sortable columns, same selection semantics as the grid.
 * Folders, when the place has any, are rows on top in the same columns.
 */
export function FileList(props: {
  files: FileEntry[];
  folders?: FolderRowData[];
  selection: ReadonlySet<string>;
  sort: SortState;
  onSort: (key: SortKey) => void;
  onSelect: (id: string, event: React.MouseEvent) => void;
  onOpen: (id: string) => void;
  onMenu: (id: string, x: number, y: number) => void;
  onDragStart?: (id: string, event: React.DragEvent) => void;
  onOpenFolder?: (id: string) => void;
  onFolderMenu?: (id: string, x: number, y: number) => void;
  onDropOnFolder?: (id: string, event: React.DragEvent) => void;
  /** Each folder's dot state, by folder id. */
  folderActivity?: ReadonlyMap<string, FolderActivity>;
}) {
  const folders = props.folders ?? [];
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
      {folders.map((folder, i) => (
        <FolderRow
          key={folder.id}
          folder={folder}
          activity={props.folderActivity?.get(folder.id)}
          index={i}
          onOpen={() => props.onOpenFolder?.(folder.id)}
          onMenu={(x, y) => props.onFolderMenu?.(folder.id, x, y)}
          onDropFiles={(e) => props.onDropOnFolder?.(folder.id, e)}
        />
      ))}
      {props.files.map((file, i) => (
        <FileRow
          key={file.id}
          file={file}
          index={folders.length + i}
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
