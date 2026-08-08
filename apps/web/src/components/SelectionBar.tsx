import { DownloadGlyph, MoveGlyph, PhotoGlyph, StarGlyph, TrashGlyph, XGlyph } from "./Icon";

/**
 * The bar that stands in for the tab bar while files are being gathered.
 * One row of verbs over the current selection; Done leaves the mode. The
 * same bar serves the desktop's cmd/shift selections, where it appears
 * only once more than one file is picked.
 */
export function SelectionBar(props: {
  count: number;
  total: number;
  onFavorite: () => void;
  onAlbum: () => void;
  onMove: () => void;
  onDownload: () => void;
  onTrash: () => void;
  onSelectAll: () => void;
  onDone: () => void;
}) {
  const none = props.count === 0;
  return (
    <div className="bulk-bar">
      <span>{none ? "Select items" : `${props.count} selected`}</span>
      {props.count < props.total && (
        <button className="btn btn-ghost" onClick={props.onSelectAll}>
          All {props.total}
        </button>
      )}
      <button className="btn btn-ghost" disabled={none} onClick={props.onFavorite}>
        <StarGlyph size={13} /> Favorite
      </button>
      <button className="btn btn-ghost" disabled={none} onClick={props.onAlbum}>
        <PhotoGlyph size={13} /> Album
      </button>
      <button className="btn btn-ghost" disabled={none} onClick={props.onMove}>
        <MoveGlyph size={13} /> Move
      </button>
      <button className="btn btn-ghost" disabled={none} onClick={props.onDownload}>
        <DownloadGlyph size={13} /> Save
      </button>
      <button className="btn btn-ghost danger" disabled={none} onClick={props.onTrash}>
        <TrashGlyph size={13} /> Trash
      </button>
      <button className="icon-btn" title="Done" onClick={props.onDone}>
        <XGlyph size={13} />
      </button>
    </div>
  );
}
