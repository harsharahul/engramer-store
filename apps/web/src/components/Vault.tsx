import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
} from "react";
import { useStore, type FileEntry, type FolderEntry } from "../store";
import {
  ACCENTS,
  applyAccent,
  applyTheme,
  currentAccent,
  currentTheme,
  type ThemeMode,
} from "../theme";
import { searchFiles, highlightParts, type SearchHit } from "../search";
import { ocrEnabled, setOcrEnabled } from "../intel/ocr";
import { thumbnailUrl } from "../thumbs";
import { extension, fileKind, formatBytes, formatDate } from "../format";
import { saveDecryptedFile } from "../download";
import { clearThumbnailCache } from "../thumbs";
import { FileCard, FolderCard } from "./FileCard";
import { BrandMark, FolderArt, Wordmark } from "./FileArt";
import { FileList, sortFiles, type SortKey, type SortState } from "./FileList";
import { DetailsPanel } from "./DetailsPanel";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { MoveDialog } from "./MoveDialog";
import { Preview } from "./Preview";
import { Editor } from "./Editor";

// The Word editor is heavy (SuperDoc); it loads only when a .docx is opened.
const DocEditor = lazy(() =>
  import("./DocEditor").then((m) => ({ default: m.DocEditor })),
);
import { ShareDialog } from "./ShareDialog";
import { SharedView, NewRequestDialog } from "./SharedView";
import { TwoFactorDialog } from "./TwoFactorDialog";
import { UploadTray } from "./UploadTray";
import { CommandPalette, type PaletteAction } from "./CommandPalette";
import { Confirm, TextPrompt } from "./Dialogs";
import {
  AsteriskGlyph,
  AudioGlyph,
  BookGlyph,
  BoxGlyph,
  ClockGlyph,
  CodeGlyph,
  DocGlyph,
  DownloadGlyph,
  EaselGlyph,
  FolderGlyph,
  GridGlyph,
  InboxGlyph,
  InfoGlyph,
  KeyGlyph,
  Keyhole,
  LayoutGridGlyph,
  LayoutListGlyph,
  LinkGlyph,
  LockGlyph,
  MonitorGlyph,
  MoonGlyph,
  MoveGlyph,
  NoteGlyph,
  PencilGlyph,
  PenNibGlyph,
  PhotoGlyph,
  PlusGlyph,
  ReceiptGlyph,
  RestoreGlyph,
  ScanTextGlyph,
  SearchGlyph,
  ShareGlyph,
  SparkGlyph,
  StarGlyph,
  SunGlyph,
  TagGlyph,
  TrashGlyph,
  UploadGlyph,
  VideoGlyph,
  XGlyph,
} from "./Icon";

type View =
  | { kind: "folder"; id: string | null }
  | { kind: "recent" }
  | { kind: "trash" }
  | { kind: "favorites" }
  | { kind: "shared" }
  | { kind: "category"; name: string };

const CATEGORY_ORDER = [
  "Photos", "Screenshots", "Documents", "Receipts", "Notes", "Code", "Videos",
  "Audio", "Spreadsheets", "Presentations", "Design", "Archives", "Books", "Other",
];

const CATEGORY_ICONS: Record<string, (props: { size?: number }) => React.ReactNode> = {
  Photos: PhotoGlyph,
  Screenshots: MonitorGlyph,
  Videos: VideoGlyph,
  Audio: AudioGlyph,
  Documents: DocGlyph,
  Receipts: ReceiptGlyph,
  Notes: NoteGlyph,
  Code: CodeGlyph,
  Spreadsheets: GridGlyph,
  Presentations: EaselGlyph,
  Design: PenNibGlyph,
  Archives: BoxGlyph,
  Books: BookGlyph,
  Other: AsteriskGlyph,
};

const DRAG_TYPE = "application/x-engramer-files";

function loadPref<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

const RECENT_SEARCHES_KEY = "engram-recent-searches";

function loadRecentSearches(): string[] {
  return loadPref<string[]>(RECENT_SEARCHES_KEY, []);
}

function rememberSearch(query: string): string[] {
  const trimmed = query.trim();
  const next = [trimmed, ...loadRecentSearches().filter((q) => q !== trimmed)].slice(0, 6);
  try {
    localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(next));
  } catch {
    // Best-effort.
  }
  return next;
}

/** "Work / Taxes 2025" for a file, walking up the folder tree. */
function folderPath(
  folderId: string | null,
  folders: ReadonlyMap<string, FolderEntry>,
): string | null {
  const names: string[] = [];
  let cursor = folderId;
  let guard = 0;
  while (cursor && guard < 32) {
    const folder = folders.get(cursor);
    if (!folder) {
      break;
    }
    names.unshift(folder.name);
    cursor = folder.parentId;
    guard++;
  }
  return names.length > 0 ? names.join(" / ") : null;
}

const OPERATOR_HINTS = ["tag:", "type:", "in:", "before:", "after:", "is:favorite"];

