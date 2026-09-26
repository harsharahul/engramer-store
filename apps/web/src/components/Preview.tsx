import { useEffect, useRef, useState } from "react";
import { useStore, type FileEntry } from "../store";
import { IntegrityError, downloadAndDecrypt } from "../transfer";
import { openSharedContent } from "../openshared";
import { bridgeMediaUrl, mediaBridgeAvailable, mediaUrl, onMediaProgress, registerMediaKey } from "../mediastream";
import { nativeMediaPace, nativeMediaRelease, nativeShell } from "../native";
import { linkStarved } from "../streamhealth";
import { swipeStep } from "../neighbors";
import { extension, fileKind, formatBytes } from "../format";
import type { ExtractedEntry } from "../archive";
import { ArchiveBody } from "./ArchiveBody";
import { displayableImage } from "../intel/heic";
import { saveDecryptedFile } from "../download";
import { offlineExcuse } from "../offlinefiles";
import { thumbnailUrl } from "../thumbs";
import { ZoomableImage } from "./ZoomableImage";
import { parseLinkFile } from "../links";
import { PdfViewer } from "./pdf/PdfViewer";
import { Button, buttonVariants } from "./ui/button";
import { IconButton } from "./ui/icon-button";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { MOBILE_QUERY, useMediaQuery } from "../media";
import { IDENTITY, zoomAt, type Box, type ZoomState } from "../zoom";
import {
  ChevronLeftGlyph,
  ChevronRightGlyph,
  DotsGlyph,
  DownloadGlyph,
  InfoGlyph,
  LinkGlyph,
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
  archive: Uint8Array | null;
}

/**
 * A saved link: what a shared web page became when the share extension
 * could not render it. The address is shown in full and opens in the
 * browser; only web addresses are ever accepted.
 */
