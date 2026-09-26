import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import type { EventBus, PDFViewer as PdfJsViewer } from "pdfjs-dist/web/pdf_viewer.mjs";
import viewerCss from "pdfjs-dist/web/pdf_viewer.css?inline";
import { diag } from "../../diag";
import { applyPagePlan, extractPages, type PagePlan } from "../../pdf/pages";
import { ensureScopedStylesheet } from "../../pdf/scopedcss";
import { ChevronLeftGlyph, ChevronRightGlyph, PencilGlyph, SearchGlyph, XGlyph } from "../Icon";
import { PdfThumbnails } from "./PdfThumbnails";
import { Button } from "../ui/button";
import { IconButton } from "../ui/icon-button";

/**
 * A PDF the way a reader expects one: every page on demand rather than
 * the first thirty, text you can select and copy, find with a count,
 * zoom modes, a page indicator you can type into, thumbnails and the
 * document's outline, rotation. Markup adds highlight, drawing, text and
 * an image, saved into the document as a new version through the same
 * path every editor uses. Forms fill and save the same way. Pages mode
 * turns, reorders and removes pages, or extracts a few to a new file.
 *
 * pdf.js draws everything itself. A blob URL in an iframe is blank in
 * Safari's web view, which is every desktop shell window and every
 * iPhone, so the engine that already reads text out of PDFs here also
 * shows them, identically everywhere.
 */

export type ZoomChoice = "page-width" | "page-fit" | "auto" | number;

/** The zoom presets the menu offers; the two fits come first. */
export const ZOOM_CHOICES: ZoomChoice[] = ["page-width", "page-fit", 0.5, 0.75, 1, 1.25, 1.5, 2, 3];

export function zoomLabel(choice: ZoomChoice | string): string {
  if (choice === "page-width") return "Fit width";
  if (choice === "page-fit") return "Fit page";
  if (choice === "auto") return "Automatic";
  const number = typeof choice === "number" ? choice : Number(choice);
  return Number.isFinite(number) ? `${Math.round(number * 100)}%` : String(choice);
}

type Mode = "view" | "markup" | "pages";
type Tool = "none" | "highlight" | "ink" | "text" | "image";
type Side = "none" | "thumbnails" | "outline";

interface OutlineItem {
  title: string;
  dest: string | unknown[] | null;
  items: OutlineItem[];
}

interface FindStatus {
  open: boolean;
  query: string;
  current: number;
  total: number;
  /** pdf.js FindState: 0 found, 1 not found, 2 wrapped, 3 pending. */
  state: number | null;
}

/** pdf.js's localisation hook, answered with the fallback strings the
 * viewer already carries; nothing is fetched. */
const englishOnly = {
  getLanguage: () => "en-US",
  getDirection: () => "ltr",
  get: async (_ids: unknown, _args: unknown, fallback: string) => fallback,
  translate: async () => {},
  translateOnce: async () => {},
  destroy: async () => {},
  pause: () => {},
  resume: () => {},
};

