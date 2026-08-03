import { useEffect, useRef, useState } from "react";
import type { FileEntry } from "../store";
import { downloadAndDecrypt } from "../transfer";
import { bridgeMediaUrl, mediaBridgeAvailable, mediaUrl, onMediaProgress, registerMediaKey } from "../mediastream";
import { fileKind, formatBytes } from "../format";
import { triggerDownload } from "../download";
import { DownloadGlyph, PencilGlyph, ShareGlyph, TagGlyph, XGlyph } from "./Icon";
import { diag } from "../diag";
import type { WorkbookPreview } from "../sheet";

interface Loaded {
  url: string | null;
  text: string | null;
  docx: Uint8Array | null;
  sheet: Uint8Array | null;
  pdf: Uint8Array | null;
}

/**
 * Draws a PDF with pdf.js rather than handing it to the browser.
 *
 * A blob URL in an iframe renders only where the engine ships a PDF viewer.
 * Safari's WebView does not, which is every desktop shell window and every
 * iPhone, so a document that opened on one machine was a blank page on
 * another. Drawing it ourselves works the same everywhere, and the engine is
 * already here for reading text out of PDFs.
 */
function PdfBody(props: { bytes: Uint8Array; name: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const [pages, setPages] = useState(0);

  useEffect(() => {
    let cancelled = false;
    // The loading task owns the worker; destroying it is what releases both.
    let task: { destroy: () => Promise<void> } | null = null;
    void (async () => {
      try {
        const pdfjs = await import("pdfjs-dist");
        const workerUrl = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
        pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
        const loading = pdfjs.getDocument({ data: props.bytes.slice() });
        task = loading;
        const pdf = await loading.promise;
        if (cancelled || !host.current) {
          return;
        }
        setPages(pdf.numPages);
        // Enough of a document to judge it by; the rest is a download away.
        const limit = Math.min(pdf.numPages, 30);
        for (let number = 1; number <= limit; number++) {
          const page = await pdf.getPage(number);
          if (cancelled || !host.current) {
            return;
          }
          const width = host.current.clientWidth || 800;
          const base = page.getViewport({ scale: 1 });
          // Fit the width, then draw at device resolution so text stays sharp.
          const scale = Math.min(width / base.width, 2);
          const ratio = Math.min(window.devicePixelRatio || 1, 2);
          const viewport = page.getViewport({ scale: scale * ratio });
          const canvas = document.createElement("canvas");
          canvas.width = Math.floor(viewport.width);
          canvas.height = Math.floor(viewport.height);
          canvas.style.width = `${Math.floor(viewport.width / ratio)}px`;
          canvas.style.height = `${Math.floor(viewport.height / ratio)}px`;
          canvas.className = "pdf-page";
          host.current.appendChild(canvas);
          const context = canvas.getContext("2d");
          if (context) {
            await page.render({ canvas, canvasContext: context, viewport }).promise;
          }
        }
      } catch (err) {
        diag("preview", `pdf render failed: ${err instanceof Error ? err.message : "unknown"}`);
        if (!cancelled) {
          setFailed(true);
        }
      }
    })();
    return () => {
      cancelled = true;
      void task?.destroy();
    };
  }, [props.bytes]);

  if (failed) {
    return <div className="preview-fallback">Could not render this document.</div>;
  }
  return (
    <div className="pdf-host" ref={host} data-pages={pages} />
  );
}

/** Shows a workbook as a table, one sheet at a time. */
function SheetBody(props: { bytes: Uint8Array }) {
  const [book, setBook] = useState<WorkbookPreview | null>(null);
  const [active, setActive] = useState(0);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void import("../sheet")
      .then(({ readWorkbook }) => readWorkbook(props.bytes))
      .then((workbook) => {
        if (!cancelled) {
          setBook(workbook);
          setActive(0);
        }
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
    return <div className="preview-fallback">Could not read this spreadsheet.</div>;
  }
  if (!book) {
    return <div className="office-loading"><span className="spinner" /> Reading the spreadsheet</div>;
  }
  const sheet = book.sheets[active] ?? book.sheets[0];
  if (!sheet) {
    return <div className="preview-fallback">This workbook has no sheets.</div>;
  }
  return (
    <div className="sheet-host">
      {book.sheets.length > 1 && (
        <div className="sheet-tabs">
          {book.sheets.map((each, index) => (
            <button
              key={each.name}
              className={`sheet-tab${index === active ? " active" : ""}`}
              onClick={() => setActive(index)}
            >
              {each.name}
            </button>
          ))}
        </div>
      )}
      <div className="sheet-scroll">
        <table className="sheet-table">
          <tbody>
            {sheet.rows.map((row, y) => (
              <tr key={y}>
                <th className="sheet-gutter">{y + 1}</th>
                {row.map((cell, x) => (
                  <td key={x}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {sheet.rows.length === 0 && <div className="preview-fallback">This sheet is empty.</div>}
      </div>
      {sheet.truncated && (
        <div className="sheet-note">Showing the first part of this sheet. Open it to see everything.</div>
      )}
    </div>
  );
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
      setLoaded({ url: mediaUrl(file.id), text: null, docx: null, sheet: null, pdf: null });
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
        const empty = { url: null, text: null, docx: null, sheet: null, pdf: null };
        if (kind === "text") {
          setLoaded({ ...empty, text: new TextDecoder().decode(bytes) });
          return;
        }
        if (kind === "doc") {
          setLoaded({ ...empty, docx: bytes });
          return;
        }
        if (kind === "sheet") {
          setLoaded({ ...empty, sheet: bytes });
          return;
        }
        if (kind === "pdf") {
          setLoaded({ ...empty, pdf: bytes });
          return;
        }
        url = URL.createObjectURL(new Blob([bytes.slice().buffer as ArrayBuffer], { type: file.mime }));
        setLoaded({ ...empty, url });
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
        ) : kind === "pdf" && loaded.pdf ? (
          <PdfBody bytes={loaded.pdf} name={file.name} />
        ) : kind === "sheet" && loaded.sheet ? (
          <SheetBody bytes={loaded.sheet} />
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