export function Vault() {
  const store = useStore();
  const [view, setView] = useState<View>({ kind: "folder", id: null });
  const [query, setQuery] = useState("");
  const [layout, setLayout] = useState<"grid" | "list">(() => loadPref("engramer-layout", "grid"));
  const [sort, setSort] = useState<SortState>(() => loadPref("engramer-sort", { key: "name", dir: 1 }));
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set());
  const [detailsOpen, setDetailsOpen] = useState(() => loadPref("engramer-details", true));
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [moveIds, setMoveIds] = useState<string[] | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [editorId, setEditorId] = useState<string | null>(null);
  const [newNoteOpen, setNewNoteOpen] = useState(false);
  const [shareId, setShareId] = useState<string | null>(null);
  const [renameFileId, setRenameFileId] = useState<string | null>(null);
  const [renameFolderId, setRenameFolderId] = useState<string | null>(null);
  const [deleteFolderId, setDeleteFolderId] = useState<string | null>(null);
  const [deleteForeverId, setDeleteForeverId] = useState<string | null>(null);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [requestFolder, setRequestFolder] = useState<{ folderId: string | null } | null>(null);
  const [securityOpen, setSecurityOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [theme, setTheme] = useState<ThemeMode>(() => currentTheme());
  const [accent, setAccent] = useState<string>(() => currentAccent());
  const [searchFocused, setSearchFocused] = useState(false);
  const [searchCursor, setSearchCursor] = useState(0);
  const [recentSearches, setRecentSearches] = useState<string[]>(() => loadRecentSearches());
  const [ocrOn, setOcrOn] = useState(() => ocrEnabled());
  const dragDepth = useRef(0);
  const lastSelected = useRef<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const persist = (key: string, value: unknown) => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Preference persistence is best-effort.
    }
  };

  const showToast = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current) {
      clearTimeout(toastTimer.current);
    }
    toastTimer.current = setTimeout(() => setToast(null), 3200);
  }, []);

  const currentFolderId = view.kind === "folder" ? view.id : null;
  const searching = query.trim().length > 0;

  const liveFiles = useMemo(
    () => [...store.files.values()].filter((f) => !f.trashed),
    [store.files],
  );

  const categoryCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const file of liveFiles) {
      const category = file.category ?? "Other";
      counts.set(category, (counts.get(category) ?? 0) + 1);
    }
    return counts;
  }, [liveFiles]);

  const breadcrumbs = useMemo(() => {
    const chain: Array<{ id: string; name: string }> = [];
    let cursor = currentFolderId;
    while (cursor) {
      const folder = store.folders.get(cursor);
      if (!folder) {
        break;
      }
      chain.unshift({ id: folder.id, name: folder.name });
      cursor = folder.parentId;
    }
    return chain;
  }, [currentFolderId, store.folders]);

  const folderCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const file of liveFiles) {
      if (file.folderId) {
        counts.set(file.folderId, (counts.get(file.folderId) ?? 0) + 1);
      }
    }
    for (const folder of store.folders.values()) {
      if (folder.parentId) {
        counts.set(folder.parentId, (counts.get(folder.parentId) ?? 0) + 1);
      }
    }
    return counts;
  }, [liveFiles, store.folders]);

  const childFolders = useMemo(
    () =>
      [...store.folders.values()]
        .filter((f) => f.parentId === currentFolderId)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [store.folders, currentFolderId],
  );

  // The file list the current view shows, in display order.
  const viewFiles = useMemo(() => {
    let files: FileEntry[];
    switch (view.kind) {
      case "recent":
        return [...liveFiles].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 60);
      case "shared":
        return [];
      case "favorites":
        files = liveFiles.filter((f) => f.favorite);
        break;
      case "category":
        files = liveFiles.filter((f) => (f.category ?? "Other") === view.name);
        break;
      case "trash":
        return [...store.files.values()]
          .filter((f) => f.trashed)
          .sort((a, b) => b.updatedAt - a.updatedAt);
      default:
        files = liveFiles.filter((f) => f.folderId === currentFolderId);
    }
    return sortFiles(files, sort);
  }, [view, liveFiles, store.files, currentFolderId, sort]);

  const hits = useMemo(
    () => (searching ? searchFiles(store.files.values(), query, store.folders) : []),
    [store.files, store.folders, query, searching],
  );

  const visibleFiles = searching ? hits.map((h) => h.file) : viewFiles;

  const previewFile = previewId ? store.files.get(previewId) : undefined;
  const editorFile = editorId ? store.files.get(editorId) : undefined;
  const shareFile = shareId ? store.files.get(shareId) : undefined;
  const renameFile = renameFileId ? store.files.get(renameFileId) : undefined;
  const renameFolder = renameFolderId ? store.folders.get(renameFolderId) : undefined;
  const selectedFile =
    selection.size === 1 ? (store.files.get([...selection][0]!) ?? null) : null;
  const freshIds = useMemo(
    () => new Set(store.reveal?.items.map((item) => item.fileId) ?? []),
    [store.reveal],
  );

  // ----- selection -----

  const select = useCallback(
    (id: string, event: React.MouseEvent) => {
      setSelection((prev) => {
        if (event.metaKey || event.ctrlKey) {
          const next = new Set(prev);
          if (next.has(id)) {
            next.delete(id);
          } else {
            next.add(id);
          }
          lastSelected.current = id;
          return next;
        }
        if (event.shiftKey && lastSelected.current) {
          const order = visibleFiles.map((f) => f.id);
          const from = order.indexOf(lastSelected.current);
          const to = order.indexOf(id);
          if (from >= 0 && to >= 0) {
            const [lo, hi] = from < to ? [from, to] : [to, from];
            return new Set(order.slice(lo, hi + 1));
          }
        }
        lastSelected.current = id;
        return new Set([id]);
      });
    },
    [visibleFiles],
  );

  const clearSelection = useCallback(() => {
    setSelection(new Set());
    lastSelected.current = null;
  }, []);

  useEffect(() => clearSelection(), [view, query, clearSelection]);
  useEffect(() => setSearchCursor(0), [query]);

  // ----- actions -----

  const download = (file: FileEntry) => {
    void saveDecryptedFile(file).catch(() => showToast("Download failed."));
  };

  const openFile = (id: string) => {
    if (query.trim()) {
      setRecentSearches(rememberSearch(query));
    }
    setPreviewId(id);
    setQuery("");
  };

  const searchTag = (tag: string) => {
    setQuery(`tag:${tag}`);
    searchInput.current?.focus();
  };

  const inspect = (id: string) => {
    setSelection(new Set([id]));
    lastSelected.current = id;
    setDetailsOpen(true);
    persist("engramer-details", true);
  };

  const uploadTo = useCallback(
    (files: File[]) => {
      if (files.length > 0) {
        void store.uploadFiles(files, currentFolderId);
      }
    },
    [store, currentFolderId],
  );

  const fileMenuItems = (file: FileEntry): MenuItem[] => [
    { id: "open", label: "Open", run: () => openFile(file.id) },
    ...(["text", "doc"].includes(fileKind(file.mime, file.name))
      ? [{ id: "edit", label: "Edit", icon: <PencilGlyph size={13} />, run: () => setEditorId(file.id) }]
      : []),
    ...(file.mime.startsWith("image/") && file.text === undefined
      ? [
          {
            id: "ocr",
            label: "Read text in image",
            icon: <ScanTextGlyph size={13} />,
            run: () => {
              showToast("Reading text on this device…");
              void store
                .recognizeFile(file.id)
                .then((found) =>
                  showToast(found ? "Text found. This image is searchable now." : "No text found in this image."),
                )
                .catch(() => showToast("Could not read this image."));
            },
          },
        ]
      : []),
    { id: "download", label: "Download", icon: <DownloadGlyph size={13} />, run: () => download(file) },
    { id: "share", label: "Share", icon: <ShareGlyph size={13} />, run: () => setShareId(file.id) },
    { id: "d1", label: "", divider: true, run: () => {} },
    {
      id: "favorite",
      label: file.favorite ? "Remove favorite" : "Add to favorites",
      icon: <StarGlyph size={13} filled={file.favorite} />,
      run: () => void store.toggleFavorite(file.id),
    },
    { id: "tags", label: "Tags and details", icon: <TagGlyph size={13} />, run: () => inspect(file.id) },
    { id: "rename", label: "Rename", icon: <PencilGlyph size={13} />, run: () => setRenameFileId(file.id) },
    {
      id: "move",
      label: "Move to…",
      icon: <MoveGlyph size={13} />,
      run: () => setMoveIds(selection.has(file.id) && selection.size > 1 ? [...selection] : [file.id]),
    },
    { id: "d2", label: "", divider: true, run: () => {} },
    {
      id: "trash",
      label: "Move to trash",
      icon: <TrashGlyph size={13} />,
      danger: true,
      run: () => {
        void store.trashFile(file.id);
        clearSelection();
      },
    },
  ];

  const openFileMenu = (id: string, event: React.MouseEvent) => {
    event.preventDefault();
    const file = store.files.get(id);
    if (!file) {
      return;
    }
    if (!selection.has(id)) {
      setSelection(new Set([id]));
      lastSelected.current = id;
    }
    setCtxMenu({ x: event.clientX, y: event.clientY, items: fileMenuItems(file) });
  };

  const openFolderMenu = (folderId: string, event: React.MouseEvent) => {
    event.preventDefault();
    setCtxMenu({
      x: event.clientX,
      y: event.clientY,
      items: [
        { id: "open", label: "Open", run: () => setView({ kind: "folder", id: folderId }) },
        { id: "rename", label: "Rename", icon: <PencilGlyph size={13} />, run: () => setRenameFolderId(folderId) },
        {
          id: "request",
          label: "Request files here…",
          icon: <InboxGlyph size={13} />,
          run: () => setRequestFolder({ folderId }),
        },
        { id: "d", label: "", divider: true, run: () => {} },
        {
          id: "delete",
          label: "Delete folder",
          icon: <TrashGlyph size={13} />,
          danger: true,
          run: () => setDeleteFolderId(folderId),
        },
      ],
    });
  };

  const startFileDrag = (id: string, event: React.DragEvent) => {
    const ids = selection.has(id) ? [...selection] : [id];
    event.dataTransfer.setData(DRAG_TYPE, JSON.stringify(ids));
    event.dataTransfer.effectAllowed = "move";
  };

  const dropOnFolder = (folderId: string | null, event: React.DragEvent) => {
    try {
      const ids = JSON.parse(event.dataTransfer.getData(DRAG_TYPE)) as string[];
      void (async () => {
        for (const id of ids) {
          await store.moveFile(id, folderId);
        }
        showToast(`Moved ${ids.length} item${ids.length === 1 ? "" : "s"}`);
        clearSelection();
      })();
    } catch {
      // Not an internal drag.
    }
  };

  // ----- global keys and paste -----

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const typing =
        event.target instanceof HTMLElement &&
        (event.target.tagName === "INPUT" || event.target.tagName === "TEXTAREA");
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen(true);
      } else if (event.key === "/" && !typing && !paletteOpen) {
        event.preventDefault();
        searchInput.current?.focus();
      } else if (event.key === "Escape" && !typing && selection.size > 0 && !previewId && !editorId && !ctxMenu) {
        clearSelection();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [paletteOpen, selection, previewId, editorId, ctxMenu, clearSelection]);

  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const target = event.target;
      if (target instanceof HTMLElement && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) {
        return;
      }
      const files = [...(event.clipboardData?.files ?? [])];
      if (files.length > 0) {
        event.preventDefault();
        uploadTo(files);
        showToast(`Encrypting ${files.length} pasted item${files.length > 1 ? "s" : ""}`);
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [uploadTo, showToast]);

  const onOsDrop = (event: DragEvent) => {
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    uploadTo([...event.dataTransfer.files]);
  };

  const lock = () => {
    clearThumbnailCache();
    store.logout();
  };

  const paletteActions = useMemo<PaletteAction[]>(
    () => [
      { id: "upload", label: "Upload files", hint: "encrypt and store", run: () => fileInput.current?.click() },
      { id: "new-note", label: "New note", hint: "write, encrypted", run: () => setNewNoteOpen(true) },
      { id: "new-folder", label: "New folder", run: () => setNewFolderOpen(true) },
      { id: "toggle-layout", label: "Toggle grid and list", run: () => toggleLayout() },
      {
        id: "request-files",
        label: "Request files…",
        hint: "receive, encrypted to you",
        run: () => setRequestFolder({ folderId: null }),
      },
      {
        id: "ocr-all",
        label: "Make images searchable",
        hint: "on-device OCR",
        run: () => {
          if (!ocrEnabled()) {
            setOcrEnabled(true);
            setOcrOn(true);
          }
          void store.recognizeAllImages().then((found) => {
            showToast(
              found > 0
                ? `Read text in ${found} image${found === 1 ? "" : "s"}. They are searchable now.`
                : "No new text found in your images.",
            );
          });
        },
      },
      { id: "go-files", label: "Go to All files", run: () => setView({ kind: "folder", id: null }) },
      { id: "go-recent", label: "Go to Recent", run: () => setView({ kind: "recent" }) },
      { id: "go-favorites", label: "Go to Favorites", run: () => setView({ kind: "favorites" }) },
      { id: "go-shared", label: "Go to Shared", run: () => setView({ kind: "shared" }) },
      { id: "go-trash", label: "Go to Trash", run: () => setView({ kind: "trash" }) },
      { id: "lock", label: "Lock vault and sign out", run: lock },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const toggleLayout = () => {
    setLayout((prev) => {
      const next = prev === "grid" ? "list" : "grid";
      persist("engramer-layout", next);
      return next;
    });
  };

  const onSort = (key: SortKey) => {
    setSort((prev) => {
      const next: SortState =
        prev.key === key ? { key, dir: prev.dir === 1 ? -1 : 1 } : { key, dir: key === "name" ? 1 : -1 };
      persist("engramer-sort", next);
      return next;
    });
  };

  const usagePercent = store.usage
    ? Math.min(100, Math.round((store.usage.usedBytes / store.usage.quotaBytes) * 100))
    : 0;

  const libraryCategories = CATEGORY_ORDER.filter((c) => (categoryCounts.get(c) ?? 0) > 0);

  const viewTitle = searching
    ? `${hits.length} result${hits.length === 1 ? "" : "s"}`
    : view.kind === "folder"
      ? (breadcrumbs[breadcrumbs.length - 1]?.name ?? "All files")
      : view.kind === "category"
        ? view.name
        : view.kind === "recent"
          ? "Recent"
          : view.kind === "favorites"
            ? "Favorites"
            : view.kind === "shared"
              ? "Shared"
              : "Trash";

  const showViewControls = !searching && view.kind !== "trash" && view.kind !== "shared";

  const navButton = (
    active: boolean,
    onClick: () => void,
    icon: React.ReactNode,
    label: string,
    count?: number,
  ) => (
    <button
      className={`nav-item${active && !searching ? " active" : ""}`}
      onClick={() => {
        setQuery("");
        onClick();
      }}
    >
      {icon} {label}
      {count !== undefined && count > 0 && <span className="nav-count">{count}</span>}
    </button>
  );

  return (
    <div
      className={`frame${dragging ? " dropzone-active" : ""}${detailsOpen ? " with-details" : ""}`}
      onDragEnter={(e) => {
        if (e.dataTransfer.types.includes("Files") && !e.dataTransfer.types.includes(DRAG_TYPE)) {
          e.preventDefault();
          dragDepth.current += 1;
          setDragging(true);
        }
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) {
          setDragging(false);
        }
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={onOsDrop}
    >
      <aside className="sidebar">
        <div className="brand">
          <BrandMark size={26} />
          <Wordmark />
        </div>
        {navButton(view.kind === "folder", () => setView({ kind: "folder", id: null }), <FolderGlyph />, "Files")}
        {navButton(view.kind === "recent", () => setView({ kind: "recent" }), <ClockGlyph />, "Recent")}
        {navButton(
          view.kind === "favorites",
          () => setView({ kind: "favorites" }),
          <StarGlyph />,
          "Favorites",
          liveFiles.filter((f) => f.favorite).length,
        )}
        {navButton(view.kind === "shared", () => setView({ kind: "shared" }), <LinkGlyph />, "Shared")}
        {navButton(view.kind === "trash", () => setView({ kind: "trash" }), <TrashGlyph />, "Trash")}

        {libraryCategories.length > 0 && (
          <>
            <div className="sidebar-label">
              <SparkGlyph size={12} /> Library
            </div>
            <div className="library-list">
              {libraryCategories.map((name) => {
                const CategoryIcon = CATEGORY_ICONS[name] ?? AsteriskGlyph;
                return (
                  <button
                    key={name}
                    className={`nav-item small${
                      view.kind === "category" && view.name === name && !searching ? " active" : ""
                    }`}
                    onClick={() => {
                      setQuery("");
                      setView({ kind: "category", name });
                    }}
                  >
                    <CategoryIcon size={14} />
                    {name}
                    <span className="nav-count">{categoryCounts.get(name)}</span>
                  </button>
                );
              })}
            </div>
          </>
        )}

        <div className="spacer" />
        <button
          className={`ocr-toggle${ocrOn ? " on" : ""}`}
          title="OCR runs entirely on this device; recognized text is stored encrypted"
          onClick={() => {
            const next = !ocrOn;
            setOcrEnabled(next);
            setOcrOn(next);
            showToast(
              next
                ? "New images will be read on this device. Cmd+K, then “Make images searchable” for existing ones."
                : "Image reading is off.",
            );
          }}
        >
          <ScanTextGlyph size={14} />
          <span>Read text in images</span>
          <span className={`switch${ocrOn ? " on" : ""}`} />
        </button>
        <div className="appearance">
          <button
            className="theme-toggle"
            title="Toggle day and night"
            onClick={() => {
              const next = theme === "dark" ? "light" : "dark";
              applyTheme(next);
              setTheme(next);
            }}
          >
            {theme === "dark" ? <SunGlyph size={15} /> : <MoonGlyph size={15} />}
            {theme === "dark" ? "Day" : "Night"}
          </button>
          <div className="accent-dots">
            {ACCENTS.map((a) => (
              <button
                key={a.id}
                className={`accent-dot${accent === a.id ? " on" : ""}`}
                title={a.label}
                aria-label={`${a.label} theme`}
                style={{ background: `linear-gradient(135deg, ${a.from}, ${a.to})` }}
                onClick={() => {
                  applyAccent(a.id);
                  setAccent(a.id);
                }}
              />
            ))}
          </div>
        </div>
        {store.usage && (
          <div className="usage">
            <div>
              {formatBytes(store.usage.usedBytes)} of {formatBytes(store.usage.quotaBytes)}
            </div>
            <div className="meter">
              <div style={{ width: `${usagePercent}%` }} />
            </div>
            encrypted at rest
          </div>
        )}
        <div className="account-row">
          <span title={store.session?.email}>{store.session?.email}</span>
          <button
            className="icon-btn"
            title="Two-factor authentication"
            onClick={() => setSecurityOpen(true)}
          >
            <KeyGlyph size={14} />
          </button>
          <button className="icon-btn" title="Lock and sign out" onClick={lock}>
            <LockGlyph />
          </button>
        </div>
      </aside>

      <main className="main">
        <div className="topbar">
          <div className="searchbox">
            <span className="search-glyph">
              <SearchGlyph />
            </span>
            <input
              ref={searchInput}
              placeholder="Search names, contents, tags, folders   /"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onFocus={() => setSearchFocused(true)}
              onBlur={() => setTimeout(() => setSearchFocused(false), 150)}
              onKeyDown={(e) => {
                if (!searching) {
                  return;
                }
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setSearchCursor((c) => Math.min(c + 1, hits.length - 1));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setSearchCursor((c) => Math.max(c - 1, 0));
                } else if (e.key === "Enter" && hits[searchCursor]) {
                  e.preventDefault();
                  openFile(hits[searchCursor]!.file.id);
                } else if (e.key === "Escape") {
                  setQuery("");
                  (e.target as HTMLInputElement).blur();
                }
              }}
            />
            {searchFocused && !searching && (
              <div className="search-panel" onMouseDown={(e) => e.preventDefault()}>
                {recentSearches.length > 0 && (
                  <>
                    <div className="search-panel-label">Recent</div>
                    {recentSearches.map((recent) => (
                      <button
                        key={recent}
                        className="search-recent"
                        onClick={() => {
                          setQuery(recent);
                          searchInput.current?.focus();
                        }}
                      >
                        <ClockGlyph size={12} /> {recent}
                      </button>
                    ))}
                  </>
                )}
                <div className="search-panel-label">Narrow it down</div>
                <div className="search-ops">
                  {OPERATOR_HINTS.map((op) => (
                    <button
                      key={op}
                      className="search-op mono"
                      onClick={() => {
                        setQuery((q) => (q ? `${q.trimEnd()} ${op}` : op));
                        searchInput.current?.focus();
                      }}
                    >
                      {op}
                    </button>
                  ))}
                </div>
                <div className="search-panel-note">
                  Search reads names, tags, folder names, and text inside documents
                  {ocrOn ? " and images" : ""}, decrypted only on this device.
                </div>
              </div>
            )}
          </div>
          <button className="btn btn-ghost palette-trigger" onClick={() => setPaletteOpen(true)}>
            <SparkGlyph size={14} /> <kbd className="mono">⌘K</kbd>
          </button>
          <div className="grow" />
          <button className="btn" title="New note" onClick={() => setNewNoteOpen(true)}>
            <NoteGlyph size={14} /> <span className="btn-label">New note</span>
          </button>
          <button className="btn" title="New folder" onClick={() => setNewFolderOpen(true)}>
            <PlusGlyph /> <span className="btn-label">New folder</span>
          </button>
          <button className="btn btn-primary" onClick={() => fileInput.current?.click()}>
            <UploadGlyph /> Upload
          </button>
          <button
            className={`icon-btn info-toggle${detailsOpen ? " active" : ""}`}
            title={detailsOpen ? "Hide details" : "Show details"}
            onClick={() => {
              setDetailsOpen(!detailsOpen);
              persist("engramer-details", !detailsOpen);
            }}
          >
            <InfoGlyph />
          </button>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              uploadTo([...(e.target.files ?? [])]);
              e.target.value = "";
            }}
          />
        </div>

        <div className="viewbar">
          <div className="crumbs">
            {view.kind === "folder" && !searching ? (
              <>
                <button
                  onClick={() => setView({ kind: "folder", id: null })}
                  onDragOver={(e) => {
                    if (e.dataTransfer.types.includes(DRAG_TYPE)) {
                      e.preventDefault();
                    }
                  }}
                  onDrop={(e) => dropOnFolder(null, e)}
                >
                  All files
                </button>
                {breadcrumbs.map((crumb, i) => (
                  <span key={crumb.id} style={{ display: "contents" }}>
                    <span className="sep">/</span>
                    {i === breadcrumbs.length - 1 ? (
                      <span className="current">{crumb.name}</span>
                    ) : (
                      <button onClick={() => setView({ kind: "folder", id: crumb.id })}>
                        {crumb.name}
                      </button>
                    )}
                  </span>
                ))}
              </>
            ) : (
              <span className="current">{viewTitle}</span>
            )}
            <span className="crumb-note">
              {searching
                ? `for “${query}”`
                : view.kind === "shared"
                  ? "links and file requests"
                  : `${visibleFiles.length} file${visibleFiles.length === 1 ? "" : "s"}${
                      view.kind === "folder" && childFolders.length
                        ? ` · ${childFolders.length} folder${childFolders.length === 1 ? "" : "s"}`
                        : ""
                    }`}
            </span>
            {searching && (
              <button className="icon-btn" onClick={() => setQuery("")} title="Clear search">
                <XGlyph size={13} />
              </button>
            )}
          </div>
          {showViewControls && (
            <div className="view-controls">
              <select
                className="sort-select"
                value={sort.key}
                onChange={(e) => onSort(e.target.value as SortKey)}
                title="Sort by"
              >
                <option value="name">Name</option>
                <option value="mtime">Modified</option>
                <option value="size">Size</option>
              </select>
              <button
                className="icon-btn"
                title={sort.dir === 1 ? "Ascending" : "Descending"}
                onClick={() => onSort(sort.key)}
              >
                {sort.dir === 1 ? "↑" : "↓"}
              </button>
              <div className="seg">
                <button
                  className={layout === "grid" ? "active" : ""}
                  title="Grid"
                  onClick={() => layout !== "grid" && toggleLayout()}
                >
                  <LayoutGridGlyph size={14} />
                </button>
                <button
                  className={layout === "list" ? "active" : ""}
                  title="List"
                  onClick={() => layout !== "list" && toggleLayout()}
                >
                  <LayoutListGlyph size={14} />
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="content" onClick={(e) => e.target === e.currentTarget && clearSelection()}>
          {searching ? (
            <SearchResults
              hits={hits}
              folders={store.folders}
              cursor={searchCursor}
              selection={selection}
              onSelect={select}
              onOpen={openFile}
              onContextMenu={openFileMenu}
            />
          ) : view.kind === "shared" ? (
            <SharedView onToast={showToast} />
          ) : view.kind === "trash" ? (
            <TrashList
              files={viewFiles}
              onRestore={(id) => void store.restoreFile(id)}
              onDeleteForever={(id) => setDeleteForeverId(id)}
            />
          ) : visibleFiles.length === 0 && (view.kind !== "folder" || childFolders.length === 0) ? (
            <EmptyState
              view={view}
              synced={store.synced}
              syncError={store.syncError}
              onRetry={() => void store.refresh().catch(() => {})}
              onUpload={() => fileInput.current?.click()}
              onNote={() => setNewNoteOpen(true)}
            />
          ) : layout === "list" && view.kind !== "recent" ? (
            <>
              {view.kind === "folder" && childFolders.length > 0 && (
                <div className="grid folders-strip">
                  {childFolders.map((folder, i) => (
                    <FolderCard
                      key={folder.id}
                      name={folder.name}
                      count={folderCounts.get(folder.id) ?? 0}
                      index={i}
                      onOpen={() => setView({ kind: "folder", id: folder.id })}
                      onContextMenu={(e) => openFolderMenu(folder.id, e)}
                      onDropFiles={(e) => dropOnFolder(folder.id, e)}
                    />
                  ))}
                </div>
              )}
              <FileList
                files={visibleFiles}
                selection={selection}
                sort={sort}
                onSort={onSort}
                onSelect={select}
                onOpen={openFile}
                onContextMenu={openFileMenu}
                onDragStart={startFileDrag}
              />
            </>
          ) : (
            <div className="grid">
              {view.kind === "folder" &&
                childFolders.map((folder, i) => (
                  <FolderCard
                    key={folder.id}
                    name={folder.name}
                    count={folderCounts.get(folder.id) ?? 0}
                    index={i}
                    onOpen={() => setView({ kind: "folder", id: folder.id })}
                    onContextMenu={(e) => openFolderMenu(folder.id, e)}
                    onDropFiles={(e) => dropOnFolder(folder.id, e)}
                  />
                ))}
              {visibleFiles.map((file, i) => (
                <FileCard
                  key={file.id}
                  file={file}
                  index={(view.kind === "folder" ? childFolders.length : 0) + i}
                  selected={selection.has(file.id)}
                  fresh={freshIds.has(file.id)}
                  onSelect={(e) => select(file.id, e)}
                  onOpen={() => openFile(file.id)}
                  onContextMenu={(e) => openFileMenu(file.id, e)}
                  onDragStart={(e) => startFileDrag(file.id, e)}
                />
              ))}
            </div>
          )}
        </div>
      </main>

      {detailsOpen && view.kind !== "trash" && view.kind !== "shared" && (
        <DetailsPanel
          file={selectedFile}
          selectionCount={selection.size}
          onOpen={openFile}
          onEdit={(id) => setEditorId(id)}
          onDownload={download}
          onShare={(id) => setShareId(id)}
          onRename={(id) => setRenameFileId(id)}
          onTrash={(id) => {
            void store.trashFile(id);
            clearSelection();
          }}
          onTagClick={searchTag}
          onToast={showToast}
          onClose={() => {
            setDetailsOpen(false);
            persist("engramer-details", false);
          }}
        />
      )}

      {selection.size > 1 && (
        <div className="bulk-bar">
          <span>{selection.size} selected</span>
          <button
            className="btn btn-ghost"
            onClick={() => {
              for (const id of selection) {
                void store.toggleFavorite(id);
              }
            }}
          >
            <StarGlyph size={13} /> Favorite
          </button>
          <button className="btn btn-ghost" onClick={() => setMoveIds([...selection])}>
            <MoveGlyph size={13} /> Move
          </button>
          <button
            className="btn btn-ghost danger"
            onClick={() => {
              for (const id of selection) {
                void store.trashFile(id);
              }
              clearSelection();
            }}
          >
            <TrashGlyph size={13} /> Trash
          </button>
          <button className="icon-btn" title="Clear selection" onClick={clearSelection}>
            <XGlyph size={13} />
          </button>
        </div>
      )}

      <UploadTray />
      {store.reveal && (
        <RevealToast
          onOpen={(folderId) => {
            store.dismissReveal();
            setQuery("");
            setView({ kind: "folder", id: folderId });
          }}
        />
      )}
      {ctxMenu && <ContextMenu {...ctxMenu} onClose={() => setCtxMenu(null)} />}
      {moveIds && (
        <MoveDialog
          fileIds={moveIds}
          onMoved={() => {
            showToast("Moved.");
            clearSelection();
          }}
          onClose={() => setMoveIds(null)}
        />
      )}
      {paletteOpen && (
        <CommandPalette actions={paletteActions} onOpenFile={openFile} onClose={() => setPaletteOpen(false)} />
      )}
      {previewFile && !editorFile && (
        <Preview
          file={previewFile}
          onClose={() => setPreviewId(null)}
          onShare={() => {
            setShareId(previewFile.id);
            setPreviewId(null);
          }}
          onRename={() => setRenameFileId(previewFile.id)}
          onEditTags={() => {
            setPreviewId(null);
            inspect(previewFile.id);
          }}
          onEdit={
            ["text", "doc"].includes(fileKind(previewFile.mime, previewFile.name))
              ? () => {
                  setEditorId(previewFile.id);
                  setPreviewId(null);
                }
              : undefined
          }
        />
      )}
      {editorFile && fileKind(editorFile.mime, editorFile.name) === "doc" ? (
        <Suspense
          fallback={
            <div className="preview-shell">
              <div className="spinner" style={{ margin: "auto" }} />
            </div>
          }
        >
          <DocEditor
            file={editorFile}
            onSave={(bytes) => store.saveFileBinary(editorFile.id, bytes)}
            onClose={() => setEditorId(null)}
          />
        </Suspense>
      ) : editorFile ? (
        <Editor
          file={editorFile}
          onSave={(content) => store.saveFileContent(editorFile.id, content)}
          onClose={() => setEditorId(null)}
        />
      ) : null}
      {newNoteOpen && (
        <TextPrompt
          title="New note"
          sub="Notes are Markdown files, encrypted like everything else."
          submitLabel="Create and open"
          onSubmit={async (name) => {
            const id = await store.createNote(name, currentFolderId);
            setEditorId(id);
          }}
          onClose={() => setNewNoteOpen(false)}
        />
      )}
      {newFolderOpen && (
        <TextPrompt
          title="New folder"
          sub="The folder name is encrypted before it is stored."
          submitLabel="Create"
          onSubmit={(name) => store.createFolder(name, currentFolderId)}
          onClose={() => setNewFolderOpen(false)}
        />
      )}
      {requestFolder && (
        <NewRequestDialog
          folderId={requestFolder.folderId}
          onCreated={() => showToast("Request link copied. Send it to anyone.")}
          onClose={() => setRequestFolder(null)}
        />
      )}
      {securityOpen && (
        <TwoFactorDialog onToast={showToast} onClose={() => setSecurityOpen(false)} />
      )}
      {shareFile && (
        <ShareDialog file={shareFile} onClose={() => setShareId(null)} onToast={showToast} />
      )}
      {renameFolder && (
        <TextPrompt
          title="Rename folder"
          initial={renameFolder.name}
          submitLabel="Rename"
          onSubmit={(name) => store.renameFolder(renameFolder.id, name)}
          onClose={() => setRenameFolderId(null)}
        />
      )}
      {renameFile && (
        <TextPrompt
          title="Rename file"
          initial={renameFile.name}
          submitLabel="Rename"
          onSubmit={(name) => store.renameFile(renameFile.id, name)}
          onClose={() => setRenameFileId(null)}
        />
      )}
      {deleteFolderId && (
        <Confirm
          title="Delete this folder?"
          sub="Its subfolders are removed and the files inside move to trash."
          confirmLabel="Delete folder"
          danger
          onConfirm={() => store.deleteFolder(deleteFolderId)}
          onClose={() => setDeleteFolderId(null)}
        />
      )}
      {deleteForeverId && (
        <Confirm
          title="Delete forever?"
          sub="The ciphertext is removed from the server. There is no undo."
          confirmLabel="Delete forever"
          danger
          onConfirm={() => store.deleteForever(deleteForeverId)}
          onClose={() => setDeleteForeverId(null)}
        />
      )}
      {store.ocrProgress && (
        <div className="ocr-pill">
          <span className="spinner" />
          Reading {store.ocrProgress.current} · {store.ocrProgress.done + 1} of{" "}
          {store.ocrProgress.total}
        </div>
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

function EmptyState(props: {
  view: View;
  synced: boolean;
  syncError: string | null;
  onRetry: () => void;
  onUpload: () => void;
  onNote: () => void;
}) {
  if (!props.synced) {
    // A failed sync surfaces an explicit retry instead of an eternal spinner.
    if (props.syncError) {
      return (
        <div className="empty">
          <span className="empty-mark">!</span>
          <h3>Could not reach your vault</h3>
          <p>{props.syncError}</p>
          <div className="empty-actions">
            <button className="btn btn-primary" onClick={props.onRetry}>
              Try again
            </button>
          </div>
        </div>
      );
    }
    return (
      <div className="empty">
        <span className="empty-mark">⌘</span>
        <h3>Decrypting your library</h3>
        <p>One moment.</p>
      </div>
    );
  }
  if (props.view.kind === "favorites") {
    return (
      <div className="empty">
        <span className="empty-mark">☆</span>
        <h3>No favorites yet</h3>
        <p>Right-click any file and choose "Add to favorites".</p>
      </div>
    );
  }
  return (
    <div className="empty">
      <span className="empty-art"><FolderArt /></span>
      <h3>An empty shelf</h3>
      <p>Drop files anywhere, paste from the clipboard, or start writing.</p>
      <div className="empty-actions">
        <button className="btn btn-primary" onClick={props.onUpload}>
          <UploadGlyph /> Upload files
        </button>
        <button className="btn" onClick={props.onNote}>
          <NoteGlyph size={14} /> New note
        </button>
      </div>
    </div>
  );
}

function RevealToast(props: { onOpen: (folderId: string | null) => void }) {
  const reveal = useStore((s) => s.reveal);
  const dismiss = useStore((s) => s.dismissReveal);

  useEffect(() => {
    const timer = setTimeout(dismiss, 7000);
    return () => clearTimeout(timer);
  }, [reveal, dismiss]);

  if (!reveal) {
    return null;
  }
  const first = reveal.items[0]!;
  const others = reveal.items.length - 1;

  return (
    <div className="reveal" onClick={() => props.onOpen(first.folderId)}>
      <div className="reveal-icon">
        <SparkGlyph size={17} />
      </div>
      <div className="reveal-body">
        <div className="reveal-title">
          Filed into <strong>{first.folderName ?? first.category}</strong>
          {others > 0 ? ` and ${others} more` : ""}
        </div>
        <div className="reveal-tags">
          {first.tags.slice(0, 4).map((tag) => (
            <span key={tag} className="tag">
              {tag}
            </span>
          ))}
        </div>
      </div>
      <button
        className="icon-btn"
        title="Dismiss"
        onClick={(e) => {
          e.stopPropagation();
          dismiss();
        }}
      >
        <XGlyph size={14} />
      </button>
    </div>
  );
}

function Highlighted(props: { value: string; ranges: SearchHit["nameRanges"] }) {
  return (
    <>
      {highlightParts(props.value, props.ranges).map((part, i) =>
        part.hit ? <mark key={i}>{part.text}</mark> : <span key={i}>{part.text}</span>,
      )}
    </>
  );
}

function ResultThumb(props: { file: FileEntry }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (props.file.hasThumb) {
      void thumbnailUrl(props.file.id, props.file.key).then((u) => {
        if (!cancelled) {
          setUrl(u);
        }
      });
    } else {
      setUrl(null);
    }
    return () => {
      cancelled = true;
    };
  }, [props.file.id, props.file.hasThumb, props.file.key]);

  if (url) {
    return <img className="result-thumb" src={url} alt="" />;
  }
  return <span className="row-glyph">{extension(props.file.name) || "FILE"}</span>;
}

function SearchResults(props: {
  hits: SearchHit[];
  folders: ReadonlyMap<string, FolderEntry>;
  cursor: number;
  selection: ReadonlySet<string>;
  onSelect: (id: string, event: React.MouseEvent) => void;
  onOpen: (id: string) => void;
  onContextMenu: (id: string, event: React.MouseEvent) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const active = listRef.current?.querySelector<HTMLElement>("[data-cursor='true']");
    active?.scrollIntoView({ block: "nearest" });
  }, [props.cursor]);

  if (props.hits.length === 0) {
    return (
      <div className="empty">
        <span className="empty-mark">∅</span>
        <h3>No matches</h3>
        <p>
          Search covers names, tags, folder names, and text inside documents, decrypted only on
          this device. Try <code>tag:receipts</code>, <code>type:image</code>,{" "}
          <code>before:2026</code>, or a folder's name; one-letter typos are forgiven.
        </p>
      </div>
    );
  }
  return (
    <div className="rows" ref={listRef}>
      {props.hits.map((hit, i) => {
        const path = folderPath(hit.file.folderId, props.folders);
        return (
          <div
            key={hit.file.id}
            className={`row result${props.selection.has(hit.file.id) ? " selected" : ""}${
              i === props.cursor ? " cursor" : ""
            }`}
            data-cursor={i === props.cursor}
            style={{ "--i": Math.min(i, 20) } as CSSProperties}
            onClick={(e) => props.onSelect(hit.file.id, e)}
            onDoubleClick={() => props.onOpen(hit.file.id)}
            onContextMenu={(e) => props.onContextMenu(hit.file.id, e)}
          >
            <ResultThumb file={hit.file} />
            <div className="row-main">
              <div className="name">
                <Highlighted value={hit.file.name} ranges={hit.nameRanges} />
              </div>
              <div className="result-where">
                {path ? (
                  <span className={hit.matchedFolder ? "result-folder hit" : "result-folder"}>
                    <FolderGlyph size={11} /> {path}
                  </span>
                ) : (
                  <span className="result-folder">
                    <FolderGlyph size={11} /> All files
                  </span>
                )}
                <span className="result-date">{formatDate(hit.file.mtime)}</span>
              </div>
              {hit.matchedText && (
                <div className="snippet">
                  <Highlighted value={hit.matchedText} ranges={hit.textRanges} />
                </div>
              )}
            </div>
            {hit.file.category && <span className="row-tag">{hit.file.category}</span>}
            <span className="row-meta">{formatBytes(hit.file.size)}</span>
          </div>
        );
      })}
    </div>
  );
}

function TrashList(props: {
  files: FileEntry[];
  onRestore: (id: string) => void;
  onDeleteForever: (id: string) => void;
}) {
  if (props.files.length === 0) {
    return (
      <div className="empty">
        <span className="empty-mark">◌</span>
        <h3>Trash is empty</h3>
      </div>
    );
  }
  return (
    <div className="rows">
      {props.files.map((file, i) => (
        <div key={file.id} className="row" style={{ "--i": Math.min(i, 20) } as CSSProperties}>
          <span className="row-glyph">{extension(file.name) || "FILE"}</span>
          <div className="row-main">
            <div className="name">{file.name}</div>
          </div>
          <span className="row-meta">{formatBytes(file.size)}</span>
          <div className="row-actions" style={{ opacity: 1 }}>
            <button className="icon-btn" title="Restore" onClick={() => props.onRestore(file.id)}>
              <RestoreGlyph />
            </button>
            <button className="icon-btn" title="Delete forever" onClick={() => props.onDeleteForever(file.id)}>
              <XGlyph />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
