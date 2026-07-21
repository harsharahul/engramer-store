import { useEffect, useState } from "react";
import type { FileEntry } from "../store";
import { downloadAndDecrypt } from "../transfer";
import { fileKind, formatBytes } from "../format";
import { triggerDownload } from "../download";
import { DownloadGlyph, PencilGlyph, ShareGlyph, TagGlyph, XGlyph } from "./Icon";

interface Loaded {
  url: string | null;
  text: string | null;
}

export function Preview(props: {
  file: FileEntry;
  onClose: () => void;
  onShare: () => void;
  onRename: () => void;
  onEditTags: () => void;
  onEdit?: () => void;
}) {
  const { file } = props;
  const kind = fileKind(file.mime, file.name);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let url: string | null = null;
    let cancelled = false;
    setLoaded(null);
    setError(null);
    void downloadAndDecrypt(file.id, file.key)
      .then((bytes) => {
        if (cancelled) {
          return;
        }
        if (kind === "text") {
          setLoaded({ url: null, text: new TextDecoder().decode(bytes) });
          return;
        }
        const mime = kind === "pdf" ? "application/pdf" : file.mime;
        url = URL.createObjectURL(new Blob([bytes.slice().buffer as ArrayBuffer], { type: mime }));
        setLoaded({ url, text: null });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "could not decrypt this file");
        }
      });
    return () => {
      cancelled = true;
      if (url) {
        URL.revokeObjectURL(url);
      }
    };
  }, [file.id, file.key, file.mime, kind]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        props.onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props]);

  const download = async () => {
    const bytes = await downloadAndDecrypt(file.id, file.key);
    triggerDownload(
      new Blob([bytes.slice().buffer as ArrayBuffer], { type: file.mime }),
      file.name,
    );
  };

  return (
    <div className="preview-shell">
      <div className="preview-top">
        <span className="name">{file.name}</span>
        <span className="meta">{formatBytes(file.size)}</span>
        <div className="grow" />
        {props.onEdit && (
          <button className="btn" onClick={props.onEdit}>
            <PencilGlyph size={14} /> Edit
          </button>
        )}
        <button className="icon-btn" title="Share" onClick={props.onShare}>
          <ShareGlyph />
        </button>
        <button className="icon-btn" title="Edit tags" onClick={props.onEditTags}>
          <TagGlyph />
        </button>
        <button className="icon-btn" title="Rename" onClick={props.onRename}>
          <PencilGlyph />
        </button>
        <button className="icon-btn" title="Download" onClick={download}>
          <DownloadGlyph />
        </button>
        <button className="icon-btn" title="Close" onClick={props.onClose}>
          <XGlyph />
        </button>
      </div>
      <div className="preview-body">
        {error ? (
          <div className="preview-fallback">{error}</div>
        ) : !loaded ? (
          <div className="spinner" />
        ) : kind === "image" && loaded.url ? (
          <img src={loaded.url} alt={file.name} />
        ) : kind === "video" && loaded.url ? (
          <video src={loaded.url} controls autoPlay />
        ) : kind === "audio" && loaded.url ? (
          <audio src={loaded.url} controls autoPlay />
        ) : kind === "pdf" && loaded.url ? (
          <iframe src={loaded.url} title={file.name} />
        ) : loaded.text !== null ? (
          <pre>{loaded.text}</pre>
        ) : (
          <div className="preview-fallback">
            No inline preview for this type.
            <br />
            <button className="btn" style={{ marginTop: 14 }} onClick={download}>
              <DownloadGlyph /> Download decrypted copy
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
