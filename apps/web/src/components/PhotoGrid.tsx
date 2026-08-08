import { useEffect, useMemo, useRef, useState } from "react";
import type { FileEntry } from "../store";
import { byMonth } from "../timeline";
import { blurUrl } from "../intel/blur";
import { usePhotoThumb } from "../thumbs";
import { useLongPress } from "../longpress";
import { StarGlyph, VideoGlyph } from "./Icon";
import { fileKind } from "../format";

/**
 * The photos timeline: a dense, square-tile grid in month sections, newest
 * first. Names and sizes stay out of the frame; the picture is the point.
 *
 * Sections far from the viewport render as an empty spacer of the height
 * their tiles would occupy, so a library of tens of thousands of photos
 * costs the DOM only what is near the screen. The height needs nothing
 * fancier than row arithmetic because every tile is square and every row
 * is the same height. (CSS content-visibility would do this declaratively,
 * but the iOS-16 WebKit floor predates it.)
 */

const TILE_MIN = 92;
const TILE_GAP = 2;
const HEADER_H = 44;
/** Sections within this many viewports of the screen render for real. */
const RENDER_MARGIN = "200%";

export function PhotoGrid(props: {
  files: readonly FileEntry[];
  selection: ReadonlySet<string>;
  selectMode?: boolean;
  onSelect: (id: string, event: React.MouseEvent) => void;
  onOpen: (id: string) => void;
  onMenu: (id: string, x: number, y: number) => void;
  /** Long-press on a tile starts gathering, the photos-app idiom. */
  onEnterSelect?: (id: string) => void;
}) {
  const sections = useMemo(() => byMonth(props.files), [props.files]);
  const gridRef = useRef<HTMLDivElement>(null);
  const [columns, setColumns] = useState(3);
  const [visible, setVisible] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    const grid = gridRef.current;
    if (!grid) {
      return;
    }
    const measure = () => {
      const width = grid.clientWidth;
      setColumns(Math.max(1, Math.floor((width + TILE_GAP) / (TILE_MIN + TILE_GAP))));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(grid);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const grid = gridRef.current;
    if (!grid) {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        setVisible((prev) => {
          const next = new Set(prev);
          for (const entry of entries) {
            const key = (entry.target as HTMLElement).dataset.month;
            if (!key) {
              continue;
            }
            if (entry.isIntersecting) {
              next.add(key);
            } else {
              next.delete(key);
            }
          }
          return next;
        });
      },
      { rootMargin: RENDER_MARGIN },
    );
    for (const child of grid.children) {
      if ((child as HTMLElement).dataset.month) {
        observer.observe(child);
      }
    }
    return () => observer.disconnect();
    // Re-observe when the section list itself changes shape.
  }, [sections.map((s) => s.key).join("|")]);

  const tileSize = (width: number) => (width - (columns - 1) * TILE_GAP) / columns;

  return (
    <div className="photo-grid" ref={gridRef}>
      {sections.map((section) => {
        const rows = Math.ceil(section.files.length / columns);
        const width = gridRef.current?.clientWidth ?? 0;
        const bodyHeight = width > 0 ? rows * (tileSize(width) + TILE_GAP) - TILE_GAP : 0;
        const rendered = visible.has(section.key);
        return (
          <section
            key={section.key}
            data-month={section.key}
            style={{ minHeight: HEADER_H + Math.max(0, bodyHeight) }}
          >
            <header className="photo-month">{section.label}</header>
            {rendered && (
              <div className="photo-tiles" style={{ gridTemplateColumns: `repeat(${columns}, 1fr)` }}>
                {section.files.map((file) => (
                  <PhotoTile
                    key={file.id}
                    file={file}
                    selected={props.selection.has(file.id)}
                    selectMode={props.selectMode ?? false}
                    onSelect={(e) => props.onSelect(file.id, e)}
                    onOpen={() => props.onOpen(file.id)}
                    onMenu={(x, y) => props.onMenu(file.id, x, y)}
                    onEnterSelect={props.onEnterSelect ? () => props.onEnterSelect!(file.id) : undefined}
                  />
                ))}
              </div>
            )}
          </section>
        );
      })}
      {sections.length === 0 && <div className="photo-empty">No photos or videos here yet.</div>}
    </div>
  );
}

function PhotoTile(props: {
  file: FileEntry;
  selected: boolean;
  selectMode: boolean;
  onSelect: (event: React.MouseEvent) => void;
  onOpen: () => void;
  onMenu: (x: number, y: number) => void;
  onEnterSelect?: () => void;
}) {
  const { file } = props;
  const { ref, thumb } = usePhotoThumb<HTMLButtonElement>(file);
  // At rest a long-press starts gathering; once gathering, it falls back to
  // the menu so the tile's richer actions stay reachable on touch.
  const longPress = useLongPress((x, y) => {
    if (!props.selectMode && props.onEnterSelect) {
      props.onEnterSelect();
    } else {
      props.onMenu(x, y);
    }
  });
  const placeholder = !thumb && file.blur ? blurUrl(file.blur) : null;
  const coarse = window.matchMedia("(pointer: coarse)").matches;
  const isVideo = fileKind(file.mime, file.name) === "video";

  return (
    <button
      ref={ref}
      className={`photo-tile${props.selected ? " selected" : ""}`}
      onClick={(e) => (props.selectMode || (!coarse && (e.metaKey || e.ctrlKey || e.shiftKey)) ? props.onSelect(e) : props.onOpen())}
      onContextMenu={(e) => {
        e.preventDefault();
        props.onMenu(e.clientX, e.clientY);
      }}
      {...longPress}
      title={file.name}
      aria-label={file.name}
    >
      {thumb ? (
        <img src={thumb} alt="" loading="lazy" />
      ) : placeholder ? (
        <img src={placeholder} alt="" className="blur-placeholder" />
      ) : (
        <span className="photo-tile-blank" />
      )}
      {isVideo && (
        <span className="photo-badge video">
          <VideoGlyph size={14} />
        </span>
      )}
      {file.favorite && (
        <span className="photo-badge fav">
          <StarGlyph size={12} />
        </span>
      )}
      {props.selectMode && <span className="photo-check" aria-hidden />}
    </button>
  );
}
