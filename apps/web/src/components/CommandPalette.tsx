import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store";
import { searchFiles, highlightParts, type Highlight } from "../search";
import { extension, formatBytes } from "../format";
import { SearchGlyph } from "./Icon";

export interface PaletteAction {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

type Row =
  | { kind: "action"; action: PaletteAction }
  | {
      kind: "file";
      id: string;
      name: string;
      nameRanges: Highlight[];
      sub: string;
      snippet: string | null;
      snippetRanges: Highlight[];
    };

function Marked(props: { value: string; ranges: Highlight[] }) {
  return (
    <>
      {highlightParts(props.value, props.ranges).map((part, i) =>
        part.hit ? <mark key={i}>{part.text}</mark> : <span key={i}>{part.text}</span>,
      )}
    </>
  );
}

/**
 * Cmd+K omnisearch. One input drives both actions and the same local search
 * engine the top bar uses, so results appear as fast as the user types.
 */
export function CommandPalette(props: {
  actions: PaletteAction[];
  onOpenFile: (id: string) => void;
  onClose: () => void;
}) {
  const files = useStore((s) => s.files);
  const folders = useStore((s) => s.folders);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const rows = useMemo<Row[]>(() => {
    const trimmed = query.trim();
    const actionRows: Row[] = props.actions
      .filter((a) => !trimmed || a.label.toLowerCase().includes(trimmed.toLowerCase()))
      .map((action) => ({ kind: "action", action }));
    if (!trimmed) {
      return actionRows;
    }
    const fileRows: Row[] = searchFiles(files.values(), trimmed, folders)
      .slice(0, 20)
      .map((hit) => {
        const parent = hit.file.folderId ? folders.get(hit.file.folderId)?.name : null;
        return {
          kind: "file" as const,
          id: hit.file.id,
          name: hit.file.name,
          nameRanges: hit.nameRanges,
          sub: `${parent ?? "All files"} · ${formatBytes(hit.file.size)}`,
          snippet: hit.matchedText,
          snippetRanges: hit.textRanges,
        };
      });
    return [...fileRows, ...actionRows];
  }, [query, files, folders, props.actions]);

  useEffect(() => setCursor(0), [query]);

  useEffect(() => {
    const active = listRef.current?.querySelector<HTMLElement>("[data-active='true']");
    active?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  const choose = (row: Row | undefined) => {
    if (!row) {
      return;
    }
    if (row.kind === "action") {
      row.action.run();
    } else {
      props.onOpenFile(row.id);
    }
    props.onClose();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setCursor((c) => Math.min(c + 1, rows.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      choose(rows[cursor]);
    } else if (event.key === "Escape") {
      props.onClose();
    }
  };

  return (
    <div className="overlay palette-overlay" onClick={props.onClose}>
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <div className="palette-input">
          <SearchGlyph size={17} />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search everything, or type a command"
          />
          <kbd className="mono">esc</kbd>
        </div>
        <div className="palette-rows" ref={listRef}>
          {rows.length === 0 ? (
            <div className="palette-empty">No matches</div>
          ) : (
            rows.map((row, i) => (
              <button
                key={row.kind === "action" ? row.action.id : row.id}
                className={`palette-row${i === cursor ? " active" : ""}`}
                data-active={i === cursor}
                onMouseEnter={() => setCursor(i)}
                onClick={() => choose(row)}
              >
                {row.kind === "action" ? (
                  <>
                    <span className="palette-badge">GO</span>
                    <span className="palette-main">
                      <span className="palette-name">{row.action.label}</span>
                    </span>
                    {row.action.hint && <span className="palette-hint mono">{row.action.hint}</span>}
                  </>
                ) : (
                  <>
                    <span className="palette-badge">{extension(row.name) || "FILE"}</span>
                    <span className="palette-main">
                      <span className="palette-name">
                        <Marked value={row.name} ranges={row.nameRanges} />
                      </span>
                      {row.snippet && (
                        <span className="palette-snippet">
                          <Marked value={row.snippet} ranges={row.snippetRanges} />
                        </span>
                      )}
                    </span>
                    <span className="palette-hint mono">{row.sub}</span>
                  </>
                )}
              </button>
            ))
          )}
        </div>
        <div className="palette-foot mono">
          <span>↑↓ navigate · ⏎ open</span>
          <span>tag: type: in: is:favorite</span>
        </div>
      </div>
    </div>
  );
}
