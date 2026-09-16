import { useEffect, useRef, useState, type CSSProperties } from "react";
import { extension, formatBytes, formatDate } from "../format";
import { useLongPress } from "../longpress";
import { highlightParts, type SearchHit } from "../search";
import type { FileEntry, FolderEntry } from "../store";
import { thumbnailUrl } from "../thumbs";
import { FolderGlyph } from "./Icon";

/**
 * The list a search shows. A row is an answer, so one click opens it,
 * the way the Ask card and the command palette open theirs; a modifier
 * click selects it for a batch action; a right click or a long press
 * opens its menu. The item grid keeps the Finder's click-selects and
 * double-click-opens, because there the items are things on a desk,
 * not results of a question.
 */

/** "Work / Taxes 2025" for a file, walking up the folder tree. */
export function folderPath(
  folderId: string | null,
  folders: ReadonlyMap<string, FolderEntry>,
): string | null {
  const names: string[] = [];
  let cursor = folderId;
  let guard = 0;
  while (cursor && guard < 32) {
    const folder = folders.get(cursor);
    if (!folder) {
      break;
    }
    names.unshift(folder.name);
    cursor = folder.parentId;
    guard++;
  }
  return names.length > 0 ? names.join(" / ") : null;
}

function Highlighted(props: { value: string; ranges: SearchHit["nameRanges"] }) {
  return (
    <>
      {highlightParts(props.value, props.ranges).map((part, i) =>
        part.hit ? <mark key={i}>{part.text}</mark> : <span key={i}>{part.text}</span>,
      )}
    </>
  );
}

function ResultThumb(props: { file: FileEntry }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (props.file.hasThumb) {
      void thumbnailUrl(props.file.id, props.file.key).then((u) => {
        if (!cancelled) {
          setUrl(u);
        }
      });
    } else {
      setUrl(null);
    }
    return () => {
      cancelled = true;
    };
  }, [props.file.id, props.file.hasThumb, props.file.key]);

  if (url) {
    return <img className="result-thumb" src={url} alt="" />;
  }
  return <span className="row-glyph">{extension(props.file.name) || "FILE"}</span>;
}

export function ResultRow(props: {
  hit: SearchHit;
  path: string | null;
  index: number;
  cursor: boolean;
  selected: boolean;
  onSelect: (event: React.MouseEvent) => void;
  onOpen: () => void;
  onMenu: (x: number, y: number) => void;
}) {
  const { hit } = props;
  const longPress = useLongPress(props.onMenu);

  return (
    <div
      className={`row result${props.selected ? " selected" : ""}${props.cursor ? " cursor" : ""}`}
      role="button"
      data-cursor={props.cursor}
      style={{ "--i": Math.min(props.index, 20) } as CSSProperties}
      onClick={(e) => {
        // A result opens on one click; a modifier click selects it for a
        // batch action instead.
        if (e.metaKey || e.ctrlKey || e.shiftKey) {
          props.onSelect(e);
        } else {
          props.onOpen();
        }
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        props.onMenu(e.clientX, e.clientY);
      }}
      {...longPress}
    >
      <ResultThumb file={hit.file} />
      <div className="row-main">
        <div className="name">
          <Highlighted value={hit.file.name} ranges={hit.nameRanges} />
        </div>
        <div className="result-where">
          {props.path ? (
            <span className={hit.matchedFolder ? "result-folder hit" : "result-folder"}>
              <FolderGlyph size={11} /> {props.path}
            </span>
          ) : (
            <span className="result-folder">
              <FolderGlyph size={11} /> All files
            </span>
          )}
          <span className="result-date">{formatDate(hit.file.mtime)}</span>
        </div>
        {hit.matchedText && (
          <div className="snippet">
            <Highlighted value={hit.matchedText} ranges={hit.textRanges} />
          </div>
        )}
      </div>
      {hit.semantic && <span className="row-tag meaning">meaning</span>}
      {hit.file.category && <span className="row-tag">{hit.file.category}</span>}
      <span className="row-meta">{formatBytes(hit.file.size)}</span>
    </div>
  );
}

export function SearchResults(props: {
  hits: SearchHit[];
  folders: ReadonlyMap<string, FolderEntry>;
  cursor: number;
  selection: ReadonlySet<string>;
  onSelect: (id: string, event: React.MouseEvent) => void;
  onOpen: (id: string) => void;
  onMenu: (id: string, x: number, y: number) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const active = listRef.current?.querySelector<HTMLElement>("[data-cursor='true']");
    active?.scrollIntoView({ block: "nearest" });
  }, [props.cursor]);

  if (props.hits.length === 0) {
    return (
      <div className="empty">
        <span className="empty-mark">∅</span>
        <h3>No matches</h3>
        <p>
          Search covers names, tags, folder names, and text inside documents, decrypted only on
          this device. Try <code>tag:receipts</code>, <code>type:image</code>,{" "}
          <code>before:2026</code>, or a folder's name; one-letter typos are forgiven.
        </p>
      </div>
    );
  }
  return (
    <div className="rows" ref={listRef}>
      {props.hits.map((hit, i) => (
        <ResultRow
          key={hit.file.id}
          hit={hit}
          path={folderPath(hit.file.folderId, props.folders)}
          index={i}
          cursor={i === props.cursor}
          selected={props.selection.has(hit.file.id)}
          onSelect={(e) => props.onSelect(hit.file.id, e)}
          onOpen={() => props.onOpen(hit.file.id)}
          onMenu={(x, y) => props.onMenu(hit.file.id, x, y)}
        />
      ))}
    </div>
  );
}
