import type { CSSProperties } from "react";
import { useStore, type FileEntry } from "../store";
import { useDropTarget } from "../droptarget";
import { usePhotoThumb } from "../thumbs";
import { blurUrl } from "../intel/blur";
import { extension, fileKind, formatBytes, formatDate } from "../format";
import { DotsGlyph, OfflineGlyph, PeopleGlyph, StarGlyph } from "./Icon";
import { FolderArt, KIND_ACCENTS, SheetArt } from "./FileArt";
import { folderActivityLabel, type FolderActivity } from "../folderactivity";
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
  /** While gathering, every tap toggles membership instead of opening. */
  selectMode?: boolean;
  onToggleSelect?: () => void;
  onSelect: (event: React.MouseEvent) => void;
  onOpen: () => void;
  onMenu: (x: number, y: number) => void;
  onDragStart?: (event: React.DragEvent) => void;
}) {
  const { file } = props;
  // Thumbnails load only when the card approaches the viewport; until then
  // the ThumbHash placeholder (or the kind art) holds the frame.
  const { ref: cardRef, thumb } = usePhotoThumb<HTMLDivElement>(file);
  const keptOffline = useStore((s) =>
    s.offline.some((entry) => entry.fileId === file.id && entry.pinned && entry.complete),
  );
  const longPress = useLongPress(props.onMenu);

  const placeholder = !thumb && file.blur ? blurUrl(file.blur) : null;

  const coarse = window.matchMedia("(pointer: coarse)").matches;

  return (
    <div
      ref={cardRef}
      data-file-id={file.id}
      className={`card${props.selected ? " selected" : ""}${props.fresh ? " fresh" : ""}`}
      style={{ "--i": Math.min(props.index, 20) } as CSSProperties}
      /* A pointer clicks to select and double-clicks to open, the Mac's
         rule; a finger taps to open unless it is gathering, when taps
         toggle. The selection rules themselves live in one reducer. */
      onClick={(e) =>
        coarse
          ? props.selectMode && props.onToggleSelect
            ? props.onToggleSelect()
            : props.onOpen()
          : props.onSelect(e)
      }
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
            {file.shared && (
              <span
                className="fav-mark"
                title={`Shared by ${file.ownerEmail ?? "another account"} · you can ${
                  file.role === "editor" ? "edit" : "view"
                }`}
              >
                <PeopleGlyph size={11} />
              </span>
            )}
            {keptOffline && (
              <span className="fav-mark offline-mark" title="Available offline">
                <OfflineGlyph size={11} />
              </span>
            )}
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
  /** What is happening inside the folder; absent when it is settled. */
  activity?: FolderActivity;
  index: number;
  onOpen: () => void;
  onMenu: (x: number, y: number) => void;
  onDropFiles?: (event: React.DragEvent) => void;
}) {
  const longPress = useLongPress(props.onMenu);
  // A drag that lingers springs the folder open, so it can travel on into
  // subfolders without being dropped first.
  const drop = useDropTarget((event) => props.onDropFiles?.(event), { springLoad: props.onOpen });

  return (
    <div
      className={`card folder-card${drop.dropping ? " drop-target" : ""}`}
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
      {...drop.props}
      title={props.name}
    >
      <div className="art">
        <FolderArt activity={props.activity} />
      </div>
      <div className="label">
        <div className="label-text">
          <div className="name">
            {props.name}
            {props.activity && <span className="tw:sr-only">, {folderActivityLabel(props.activity)}</span>}
          </div>
          <div className="sub">
            {props.count} item{props.count === 1 ? "" : "s"}
          </div>
        </div>
        <MenuButton onMenu={props.onMenu} />
      </div>
    </div>
  );
}
