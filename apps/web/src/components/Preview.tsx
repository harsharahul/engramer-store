import { useEffect, useRef, useState } from "react";
import { useStore, type FileEntry } from "../store";
import { IntegrityError, downloadAndDecrypt } from "../transfer";
import { openSharedContent } from "../openshared";
import { bridgeMediaUrl, mediaBridgeAvailable, mediaUrl, onMediaProgress, registerMediaKey } from "../mediastream";
import { nativeShell } from "../native";
import { swipeStep } from "../neighbors";
import { fileKind, formatBytes } from "../format";
import { displayableImage } from "../intel/heic";
import { saveDecryptedFile } from "../download";
import { ZoomableImage } from "./ZoomableImage";
import { IDENTITY, zoomAt, type Box, type ZoomState } from "../zoom";
import {
  ChevronLeftGlyph,
  ChevronRightGlyph,
  DownloadGlyph,
  InfoGlyph,
  PencilGlyph,
  ShareGlyph,
  StarGlyph,
  TagGlyph,
  XGlyph,
} from "./Icon";
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
function PdfBody(props: { bytes: Uint8Array; name: string; onUnreadable: () => void }) {
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
        // Not every file named .pdf is one: a page saved by a browser, a
        // truncated download, something a share sheet mislabelled. Falling
        // back to the download offer says more than an error does.
        diag("preview", `pdf render failed: ${err instanceof Error ? err.message : "unknown"}`);
        if (!cancelled) {
          setFailed(true);
          props.onUnreadable();
        }
      }
    })();
    return () => {
      cancelled = true;
      void task?.destroy();
    };
  }, [props.bytes]);

  if (failed) {
    return null; // the shell shows its own fallback, download button and all
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

  /**
   * A Word page has a paper width, and the renderer draws it at that width
   * whatever it is being shown in. On a phone, or a narrow window, the page
   * is wider than the space it has and everything on it sits outside the
   * visible area: the document reads as a blank sheet, which is exactly what
   * it looked like. Scale it down to fit instead, the way any document
   * viewer does, and leave it alone when there is room.
   */
  const fitToWidth = () => {
    const host = container.current;
    const wrapper = host?.querySelector<HTMLElement>(".docx-wrapper");
    const page = wrapper?.querySelector<HTMLElement>("section.docx");
    if (!host || !wrapper || !page) {
      return;
    }
    const available = host.clientWidth;
    const paper = page.offsetWidth;
    if (!available || !paper) {
      return;
    }
    const scale = Math.min(available / paper, 1);
    wrapper.style.transformOrigin = "top left";
    wrapper.style.transform = scale < 1 ? `scale(${scale})` : "";
    // The scaled box still occupies its unscaled height, which would leave a
    // long empty tail below the last page.
    wrapper.style.height = scale < 1 ? `${wrapper.scrollHeight * scale}px` : "";
    wrapper.style.width = scale < 1 ? `${paper}px` : "";
  };

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
        ).then(() => fitToWidth());
      })
      .catch(() => {
        if (!cancelled) {
          setFailed(true);
        }
      });
    // Rotating a phone or dragging a window narrower has to re-fit it.
    const host = container.current;
    const observer = host ? new ResizeObserver(() => fitToWidth()) : null;
    if (host && observer) {
      observer.observe(host);
    }
    return () => {
      cancelled = true;
      observer?.disconnect();
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
  /** Where a saved-to-Files sentence or a failure goes; the preview has
   * no toast surface of its own. */
  onToast?: (message: string) => void;
  onShare: () => void;
  onRename: () => void;
  onDetails: () => void;
  onEdit?: () => void;
  /** Star toggle; double-tap now belongs to zoom, so the button is explicit. */
  onFavorite?: () => void;
  /** Move to the next or previous file in the view; null when at an end. */
  onStep?: (direction: 1 | -1) => void;
  canStepBack?: boolean;
  canStepOn?: boolean;
}) {
  const { file } = props;
  const kind = fileKind(file.mime, file.name);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  // A file whose contents do not match what its name claims: show what the
  // app shows for anything else it cannot display, rather than an apology.
  const [unreadable, setUnreadable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ loaded: number; total: number } | null>(null);
  const blobUrl = useRef<string | null>(null);
  const blobTried = useRef(false);
  const swipeFrom = useRef<{ x: number; y: number } | null>(null);
  const { onStep } = props;

  // Transform-based zoom on the image itself, not the page: native page zoom
  // would scale the fixed chrome (top bar, buttons) right along with it.
  const [zoom, setZoom] = useState<ZoomState>(IDENTITY);
  const zoomBox = useRef<Box>({ width: 0, height: 0 });

  useEffect(() => {
    setZoom(IDENTITY);
  }, [file.id]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const typing =
        event.target instanceof HTMLElement &&
        (event.target.tagName === "INPUT" || event.target.tagName === "TEXTAREA");
      if (typing) {
        return;
      }
      if (kind === "image" && (event.key === "+" || event.key === "=" || event.key === "-" || event.key === "0")) {
        event.preventDefault();
        if (event.key === "0") {
          setZoom(IDENTITY);
        } else if (zoomBox.current.width > 0) {
          // Nothing to anchor against until the image has laid out and
          // measured its box at least once.
          const factor = event.key === "-" ? 1 / 1.2 : 1.2;
          const box = zoomBox.current;
          const center = { x: box.width / 2, y: box.height / 2 };
          setZoom((prev) => zoomAt(prev, prev.scale * factor, center, box));
        }
        return;
      }
      if (!onStep) {
        return;
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        onStep(1);
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        onStep(-1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onStep, kind]);

  /**
   * The last rung of playback: decrypt the whole file and play it from
   * memory. Only reached where the native protocol failed and no service
   * worker exists to bridge (iOS today), and only within a cap, because a
   * phone should not be asked to hold a feature-length film in RAM.
   */
  const WHOLE_FILE_CAP = 150 * 1024 * 1024;
  const playDecryptedWhole = async (el: HTMLMediaElement) => {
    if (blobTried.current) {
      return;
    }
    blobTried.current = true;
    if (file.size > WHOLE_FILE_CAP) {
      diag(
        "playback",
        `${file.name} too large to decrypt whole (${Math.round(file.size / 1048576)}MB)`,
      );
      setError("This file is too large to play on this device yet.");
      return;
    }
    try {
      const bytes = await openSharedContent(file, (entry) =>
        downloadAndDecrypt(entry.id, entry.key, entry.digest),
      );
      const url = URL.createObjectURL(
        new Blob([bytes.slice().buffer as ArrayBuffer], { type: file.mime }),
      );
      blobUrl.current = url;
      el.src = url;
      el.load();
      void el.play().catch(() => {});
      diag("playback", `${file.name} playing decrypted whole`);
    } catch {
      diag("playback", `${file.name} whole-file playback failed`);
      setError("Playback failed.");
    }
  };

  useEffect(() => {
    let url: string | null = null;
    let cancelled = false;
    setLoaded(null);
    setUnreadable(false);
    setError(null);
    setProgress(null);
    // Video and audio stream: through the shell's native protocol where
    // there is one, else through the service worker's media bridge. Both
    // decrypt on the fly and answer range requests; nothing buffers whole.
    // The shell qualifies on its own, because the worker does not exist in
    // every webview (iOS), and requiring it here silently benched the
    // native path on exactly the platform that needed it most.
    if ((kind === "video" || kind === "audio") && (nativeShell() || mediaBridgeAvailable())) {
      registerMediaKey(file.id);
      setLoaded({ url: mediaUrl(file.id), text: null, docx: null, sheet: null, pdf: null });
      const stopProgress = onMediaProgress(file.id, (done, total) =>
        setProgress(done < total ? { loaded: done, total } : null),
      );
      return () => {
        stopProgress();
        if (blobUrl.current) {
          URL.revokeObjectURL(blobUrl.current);
          blobUrl.current = null;
        }
        blobTried.current = false;
      };
    }
    void openSharedContent(file, (entry) =>
      downloadAndDecrypt(entry.id, entry.key, entry.digest),
    )
      .then((bytes) => {
        if (cancelled) {
          return;
        }
        // Reading it through was the check; record that it passed.
        useStore.getState().markVerified(file.id);
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
        const blob = new Blob([bytes.slice().buffer as ArrayBuffer], { type: file.mime });
        // HEIC shows as-is where the platform decodes it; elsewhere it is
        // re-encoded first, or an <img> would render nothing.
        void displayableImage(blob, file.name).then((shown) => {
          if (cancelled) {
            return;
          }
          url = URL.createObjectURL(shown);
          setLoaded({ ...empty, url });
        });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          if (err instanceof IntegrityError) {
            // Say what is wrong plainly, mark the file so the library shows
            // it too, and leave the download working: the bytes are all that
            // is left of it and the reader may still rescue something.
            useStore.getState().markCorrupt(file.id);
          }
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
    // One shared path: the shell streams large files natively to the
    // Files app, the browser keeps its anchor, and a failed integrity
    // check still hands the bytes over rather than nothing.
    try {
      const saved = await saveDecryptedFile(file);
      if (saved) {
        props.onToast?.(saved);
      }
    } catch (err) {
      props.onToast?.(
        err instanceof Error && err.message ? `Download failed: ${err.message}` : "Download failed.",
      );
    }
  };

  return (
    <div className="preview-shell">
      <div className="preview-top">
        <span className="name">{file.name}</span>
        <span className="meta">{formatBytes(file.size)}</span>
        <div className="grow" />
        {onStep && (
          <>
            <button
              className="icon-btn"
              title="Previous (left arrow)"
              disabled={props.canStepBack === false}
              onClick={() => onStep(-1)}
            >
              <ChevronLeftGlyph />
            </button>
            <button
              className="icon-btn"
              title="Next (right arrow)"
              disabled={props.canStepOn === false}
              onClick={() => onStep(1)}
            >
              <ChevronRightGlyph />
            </button>
          </>
        )}
        {props.onEdit && (
          <button className="btn" onClick={props.onEdit}>
            <PencilGlyph size={14} /> Edit
          </button>
        )}
        {props.onFavorite && (
          <button
            className={`icon-btn${file.favorite ? " fav-active" : ""}`}
            title={file.favorite ? "Remove from favorites" : "Add to favorites"}
            onClick={props.onFavorite}
          >
            <StarGlyph />
          </button>
        )}
        <button className="icon-btn" title="Share" onClick={props.onShare}>
          <ShareGlyph />
        </button>
        <button className="icon-btn" title="Details" onClick={props.onDetails}>
          <InfoGlyph />
        </button>
        <button className="icon-btn" title="Edit tags" onClick={props.onDetails}>
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
      <div
        className="preview-body"
        onTouchStart={(event) => {
          const touch = event.touches[0];
          swipeFrom.current =
            event.touches.length === 1 && touch ? { x: touch.clientX, y: touch.clientY } : null;
        }}
        onTouchEnd={(event) => {
          const from = swipeFrom.current;
          const touch = event.changedTouches[0];
          swipeFrom.current = null;
          // A finger panning a zoomed-in image is not a request to step to
          // the next file: only read it as a swipe once the image is back
          // at rest.
          if (zoom.scale !== 1) {
            return;
          }
          if (!from || !touch) {
            return;
          }
          // Down and decisively vertical closes the viewer, the way every
          // iOS photo viewer hands the picture back. Only for media that
          // does not scroll vertically itself: the same gesture inside a
          // PDF or spreadsheet is just scrolling.
          const dyDown = touch.clientY - from.y;
          if (
            (kind === "image" || kind === "video" || kind === "audio") &&
            dyDown > 80 &&
            dyDown > 2 * Math.abs(touch.clientX - from.x)
          ) {
            props.onClose();
            return;
          }
          if (!onStep) {
            return;
          }
          const direction = swipeStep(touch.clientX - from.x, touch.clientY - from.y);
          if (direction) {
            onStep(direction);
          }
        }}
      >
        {error ? (
          <div className="preview-fallback">{error}</div>
        ) : !loaded ? (
          <div className="spinner" />
        ) : kind === "image" && loaded.url ? (
          <ZoomableImage
            src={loaded.url}
            alt={file.name}
            zoom={zoom}
            onZoomChange={setZoom}
            boxRef={zoomBox}
          />
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
                  if (mediaBridgeAvailable()) {
                    // The shell's native protocol failed; the service
                    // worker path remains as the safety net.
                    diag("playback", `${file.name} native path failed; using the bridge`);
                    el.src = bridgeMediaUrl(file.id);
                    el.load();
                    void el.play().catch(() => {});
                  } else {
                    // No worker in this webview: the last rung is the
                    // whole file, decrypted and played from memory.
                    diag("playback", `${file.name} native path failed; no bridge here`);
                    void playDecryptedWhole(el);
                  }
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
        ) : kind === "pdf" && loaded.pdf && !unreadable ? (
          <PdfBody bytes={loaded.pdf} name={file.name} onUnreadable={() => setUnreadable(true)} />
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
