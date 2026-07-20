import { useEffect, useState, type CSSProperties } from "react";
import type { FileEntry } from "../store";
import { thumbnailUrl } from "../thumbs";
import { extension, fileKind, formatBytes, formatDate } from "../format";
import { DownloadGlyph, PencilGlyph, ShareGlyph, StarGlyph, TrashGlyph } from "./Icon";
import { FolderArt, SheetArt } from "./FileArt";

const VISIBLE_TAGS = 3;

export function FileCard(props: {
  file: FileEntry;
  index: number;
  onOpen: () => void;
  onDownload: () => void;
  onShare: () => void;
  onToggleFavorite: () => void;
  onTagClick: (tag: string) => void;
  onTrash: () => void;
}) {
  const { file } = props;
  const [thumb, setThumb] = useState<string | null>(null);
  const [pop, setPop] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (file.hasThumb) {
      void thumbnailUrl(file.id, file.key).then((url) => {
        if (!cancelled) {
          setThumb(url);
        }
      });
    }
    return () => {
      cancelled = true;
    };
  }, [file.id, file.hasThumb, file.key]);

  const tags = file.tags.slice(0, VISIBLE_TAGS);

  const action =
    (handler: () => void) => (event: React.MouseEvent<HTMLElement>) => {
      event.stopPropagation();
      handler();
    };

  const favorite = (event: React.MouseEvent<HTMLElement>) => {
    event.stopPropagation();
    setPop(true);
    setTimeout(() => setPop(false), 320);
    props.onToggleFavorite();
  };

  return (
    <div
      className="card"
      style={{ "--i": Math.min(props.index, 20) } as CSSProperties}
      onClick={props.onOpen}
      title={file.name}
    >
      <div className="art">
        {thumb ? (
          <img src={thumb} alt="" loading="lazy" />
        ) : (
          <SheetArt kind={fileKind(file.mime, file.name)} ext={extension(file.name)} />
        )}
        {file.category && <span className="category-chip">{file.category}</span>}
      </div>
      <div className="label">
        <div className="name">{file.name}</div>
        <div className="sub">
          {formatBytes(file.size)} · {formatDate(file.mtime)}
        </div>
        {tags.length > 0 && (
          <div className="tag-row">
            {tags.map((tag) => (
              <button
                key={tag}
                className="tag"
                title={`Search tag:${tag}`}
                onClick={action(() => props.onTagClick(tag))}
              >
                {tag}
              </button>
            ))}
            {file.tags.length > VISIBLE_TAGS && (
              <span className="tag more">+{file.tags.length - VISIBLE_TAGS}</span>
            )}
          </div>
        )}
      </div>
      <button
        className={`star${file.favorite ? " on" : ""}${pop ? " pop" : ""}`}
        title={file.favorite ? "Remove from favorites" : "Add to favorites"}
        onClick={favorite}
      >
        <StarGlyph filled={file.favorite} size={15} />
      </button>
      <div className="hover-actions">
        <button className="icon-btn" title="Download" onClick={action(props.onDownload)}>
          <DownloadGlyph />
        </button>
        <button className="icon-btn" title="Share" onClick={action(props.onShare)}>
          <ShareGlyph />
        </button>
        <button className="icon-btn" title="Move to trash" onClick={action(props.onTrash)}>
          <TrashGlyph />
        </button>
      </div>
    </div>
  );
}

export function FolderCard(props: {
  name: string;
  count: number;
  index: number;
  onOpen: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const action =
    (handler: () => void) => (event: React.MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      handler();
    };

  return (
    <div
      className="card folder-card"
      style={{ "--i": Math.min(props.index, 20) } as CSSProperties}
      onClick={props.onOpen}
      title={props.name}
    >
      <div className="art">
        <FolderArt />
      </div>
      <div className="label">
        <div className="name">{props.name}</div>
        <div className="sub">
          {props.count} item{props.count === 1 ? "" : "s"}
        </div>
      </div>
      <div className="hover-actions">
        <button className="icon-btn" title="Rename" onClick={action(props.onRename)}>
          <PencilGlyph />
        </button>
        <button className="icon-btn" title="Delete" onClick={action(props.onDelete)}>
          <TrashGlyph />
        </button>
      </div>
    </div>
  );
}