function LinkBody(props: { body: string; name: string }) {
  const link = parseLinkFile(props.body, props.name);
  if (!link) {
    return (
      <div className="preview-fallback">
        This link file has no web address in it.
      </div>
    );
  }
  return (
    <div className="link-body">
      <LinkGlyph size={28} />
      <h3>{link.title}</h3>
      <p className="link-url">{link.url}</p>
      <a
        className={buttonVariants({ variant: "secondary" })}
        href={link.url}
        target="_blank"
        rel="noopener noreferrer"
      >
        Open in the browser
      </a>
    </div>
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
  /** PDF markup, forms and page operations write back through these;
   * absent, the document is read only. */
  onSavePdf?: (bytes: Uint8Array) => Promise<void>;
  onSavePdfCopy?: (bytes: Uint8Array, name: string) => Promise<void>;
  /** Extracts an archive's entries into the vault through the upload path. */
  onExtract?: (entries: ExtractedEntry[]) => Promise<void>;
  /** Opens the decrypted file in another app on this Mac. */
  onOpenElsewhere?: () => void;
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
  // The tile's thumbnail, shown at once while the real bytes arrive and
  // as the video's poster frame: the scene appears instantly and
  // sharpens, instead of a blank body or a black rectangle.
  const [thumb, setThumb] = useState<string | null>(null);
  // The link measurably cannot carry this clip; the player offers the
  // pin instead of an endless spinner. Two verdicts in a row required.
  const [starved, setStarved] = useState(false);
  const [adviceDismissed, setAdviceDismissed] = useState(false);
  const starvedOnce = useRef(false);
  const durationRef = useRef<number | null>(null);
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
    setThumb(null);
    if (!file.hasThumb) {
      return;
    }
    let cancelled = false;
    // The cache in thumbs.ts owns the object URL; nothing to revoke here.
    void thumbnailUrl(file.id, file.key).then((url) => {
      if (!cancelled) {
        setThumb(url);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [file.id, file.hasThumb, file.key]);

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
  // Below this, an open finishes before a progress line means anything.
  const OPEN_PROGRESS_FLOOR = 8 * 1024 * 1024;
  const playDecryptedWhole = async (el: HTMLMediaElement) => {
    if (blobTried.current) {
      return;
    }
    blobTried.current = true;
    const excuse = offlineExcuse(navigator.onLine);
    if (excuse) {
      diag("playback", `${file.name} not saved offline and no network`);
      setError(excuse);
      return;
    }
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
        downloadAndDecrypt(entry.id, entry.key, entry.digest, { preferLocal: true }),
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
    setStarved(false);
    setAdviceDismissed(false);
    durationRef.current = null;
    starvedOnce.current = false;
    // Video and audio stream: through the shell's native protocol where
    // there is one, else through the service worker's media bridge. Both
    // decrypt on the fly and answer range requests; nothing buffers whole.
    // The shell qualifies on its own, because the worker does not exist in
    // every webview (iOS), and requiring it here silently benched the
    // native path on exactly the platform that needed it most.
    if ((kind === "video" || kind === "audio") && (nativeShell() || mediaBridgeAvailable())) {
      registerMediaKey(file.id);
      setLoaded({ url: mediaUrl(file.id), text: null, docx: null, sheet: null, pdf: null, archive: null });
      const stopProgress = onMediaProgress(file.id, (done, total) =>
        setProgress(done < total ? { loaded: done, total } : null),
      );
      // The link is judged against the clip: two consecutive windows
      // slower than the clip's own byte rate, and the player offers the
      // pin instead of spinning forever.
      const pacePoll = nativeShell()
        ? window.setInterval(() => {
            void nativeMediaPace(file.id).then((pace) => {
              const verdict = linkStarved(pace, file.size, durationRef.current);
              if (verdict && starvedOnce.current) {
                setStarved(true);
              }
              starvedOnce.current = verdict;
            });
          }, 2500)
        : null;
      return () => {
        if (pacePoll !== null) {
          window.clearInterval(pacePoll);
        }
        // Closing the player hands the whole link to whatever plays
        // next: the shell stops warming and aborts in-flight transfers.
        void nativeMediaRelease(file.id);
        stopProgress();
        if (blobUrl.current) {
          URL.revokeObjectURL(blobUrl.current);
          blobUrl.current = null;
        }
        blobTried.current = false;
      };
    }
    void openSharedContent(file, (entry) =>
      downloadAndDecrypt(entry.id, entry.key, entry.digest, {
        // The shell's offline store answers complete files instantly and
        // with no network; every miss falls through to the server.
        preferLocal: true,
        // Byte progress for the wait, but only when there is a wait:
        // small files open with no ceremony at all.
        onProgress: (done, total) => {
          if (!cancelled && total !== null && total > OPEN_PROGRESS_FLOOR) {
            setProgress({ loaded: done, total });
          }
        },
      }),
    )
      .then((bytes) => {
        if (cancelled) {
          return;
        }
        setProgress(null);
        // Reading it through was the check; record that it passed.
        useStore.getState().markVerified(file.id);
        const empty = { url: null, text: null, docx: null, sheet: null, pdf: null, archive: null };
        if (kind === "text" || kind === "link") {
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
        if (kind === "archive") {
          setLoaded({ ...empty, archive: bytes });
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
          setProgress(null);
          if (err instanceof IntegrityError) {
            // Say what is wrong plainly, mark the file so the library shows
            // it too, and leave the download working: the bytes are all that
            // is left of it and the reader may still rescue something.
            useStore.getState().markCorrupt(file.id);
            setError(err.message);
            return;
          }
          setError(
            offlineExcuse(navigator.onLine) ??
              (err instanceof Error ? err.message : "could not decrypt this file"),
          );
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

  // The phone header keeps what a thumb reaches (Close, the name, Edit)
  // and folds the rest into one menu; stepping is a swipe there. The
  // desktop row has room for every action.
  const phone = useMediaQuery(MOBILE_QUERY);
  const [more, setMore] = useState<{ x: number; y: number } | null>(null);
  const moreItems: MenuItem[] = [
    ...(props.onFavorite
      ? [
          {
            id: "favorite",
            label: file.favorite ? "Remove from favorites" : "Add to favorites",
            icon: <StarGlyph size={14} />,
            run: props.onFavorite,
          },
        ]
      : []),
    { id: "share", label: "Share", icon: <ShareGlyph size={14} />, run: props.onShare },
    { id: "details", label: "Details and tags", icon: <InfoGlyph size={14} />, run: props.onDetails },
    { id: "rename", label: "Rename", icon: <PencilGlyph size={14} />, run: props.onRename },
    { id: "download", label: "Download", icon: <DownloadGlyph size={14} />, run: () => void download() },
  ];

  const download = async () => {
    // One shared path: the shell exports through the share sheet, the
    // browser keeps its anchor, and a failed integrity check still hands
    // the bytes over rather than nothing.
    try {
      await saveDecryptedFile(file);
    } catch (err) {
      props.onToast?.(
        err instanceof Error && err.message ? `Download failed: ${err.message}` : "Download failed.",
      );
    }
  };

  return (
    <div className="preview-shell">
      <div className="preview-top">
        {phone && (
          <IconButton label="Close" onClick={props.onClose}>
            <XGlyph />
          </IconButton>
        )}
        <span className="name">{file.name}</span>
        <span className="meta">{formatBytes(file.size)}</span>
        <div className="grow" />
        {!phone && onStep && (
          <>
            <IconButton
              label="Previous"
              title="Previous (left arrow)"
              disabled={props.canStepBack === false}
              onClick={() => onStep(-1)}
            >
              <ChevronLeftGlyph />
            </IconButton>
            <IconButton
              label="Next"
              title="Next (right arrow)"
              disabled={props.canStepOn === false}
              onClick={() => onStep(1)}
            >
              <ChevronRightGlyph />
            </IconButton>
          </>
        )}
        {props.onEdit && (
          <Button variant="secondary" onClick={props.onEdit}>
            <PencilGlyph size={14} /> Edit
          </Button>
        )}
        {phone ? (
          <IconButton
            label="More"
            aria-haspopup="menu"
            onClick={(event) => {
              const at = event.currentTarget.getBoundingClientRect();
              setMore({ x: at.right, y: at.bottom + 6 });
            }}
          >
            <DotsGlyph />
          </IconButton>
        ) : (
          <>
            {props.onFavorite && (
              <IconButton
                tone={file.favorite ? "accent" : "default"}
                label={file.favorite ? "Remove from favorites" : "Add to favorites"}
                onClick={props.onFavorite}
              >
                <StarGlyph />
              </IconButton>
            )}
            <IconButton label="Share" onClick={props.onShare}>
              <ShareGlyph />
            </IconButton>
            <IconButton label="Details" onClick={props.onDetails}>
              <InfoGlyph />
            </IconButton>
            <IconButton label="Edit tags" onClick={props.onDetails}>
              <TagGlyph />
            </IconButton>
            <IconButton label="Rename" onClick={props.onRename}>
              <PencilGlyph />
            </IconButton>
            <IconButton label="Download" onClick={download}>
              <DownloadGlyph />
            </IconButton>
            <IconButton label="Close" onClick={props.onClose}>
              <XGlyph />
            </IconButton>
          </>
        )}
      </div>
      {more && (
        <ContextMenu
          x={more.x}
          y={more.y}
          title={file.name}
          items={moreItems}
          onClose={() => setMore(null)}
        />
      )}
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
          thumb ? (
            // The scene, at once: the thumbnail shown sharp, declaring the
            // ORIGINAL's intrinsic size and laid out by the same rules as
            // the final image - so the swap changes sharpness and never
            // geometry. The progress pill is what says "arriving".
            <>
              <img
                className="preview-standin"
                src={thumb}
                alt=""
                width={file.width}
                // Width only, ratio via CSS: with BOTH attributes set, a
                // viewport that caps one axis leaves the other axis its
                // full specified size (aspect-ratio:auto needs an auto
                // dimension to engage), yielding a letterboxed oversized
                // box on phones. One specified axis plus an explicit
                // ratio rescales under any cap, exactly like the final
                // image's own natural-size constraint math.
                style={
                  file.width && file.height
                    ? { aspectRatio: `${file.width} / ${file.height}` }
                    : undefined
                }
              />
              {progress && (
                <div className="media-progress">
                  Downloading {formatBytes(progress.loaded)} of {formatBytes(progress.total)}
                </div>
              )}
            </>
          ) : (
            <>
              <div className="spinner" />
              {progress && (
                <div className="media-progress">
                  Downloading {formatBytes(progress.loaded)} of {formatBytes(progress.total)}
                </div>
              )}
            </>
          )
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
              poster={thumb ?? undefined}
              controls
              autoPlay
              onLoadedMetadata={(e) => {
                durationRef.current = e.currentTarget.duration || null;
              }}
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
            {starved && !adviceDismissed && (
              <div className="media-advice">
                <span>
                  Your connection is slower than this video. Keep it offline and watch it
                  when it&apos;s ready?
                </span>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setAdviceDismissed(true);
                    void useStore
                      .getState()
                      .pinOffline(file.id)
                      .then((kept) =>
                        props.onToast?.(
                          kept
                            ? "Saving for offline. The green mark appears when it's ready."
                            : "Could not save this file for offline access.",
                        ),
                      );
                  }}
                >
                  Keep offline
                </Button>
                <IconButton label="Dismiss" onClick={() => setAdviceDismissed(true)}>
                  <XGlyph />
                </IconButton>
              </div>
            )}
          </>
        ) : kind === "audio" && loaded.url ? (
          <audio src={loaded.url} controls autoPlay />
        ) : kind === "pdf" && loaded.pdf && !unreadable ? (
          <PdfViewer
            bytes={loaded.pdf}
            name={file.name}
            onUnreadable={() => setUnreadable(true)}
            onSave={props.onSavePdf}
            onSaveCopy={props.onSavePdfCopy}
            onToast={props.onToast}
          />
        ) : kind === "sheet" && loaded.sheet ? (
          <SheetBody bytes={loaded.sheet} />
        ) : kind === "doc" && loaded.docx ? (
          <DocxBody bytes={loaded.docx} name={file.name} />
        ) : kind === "link" && loaded.text !== null ? (
          <LinkBody body={loaded.text} name={file.name} />
        ) : kind === "archive" && loaded.archive ? (
          <ArchiveBody bytes={loaded.archive} name={file.name} onExtract={props.onExtract} />
        ) : loaded.text !== null ? (
          <pre>{loaded.text}</pre>
        ) : (
          <div className="preview-fallback">
            {kind === "slides"
              ? "Presentations do not open in the app yet."
              : `No preview for ${extension(file.name) ? `.${extension(file.name).toLowerCase()}` : "this kind of"} files.`}
            <br />
            <div className="preview-fallback-actions">
              {props.onOpenElsewhere && (
                <Button variant="secondary" onClick={props.onOpenElsewhere}>
                  Open in another app
                </Button>
              )}
              <Button variant="secondary" onClick={download}>
                <DownloadGlyph /> Download decrypted copy
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