export function PdfViewer(props: {
  bytes: Uint8Array;
  name: string;
  onUnreadable: () => void;
  /** Writes the document back as a new version. Absent = read only. */
  onSave?: (bytes: Uint8Array) => Promise<void>;
  /** Writes a new file beside this one (extracted pages). */
  onSaveCopy?: (bytes: Uint8Array, name: string) => Promise<void>;
  onToast?: (message: string) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<PdfJsViewer | null>(null);
  const busRef = useRef<EventBus | null>(null);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [pages, setPages] = useState(0);
  const [page, setPage] = useState(1);
  const [pageDraft, setPageDraft] = useState("1");
  const [zoom, setZoom] = useState<ZoomChoice>("page-width");
  const [rotation, setRotation] = useState(0);
  const [mode, setMode] = useState<Mode>("view");
  const [tool, setTool] = useState<Tool>("none");
  const [side, setSide] = useState<Side>("none");
  const [outline, setOutline] = useState<OutlineItem[] | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [find, setFind] = useState<FindStatus>({ open: false, query: "", current: 0, total: 0, state: null });
  const findInput = useRef<HTMLInputElement>(null);
  // Pages mode: the surviving pages in order and a turn per page,
  // applied in one save.
  const [plan, setPlan] = useState<PagePlan>({ order: [], rotations: {} });
  const [picked, setPicked] = useState<Set<number>>(new Set());

  // ----- load the document and mount pdf.js's viewer -----
  useEffect(() => {
    // pdf.js's stylesheet names generic classes (.sidebar among them);
    // it is confined to this viewer's root so it reaches nothing else.
    ensureScopedStylesheet("pdfjs-viewer", viewerCss, ".pdfv");
    let cancelled = false;
    let loading: { destroy: () => Promise<void> } | null = null;
    let viewer: PdfJsViewer | null = null;
    void (async () => {
      try {
        const pdfjs = await import("pdfjs-dist");
        const workerUrl = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
        pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
        const web = await import("pdfjs-dist/web/pdf_viewer.mjs");
        const task = pdfjs.getDocument({ data: props.bytes.slice() });
        loading = task;
        const document = await task.promise;
        if (cancelled || !container.current) {
          return;
        }
        const eventBus = new web.EventBus();
        const linkService = new web.PDFLinkService({ eventBus });
        const findController = new web.PDFFindController({ eventBus, linkService });
        viewer = new web.PDFViewer({
          container: container.current,
          eventBus,
          linkService,
          findController,
          l10n: englishOnly as never,
          textLayerMode: 1,
          annotationMode: pdfjs.AnnotationMode.ENABLE_FORMS,
          annotationEditorMode: pdfjs.AnnotationEditorType.NONE,
          // Pages larger than this render at a capped resolution instead
          // of failing; a phone's memory is the ceiling that matters.
          maxCanvasPixels: 16_777_216,
        });
        linkService.setViewer(viewer);
        viewerRef.current = viewer;
        busRef.current = eventBus;
        eventBus.on("pagesinit", () => {
          if (viewer) {
            viewer.currentScaleValue = "page-width";
          }
        });
        eventBus.on("pagechanging", (event: { pageNumber: number }) => {
          setPage(event.pageNumber);
          setPageDraft(String(event.pageNumber));
        });
        eventBus.on("scalechanging", (event: { scale: number; presetValue?: string }) => {
          setZoom(
            event.presetValue === "page-width" || event.presetValue === "page-fit" || event.presetValue === "auto"
              ? event.presetValue
              : event.scale,
          );
        });
        eventBus.on("rotationchanging", (event: { pagesRotation: number }) => setRotation(event.pagesRotation));
        eventBus.on(
          "updatefindcontrolstate",
          (event: { state: number; matchesCount: { current: number; total: number } }) => {
            setFind((f) => ({ ...f, state: event.state, current: event.matchesCount.current, total: event.matchesCount.total }));
          },
        );
        eventBus.on("updatefindmatchescount", (event: { matchesCount: { current: number; total: number } }) => {
          setFind((f) => ({ ...f, current: event.matchesCount.current, total: event.matchesCount.total }));
        });
        // Typed as null in pdf.js's declarations; they are the hooks the
        // viewer app itself sets to learn about unsaved changes.
        const storage = document.annotationStorage as unknown as {
          onSetModified: (() => void) | null;
          onResetModified: (() => void) | null;
        };
        storage.onSetModified = () => setDirty(true);
        storage.onResetModified = () => setDirty(false);
        viewer.setDocument(document);
        linkService.setDocument(document, null);
        setPdf(document);
        setPages(document.numPages);
        setPlan({ order: Array.from({ length: document.numPages }, (_, i) => i + 1), rotations: {} });
        void document.getOutline().then((items) => {
          if (!cancelled) {
            setOutline((items as OutlineItem[] | null) ?? []);
          }
        });
      } catch (err) {
        // Not every file named .pdf is one: a page saved by a browser, a
        // truncated download, something a share sheet mislabelled.
        diag("preview", `pdf open failed: ${err instanceof Error ? err.message : "unknown"}`);
        if (!cancelled) {
          props.onUnreadable();
        }
      }
    })();
    return () => {
      cancelled = true;
      viewer?.cleanup();
      viewerRef.current = null;
      busRef.current = null;
      void loading?.destroy();
    };
    // The bytes identify the document; the callbacks are read at call time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.bytes]);

  // ----- toolbar actions -----
  const goTo = useCallback(
    (number: number) => {
      const viewer = viewerRef.current;
      if (viewer && number >= 1 && number <= pages) {
        viewer.currentPageNumber = number;
      }
    },
    [pages],
  );

  const applyZoom = (choice: ZoomChoice) => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    viewer.currentScaleValue = String(choice);
    setZoom(choice);
  };

  const zoomBy = (factor: number) => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const next = Math.min(4, Math.max(0.25, viewer.currentScale * factor));
    viewer.currentScaleValue = String(Math.round(next * 100) / 100);
  };

  const rotateView = () => {
    const viewer = viewerRef.current;
    if (viewer) {
      viewer.pagesRotation = (viewer.pagesRotation + 90) % 360;
    }
  };

  const setEditorTool = async (next: Tool) => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const pdfjs = await import("pdfjs-dist");
    const modes: Record<Tool, number> = {
      none: pdfjs.AnnotationEditorType.NONE,
      highlight: pdfjs.AnnotationEditorType.HIGHLIGHT,
      ink: pdfjs.AnnotationEditorType.INK,
      text: pdfjs.AnnotationEditorType.FREETEXT,
      image: pdfjs.AnnotationEditorType.STAMP,
    };
    viewer.annotationEditorMode = { mode: modes[next] };
    setTool(next);
  };

  const enterMode = async (next: Mode) => {
    if (next !== "markup") {
      await setEditorTool("none");
    }
    setMode(next);
    if (next === "pages") {
      setSide("none");
    }
  };

  const runFind = (query: string, again = false, previous = false) => {
    busRef.current?.dispatch("find", {
      source: null,
      type: again ? "again" : "",
      query,
      caseSensitive: false,
      entireWord: false,
      highlightAll: true,
      findPrevious: previous,
      matchDiacritics: false,
    });
  };

  const openFind = () => {
    setFind((f) => ({ ...f, open: true }));
    setTimeout(() => findInput.current?.focus(), 0);
  };

  const closeFind = () => {
    setFind({ open: false, query: "", current: 0, total: 0, state: null });
    // An empty query clears the highlights.
    runFind("");
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        openFind();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const save = async () => {
    const document = pdf;
    if (!document || !props.onSave) return;
    setSaving(true);
    try {
      // Leaving the tool commits any editor still open.
      await setEditorTool("none");
      const bytes = await document.saveDocument();
      await props.onSave(bytes);
      document.annotationStorage.resetModified();
      setDirty(false);
      props.onToast?.("Saved as a new version.");
    } catch (err) {
      props.onToast?.(err instanceof Error && err.message ? `Could not save: ${err.message}` : "Could not save.");
    } finally {
      setSaving(false);
    }
  };

  // ----- pages mode -----
  const planTouched = useMemo(
    () =>
      plan.order.length !== pages ||
      plan.order.some((n, i) => n !== i + 1) ||
      Object.values(plan.rotations).some((turn) => turn % 360 !== 0),
    [plan, pages],
  );

  const togglePick = (number: number) =>
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(number)) {
        next.delete(number);
      } else {
        next.add(number);
      }
      return next;
    });

  const turnPicked = () =>
    setPlan((current) => {
      const rotations = { ...current.rotations };
      for (const number of picked) {
        rotations[number] = ((rotations[number] ?? 0) + 90) % 360;
      }
      return { ...current, rotations };
    });

  const removePicked = () => {
    const order = plan.order.filter((n) => !picked.has(n));
    if (order.length === 0) {
      props.onToast?.("A document keeps at least one page.");
      return;
    }
    setPlan((current) => ({ ...current, order }));
    // The removed pages are no longer there to be selected.
    setPicked(new Set());
  };

  const movePicked = (by: -1 | 1) =>
    setPlan((current) => {
      const order = [...current.order];
      const positions = order.map((n, i) => (picked.has(n) ? i : -1)).filter((i) => i >= 0);
      const walk = by < 0 ? positions : [...positions].reverse();
      for (const i of walk) {
        const j = i + by;
        if (j < 0 || j >= order.length || picked.has(order[j]!)) continue;
        [order[i], order[j]] = [order[j]!, order[i]!];
      }
      return { ...current, order };
    });

  const applyPlan = async () => {
    if (!props.onSave) return;
    setSaving(true);
    try {
      const bytes = await applyPagePlan(props.bytes, plan);
      await props.onSave(bytes);
      props.onToast?.("Pages saved as a new version.");
      setPicked(new Set());
    } catch (err) {
      props.onToast?.(err instanceof Error && err.message ? `Could not save: ${err.message}` : "Could not save.");
    } finally {
      setSaving(false);
    }
  };

  const extractPicked = async () => {
    if (!props.onSaveCopy || picked.size === 0) return;
    setSaving(true);
    try {
      const numbers = [...picked].sort((a, b) => a - b);
      const bytes = await extractPages(props.bytes, numbers);
      const base = props.name.replace(/\.pdf$/i, "");
      const label = numbers.length === 1 ? `page ${numbers[0]}` : `pages ${numbers.join(", ")}`;
      await props.onSaveCopy(bytes, `${base} (${label}).pdf`);
      setPicked(new Set());
    } catch (err) {
      props.onToast?.(err instanceof Error && err.message ? `Could not extract: ${err.message}` : "Could not extract.");
    } finally {
      setSaving(false);
    }
  };

  const canEdit = Boolean(props.onSave);

  return (
    <div className={`pdfv pdfv-${mode}${side !== "none" ? " pdfv-with-side" : ""}`}>
      <div className="pdfv-toolbar" role="toolbar" aria-label="PDF">
        <div className="pdfv-group">
          <Button
            variant="ghost"
            size="sm"
            aria-label="Thumbnails"
            aria-pressed={side === "thumbnails"}
            onClick={() => setSide(side === "thumbnails" ? "none" : "thumbnails")}
          >
            Pages
          </Button>
          {outline && outline.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              aria-label="Outline"
              aria-pressed={side === "outline"}
              onClick={() => setSide(side === "outline" ? "none" : "outline")}
            >
              Outline
            </Button>
          )}
        </div>
        <div className="pdfv-group pdfv-nav">
          <IconButton label="Previous page" disabled={page <= 1} onClick={() => goTo(page - 1)}>
            <ChevronLeftGlyph size={14} />
          </IconButton>
          <form
            className="pdfv-page"
            onSubmit={(event) => {
              event.preventDefault();
              const wanted = Number(pageDraft);
              if (Number.isInteger(wanted)) {
                goTo(wanted);
              } else {
                setPageDraft(String(page));
              }
            }}
          >
            <input
              aria-label="Page number"
              value={pageDraft}
              inputMode="numeric"
              onChange={(event) => setPageDraft(event.target.value)}
              onBlur={() => setPageDraft(String(page))}
            />
            <span>of {pages || "…"}</span>
          </form>
          <IconButton label="Next page" disabled={page >= pages} onClick={() => goTo(page + 1)}>
            <ChevronRightGlyph size={14} />
          </IconButton>
        </div>
        <div className="pdfv-group">
          <IconButton label="Zoom out" onClick={() => zoomBy(1 / 1.2)}>
            <span className="pdfv-word">−</span>
          </IconButton>
          <select
            className="pdfv-zoom"
            aria-label="Zoom"
            value={typeof zoom === "number" ? String(Math.round(zoom * 100) / 100) : zoom}
            onChange={(event) => {
              const raw = event.target.value;
              applyZoom(raw === "page-width" || raw === "page-fit" || raw === "auto" ? raw : Number(raw));
            }}
          >
            {(typeof zoom === "number" && !ZOOM_CHOICES.includes(zoom) ? [...ZOOM_CHOICES, zoom] : ZOOM_CHOICES).map(
              (choice) => (
                <option key={String(choice)} value={typeof choice === "number" ? String(Math.round(choice * 100) / 100) : choice}>
                  {zoomLabel(choice)}
                </option>
              ),
            )}
          </select>
          <IconButton label="Zoom in" onClick={() => zoomBy(1.2)}>
            <span className="pdfv-word">+</span>
          </IconButton>
          <Button variant="ghost" size="sm" title={`Rotate view (${rotation}°)`} onClick={rotateView}>
            Rotate
          </Button>
        </div>
        <div className="grow" />
        <div className="pdfv-group">
          <IconButton
            label="Find"
            title="Find in document (⌘F)"
            aria-pressed={find.open}
            onClick={() => (find.open ? closeFind() : openFind())}
          >
            <SearchGlyph size={14} />
          </IconButton>
          {canEdit && (
            <>
              <Button
                variant="ghost"
                aria-pressed={mode === "markup"}
                title="Highlight, draw, add text or an image"
                onClick={() => void enterMode(mode === "markup" ? "view" : "markup")}
              >
                <PencilGlyph size={13} /> Markup
              </Button>
              <Button
                variant="ghost"
                aria-pressed={mode === "pages"}
                title="Turn, reorder, remove or extract pages"
                onClick={() => void enterMode(mode === "pages" ? "view" : "pages")}
              >
                Pages
              </Button>
            </>
          )}
          {canEdit && (dirty || (mode === "pages" && planTouched)) && (
            <Button variant="secondary" disabled={saving} onClick={() => void (mode === "pages" ? applyPlan() : save())}>
              {saving ? "Saving…" : "Save"}
            </Button>
          )}
        </div>
      </div>

      {find.open && (
        <div className="pdfv-find" role="search">
          <SearchGlyph size={13} />
          <input
            ref={findInput}
            value={find.query}
            placeholder="Find in document"
            onChange={(event) => {
              const query = event.target.value;
              setFind((f) => ({ ...f, query }));
              runFind(query);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                runFind(find.query, true, event.shiftKey);
              } else if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                closeFind();
              }
            }}
          />
          <span className="pdfv-find-count">
            {find.query
              ? find.state === 1
                ? "No matches"
                : find.total > 0
                  ? `${find.current} of ${find.total}`
                  : find.state === 3
                    ? "Searching…"
                    : ""
              : ""}
          </span>
          <IconButton label="Previous match" onClick={() => runFind(find.query, true, true)} disabled={!find.query}>
            <ChevronLeftGlyph size={13} />
          </IconButton>
          <IconButton label="Next match" onClick={() => runFind(find.query, true, false)} disabled={!find.query}>
            <ChevronRightGlyph size={13} />
          </IconButton>
          <IconButton label="Close" onClick={closeFind}>
            <XGlyph size={13} />
          </IconButton>
        </div>
      )}

      {mode === "markup" && (
        <div className="pdfv-tools" role="toolbar" aria-label="Markup tools">
          {(
            [
              ["highlight", "Highlight"],
              ["ink", "Draw"],
              ["text", "Text"],
              ["image", "Image"],
            ] as Array<[Tool, string]>
          ).map(([id, label]) => (
            <Button
              key={id}
              variant="ghost"
              aria-pressed={tool === id}
              onClick={() => void setEditorTool(tool === id ? "none" : id)}
            >
              {label}
            </Button>
          ))}
          <span className="pdfv-hint">
            {tool === "none"
              ? "Choose a tool, then work on the page. Saving writes a new version."
              : tool === "highlight"
                ? "Select text to highlight it."
                : tool === "ink"
                  ? "Draw on the page."
                  : tool === "text"
                    ? "Click where the text goes."
                    : "Click where the image goes, then choose a file."}
          </span>
        </div>
      )}

      {mode === "pages" && (
        <div className="pdfv-tools" role="toolbar" aria-label="Page tools">
          <span className="pdfv-hint">{picked.size === 0 ? "Select pages below." : `${picked.size} selected`}</span>
          <Button variant="ghost" disabled={picked.size === 0} onClick={turnPicked}>
            Turn
          </Button>
          <Button variant="ghost" disabled={picked.size === 0} onClick={() => movePicked(-1)}>
            Move up
          </Button>
          <Button variant="ghost" disabled={picked.size === 0} onClick={() => movePicked(1)}>
            Move down
          </Button>
          <Button variant="ghost" className="danger" disabled={picked.size === 0} onClick={removePicked}>
            Remove
          </Button>
          {props.onSaveCopy && (
            <Button variant="ghost" disabled={picked.size === 0 || saving} onClick={() => void extractPicked()}>
              Extract to a new file
            </Button>
          )}
        </div>
      )}

      <div className="pdfv-body">
        {side !== "none" && mode !== "pages" && (
          <aside className="pdfv-side">
            {side === "thumbnails" && pdf && (
              <PdfThumbnails pdf={pdf} current={page} onPick={goTo} />
            )}
            {side === "outline" && outline && (
              <OutlineList items={outline} onPick={(dest) => void viewerRef.current?.linkService.goToDestination(dest as never)} />
            )}
          </aside>
        )}
        {mode === "pages" && pdf && (
          <PdfThumbnails
            pdf={pdf}
            current={page}
            order={plan.order}
            rotations={plan.rotations}
            picked={picked}
            onPick={togglePick}
            large
          />
        )}
        {/* pdf.js owns everything inside: it requires an absolutely
            positioned, scrolling container with the viewer div as its
            first child, so the stage supplies the box it fills. */}
        <div className={`pdfv-stage${mode === "pages" ? " pdfv-hidden" : ""}`}>
          <div className="pdfv-container" ref={container}>
            <div className="pdfViewer" />
          </div>
        </div>
      </div>
    </div>
  );
}

function OutlineList(props: { items: OutlineItem[]; onPick: (dest: string | unknown[]) => void; depth?: number }) {
  const depth = props.depth ?? 0;
  return (
    <ul className="pdfv-outline" style={{ paddingLeft: depth * 12 }}>
      {props.items.map((item, index) => (
        <li key={`${depth}-${index}`}>
          <button className="linky" disabled={!item.dest} onClick={() => item.dest && props.onPick(item.dest)}>
            {item.title || "Untitled"}
          </button>
          {item.items.length > 0 && <OutlineList items={item.items} onPick={props.onPick} depth={depth + 1} />}
        </li>
      ))}
    </ul>
  );
}
