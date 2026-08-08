import { useRef, useState } from "react";
import { albumTag, type Album } from "../albums";
import { MOBILE_QUERY, useMediaQuery } from "../media";
import { useSheetDrag } from "../sheetdrag";
import { PhotoGlyph, PlusGlyph } from "./Icon";

/**
 * Where a set of files is headed: an existing album, or one named on the
 * spot. The caller owns the actual write; this is only the choice.
 */
export function AlbumPicker(props: {
  albums: readonly Album[];
  count: number;
  onPick: (tag: string) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState("");
  const draftTag = albumTag(draft);
  const sheetRef = useRef<HTMLDivElement>(null);
  const isSheet = useMediaQuery(MOBILE_QUERY);
  const drag = useSheetDrag(sheetRef, props.onClose);

  const create = (event: React.FormEvent) => {
    event.preventDefault();
    if (draftTag) {
      props.onPick(draftTag);
    }
  };

  return (
    <div className="overlay" onClick={props.onClose}>
      <div
        ref={sheetRef}
        className="modal album-picker"
        onClick={(e) => e.stopPropagation()}
        style={isSheet ? drag.sheetStyle : undefined}
        {...(isSheet ? drag.handleProps : {})}
      >
        {isSheet && <div className="sheet-grip" aria-hidden="true" />}
        <h2>Add to album</h2>
        <p className="modal-sub">
          {props.count === 1 ? "One item" : `${props.count} items`} to file away.
        </p>
        {props.albums.length > 0 && (
          <div className="album-options" data-sheet-scroll>
            {props.albums.map((album) => (
              <button key={album.tag} className="album-option" onClick={() => props.onPick(album.tag)}>
                <PhotoGlyph size={15} />
                <span className="album-option-title">{album.title}</span>
                <span className="nav-count">{album.count}</span>
              </button>
            ))}
          </div>
        )}
        <form onSubmit={create}>
          <input
            autoFocus={props.albums.length === 0}
            value={draft}
            placeholder="New album name"
            onChange={(e) => setDraft(e.target.value)}
          />
          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" onClick={props.onClose}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={!draftTag}>
              <PlusGlyph size={13} /> Create and add
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
