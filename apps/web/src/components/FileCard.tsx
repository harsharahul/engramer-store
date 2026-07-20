import { useEffect, useState, type CSSProperties } from "react";
import type { FileEntry } from "../store";
import { thumbnailUrl } from "../thumbs";
import { extension, fileKind, formatBytes, formatDate } from "../format";
import { DownloadGlyph, PencilGlyph, ShareGlyph, TrashGlyph } from "./Icon";

export function FileCard(props: {
  file: FileEntry;
  index: number;
  onOpen: () => void;
  onDownload: () => void;
  onShare: () => void;
  onRename: () => void;
  onTrash: () => void;
}) {
  const { file } = props;
  const [thumb, setThumb] = useState<string | null>(null);

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

  const glyph = extension(file.name) || fileKind(file.mime, file.name).toUpperCase();

  const action =
    (handler: () => void) => (event: React.MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      handler();
    };

  return (
    <div
      className="card"
      style={{ "--i": Math.min(props.index, 20) } as CSSProperties}
      onClick={props.onOpen}
      title={file.name}
    >
      <div className="art">
        {thumb ? <img src={thumb} alt="" loading="lazy" /> : <span className="glyph">{glyph}</span>}
      </div>
      <div className="label">
        <div className="name">{file.name}</div>
        <div className="sub">
          {formatBytes(file.size)} · {formatDate(file.mtime)}
        </div>
      </div>
      <div className="hover-actions">
        <button className="icon-btn" title="Download" onClick={action(props.onDownload)}>
          <DownloadGlyph />
        </button>
        <button className="icon-btn" title="Share" onClick={action(props.onShare)}>
          <ShareGlyph />
        </button>
        <button className="icon-btn" title="Rename" onClick={action(props.onRename)}>
          <PencilGlyph />
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
        <span className="glyph">FOLDER</span>
      </div>
      <div className="label">
        <div className="name">{props.name}</div>
        <div className="sub">Folder</div>
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
