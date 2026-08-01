import { useEffect, useRef, useState } from "react";
import type { FileEntry } from "../store";
import { downloadAndDecrypt } from "../transfer";
import { bridgeMediaUrl, mediaBridgeAvailable, mediaUrl, onMediaProgress, registerMediaKey } from "../mediastream";
import { fileKind, formatBytes } from "../format";
import { triggerDownload } from "../download";
import { DownloadGlyph, PencilGlyph, ShareGlyph, TagGlyph, XGlyph } from "./Icon";
import { diag } from "../diag";

interface Loaded {
  url: string | null;
  text: string | null;
  docx: Uint8Array | null;
}

/** Renders decrypted .docx bytes with docx-preview, loaded on demand. */
function DocxBody(props: { bytes: Uint8Array; name: string }) {
  const container = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void import("docx-preview")
      .then(({ renderAsync }) => {
        if (cancelled || !container.current) {
          return;
        }
        return renderAsync(
          props.bytes.slice().buffer as ArrayBuffer,
          container.current,
          undefined,
          { useBase64URL: true,
          // A .docx may embed an "altChunk" part that this renderer would
          // place in a same-origin iframe via srcdoc, executing whatever it
          // contains inside the vault's origin. Nothing here needs the
          // feature, and a document can arrive from a stranger through a
          // file request, so it stays off.
          renderAltChunks: false, inWrapper: true },
        );
      })
      .catch(() => {
        if (!cancelled) {
          setFailed(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [props.bytes]);

  if (failed) {
    return <div className="preview-fallback">Could not render this document.</div>;
  }
  return <div ref={container} className="docx-preview-host" />;
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
  const [progress, setProgress] = useState<{ loaded: number; total: number } | null>(null);

  useEffect(() => {
    let url: string | null = null;
    let cancelled = false;
    setLoaded(null);
    setError(null);
    setProgress(null);
    // Video and audio stream through the service worker's media bridge:
    // decrypted on the fly, range requests answered, nothing buffered whole.
    if ((kind === "video" || kind === "audio") && mediaBridgeAvailable()) {
      registerMediaKey(file.id);
      setLoaded({ url: mediaUrl(file.id), text: null, docx: null });
      const stopProgress = onMediaProgress(file.id, (done, total) =>
        setProgress(done < total ? { loaded: done, total } : null),
      );
      return () => {
        stopProgress();
      };
    }
    void downloadAndDecrypt(file.id, file.key)
      .then((bytes) => {
        if (cancelled) {
          return;
        }
        if (kind === "text") {
          setLoaded({ url: null, text: new TextDecoder().decode(bytes), docx: null });
          return;
        }
        if (kind === "doc") {
          setLoaded({ url: null, text: null, docx: bytes });
          return;
        }
        const mime = kind === "pdf" ? "application/pdf" : file.mime;
        url = URL.createObjectURL(new Blob([bytes.slice().buffer as ArrayBuffer], { type: mime }));
        setLoaded({ url, text: null, docx: null });
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
          <>
            <video
              src={loaded.url}
              controls
              autoPlay
              onWaiting={(e) =>
                diag(
                  "playback",
                  `${file.name} buffering at ${Math.round(e.currentTarget.currentTime)}s`,
                )
              }
              onStalled={(e) =>
                diag(
                  "playback",
                  `${file.name} stalled at ${Math.round(e.currentTarget.currentTime)}s`,
                )
              }
              onError={(e) => {
                const el = e.currentTarget;
                if (el.src.startsWith("stream:")) {
                  // The shell's native protocol failed; the service worker
                  // path always remains as the safety net.
                  diag("playback", `${file.name} native path failed; using the bridge`);
                  el.src = bridgeMediaUrl(file.id);
                  el.load();
                  void el.play().catch(() => {});
                  return;
                }
                diag("playback", `${file.name} playback error`);
              }}
              onPlaying={(e) =>
                diag(
                  "playback",
                  `${file.name} playing from ${Math.round(e.currentTarget.currentTime)}s`,
                )
              }
            />
            {progress && (
              <div className="media-progress">
                Decrypting {formatBytes(progress.loaded)} of {formatBytes(progress.total)}
              </div>
            )}
          </>
        ) : kind === "audio" && loaded.url ? (
          <audio src={loaded.url} controls autoPlay />
        ) : kind === "pdf" && loaded.url ? (
          <iframe src={loaded.url} title={file.name} />
        ) : kind === "doc" && loaded.docx ? (
          <DocxBody bytes={loaded.docx} name={file.name} />
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
