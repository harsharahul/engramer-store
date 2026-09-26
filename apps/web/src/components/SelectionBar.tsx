import { DownloadGlyph, MoveGlyph, PhotoGlyph, StarGlyph, TrashGlyph, XGlyph } from "./Icon";
import { Button } from "./ui/button";
import { IconButton } from "./ui/icon-button";

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
  /** Present when every selected item is a PDF and there are at least two. */
  onCombinePdf?: () => void;
}) {
  const none = props.count === 0;
  return (
    <div className="bulk-bar">
      <span>
        {none ? "Select items" : `${props.count} selected`}
        {/* The promise this bar makes on a Mac; hidden where fingers tap. */}
        <small className="bulk-hint">Click adds or removes · ⌘-click too · Esc clears</small>
      </span>
      {props.count < props.total && (
        <Button variant="ghost" onClick={props.onSelectAll}>
          All {props.total}
        </Button>
      )}
      <Button variant="ghost" disabled={none} onClick={props.onFavorite}>
        <StarGlyph size={13} /> Favorite
      </Button>
      <Button variant="ghost" disabled={none} onClick={props.onAlbum}>
        <PhotoGlyph size={13} /> Album
      </Button>
      <Button variant="ghost" disabled={none} onClick={props.onMove}>
        <MoveGlyph size={13} /> Move
      </Button>
      <Button variant="ghost" disabled={none} onClick={props.onDownload}>
        <DownloadGlyph size={13} /> Save
      </Button>
      {props.onCombinePdf && (
        <Button variant="ghost" onClick={props.onCombinePdf} title="One PDF from the selected ones, in view order">
          Combine PDFs
        </Button>
      )}
      <Button variant="ghost" className="danger" disabled={none} onClick={props.onTrash}>
        <TrashGlyph size={13} /> Trash
      </Button>
      <IconButton label="Done" onClick={props.onDone}>
        <XGlyph size={13} />
      </IconButton>
    </div>
  );
}
