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
import { diag } from "../diag";
import { detailsSubjectId } from "../details";
import { stepThrough } from "../neighbors";
import { clipComparable, useStore, type FileEntry, type FolderEntry } from "../store";
import { scheduleBackfill } from "../backfill";
import { installAutoBackup } from "../backup";
import { api } from "../api";
import {
  ACCENTS,
  applyAccent,
  applyTheme,
  currentAccent,
  currentTheme,
  type ThemeMode,
} from "../theme";
import { mergeSearchHits, searchFiles, highlightParts, type SearchHit } from "../search";
import { collectDropped, fromDirectoryInput } from "../uploader";
import { MOBILE_QUERY, useMediaQuery } from "../media";
import { installMediaKeyResponder } from "../mediastream";
import { installHandoffForegroundRefresh } from "../handoff";
import { installAutoSync } from "../autosync";
import { useLongPress } from "../longpress";
import {
  clearNativeUnlock,
  deviceUnlockSupported,
  enrollDeviceUnlock,
  enrollNativeUnlock,
  hasDeviceUnlock,
  markUnlockDeclined,
  unlockDeclined,
} from "../unlock";
import { nativeShell, nativeUnlockAvailable, pickPhotos } from "../native";
import {
  installSettingsSync,
  pullSettings,
  settingsEvents,
  SETTINGS_APPLIED_EVENT,
} from "../settingsync";
import type { UploadSource } from "../transfer";
import { APP_VERSION } from "../version";
import { reloadForUpdate, watchForUpdate } from "../update";
import { startWatchSync } from "../watchfolders";
import { PHOTO_ACCEPT } from "../intel/heic";
import { ocrEnabled, setOcrEnabled } from "../intel/ocr";
import {
  CLIP_MODEL_VERSION,
  cosine,
  embedQuery,
  semanticEnabled,
  setSemanticEnabled,
} from "../intel/semantic";
import { factsEnabled, setFactsEnabled } from "../intel/scan";
import { entitiesEnabled, setEntitiesEnabled } from "../intel/entities";
import { DATED_KINDS, soonestDated } from "../intel/facts";
import { extractText } from "../intel/extract";
import { CalendarView } from "./CalendarView";
import { HeadsUp, TripHeadsUp } from "./HeadsUp";
import { thumbnailUrl } from "../thumbs";
import { extension, fileKind, formatBytes, formatDate } from "../format";
import { albumTitle, albumsFrom } from "../albums";
import { PhotoGrid } from "./PhotoGrid";
import { AlbumPicker } from "./AlbumPicker";
import { SelectionBar } from "./SelectionBar";
import { usePullToRefresh } from "../pulltorefresh";
import { useKeyboardInset } from "../keyboard";
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
/** Word and Excel open in the full editor; everything else does not. */
function officeKind(file: FileEntry): "docx" | "xlsx" | null {
  const kind = fileKind(file.mime, file.name);
  return kind === "doc" ? "docx" : kind === "sheet" ? "xlsx" : null;
}

const OfficeEditor = lazy(() =>
  import("./OfficeEditor").then((m) => ({ default: m.OfficeEditor })),
);
import { ShareDialog } from "./ShareDialog";
import { SharedView, NewRequestDialog } from "./SharedView";
import { TwoFactorDialog } from "./TwoFactorDialog";
import { AdminPanel } from "./AdminPanel";
import { ProfileView } from "./ProfileView";
import { UploadTray } from "./UploadTray";
import { CommandPalette, type PaletteAction } from "./CommandPalette";
import { Confirm, TextPrompt } from "./Dialogs";
import {
  AsteriskGlyph,
  AudioGlyph,
  BookGlyph,
  BoxGlyph,
  CameraGlyph,
  CalendarGlyph,
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
  PeopleGlyph,
  LockGlyph,
  MenuGlyph,
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
  | { kind: "shared-with-me" }
  | { kind: "profile" }
  | { kind: "expiring" }
  | { kind: "calendar" }
  | { kind: "category"; name: string }
  | { kind: "photos" }
  | { kind: "album"; tag: string };

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
  // Touch has no cmd-click, so gathering files is an explicit mode there:
  // long-press enters it, every tap toggles, Done leaves.
  const [selectMode, setSelectMode] = useState(false);
  const [albumPickerIds, setAlbumPickerIds] = useState<string[] | null>(null);
  const [photosFavOnly, setPhotosFavOnly] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(() => loadPref("engramer-details", true));
  const [detailsSheet, setDetailsSheet] = useState(false);
  /**
   * The file the phone's Details sheet is showing. It owns this rather
   * than borrowing the selection: opening Details from an open file closes
   * that file, and the tap then lands on the grid underneath, which clears
   * the selection — the sheet flickered open and vanished, back to the
   * folder. What the sheet shows must not depend on what is selected.
   */
  const [detailsFileId, setDetailsFileId] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<{
    x: number;
    y: number;
    items: MenuItem[];
    title?: string;
  } | null>(null);
  const [moveIds, setMoveIds] = useState<string[] | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [editorId, setEditorId] = useState<string | null>(null);
  const [newNoteOpen, setNewNoteOpen] = useState(false);
  const [newOfficeKind, setNewOfficeKind] = useState<"docx" | "xlsx" | null>(null);
  const [shareId, setShareId] = useState<string | null>(null);
  const [renameFileId, setRenameFileId] = useState<string | null>(null);
  const [renameFolderId, setRenameFolderId] = useState<string | null>(null);
  const [deleteFolderId, setDeleteFolderId] = useState<string | null>(null);
  const [deleteForeverId, setDeleteForeverId] = useState<string | null>(null);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [requestFolder, setRequestFolder] = useState<{ folderId: string | null } | null>(null);
  const [securityOpen, setSecurityOpen] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  const [unlockPromptOpen, setUnlockPromptOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [updateReady, setUpdateReady] = useState<string | null>(null);
  const [theme, setTheme] = useState<ThemeMode>(() => currentTheme());
  const [accent, setAccent] = useState<string>(() => currentAccent());
  const [searchFocused, setSearchFocused] = useState(false);
  const [searchCursor, setSearchCursor] = useState(0);
  const [recentSearches, setRecentSearches] = useState<string[]>(() => loadRecentSearches());
  const [ocrOn, setOcrOn] = useState(() => ocrEnabled());
  const [semanticOn, setSemanticOn] = useState(() => semanticEnabled());
  const [factsOn, setFactsOn] = useState(() => factsEnabled());
  const [entitiesOn, setEntitiesOn] = useState(() => entitiesEnabled());
  const [semanticHits, setSemanticHits] = useState<SearchHit[]>([]);
  const [similarTo, setSimilarTo] = useState<FileEntry | null>(null);
  const [similarHits, setSimilarHits] = useState<SearchHit[]>([]);
  const isMobile = useMediaQuery(MOBILE_QUERY);
  const pullToRefresh = usePullToRefresh(() => store.refresh());
  useKeyboardInset();
  // Between phone and full desktop the long placeholder clips mid-word;
  // a narrower window gets the short, confident form instead.
  const compactSearch = useMediaQuery("(max-width: 1180px)");
  const dragDepth = useRef(0);
  const lastSelected = useRef<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const cameraInput = useRef<HTMLInputElement>(null);
  const photoInput = useRef<HTMLInputElement>(null);
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

  // A warm boot shows the library from this device's cache even when the
  // server is unreachable; the failed background sync surfaces as a toast
  // instead of tearing the library down.
  useEffect(() => {
    if (store.syncError && store.synced) {
      showToast("Could not refresh from the server. Showing this device's copy.");
    }
  }, [store.syncError, store.synced, showToast]);

  // A named invitation released its key without a click; say so, since
  // an invisible grant looks identical to a broken one.
  const autoReleasedNote = store.autoReleasedNote;
  useEffect(() => {
    if (autoReleasedNote) {
      showToast(autoReleasedNote);
      useStore.getState().consumeAutoReleaseNote();
    }
  }, [autoReleasedNote, showToast]);

  // Someone accepted an invitation and is waiting on a key. Unnamed
  // invitations release nothing automatically, so this has to be visible
  // or the recipient waits forever wondering whether sharing works.
  const claimCount = store.pendingClaims.length;
  useEffect(() => {
    if (claimCount > 0) {
      showToast(
        claimCount === 1
          ? "Someone accepted your invitation. Open Share on that file to check who, and release the key."
          : `${claimCount} people accepted your invitations. Open Share on those files to release their keys.`,
      );
    }
  }, [claimCount, showToast]);

  const liveFiles = useMemo(
    () => [...store.files.values()].filter((f) => !f.trashed),
    [store.files],
  );

  const categoryCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const file of liveFiles) {
      // Shared items live in Shared with me, never in the library counts:
      // their folder and category belong to their owner's organization.
      if (file.shared) {
        continue;
      }
      const category = file.category ?? "Other";
      counts.set(category, (counts.get(category) ?? 0) + 1);
    }
    return counts;
  }, [liveFiles]);

  const albums = useMemo(
    () => albumsFrom(liveFiles.filter((f) => !f.shared)),
    [liveFiles],
  );

  const sharedWithMeCount = useMemo(
    () => liveFiles.reduce((n, f) => n + (f.shared ? 1 : 0), 0),
    [liveFiles],
  );

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
      case "shared-with-me":
        files = liveFiles.filter((f) => f.shared);
        break;
      case "favorites":
        files = liveFiles.filter((f) => f.favorite);
        break;
      case "expiring": {
        // Sorted by the date itself rather than by the usual sort, because
        // the whole point of this view is what happens next.
        const dated = liveFiles
          .map((file) => ({ file, at: soonestDated(file.facts) }))
          .filter((entry): entry is { file: FileEntry; at: string } => entry.at !== undefined);
        dated.sort((a, b) => a.at.localeCompare(b.at));
        return dated.map((entry) => entry.file);
      }
      case "calendar":
        // The calendar renders itself; the grid under it shows nothing.
        return [];
      case "category":
        files = liveFiles.filter((f) => !f.shared && (f.category ?? "Other") === view.name);
        break;
      case "photos": {
        // The timeline shows everything the camera made, wherever it lives.
        files = liveFiles.filter((f) => {
          const kind = fileKind(f.mime, f.name);
          return !f.shared && (kind === "image" || kind === "video") && (!photosFavOnly || f.favorite);
        });
        break;
      }
      case "album":
        files = liveFiles.filter(
          (f) => !f.shared && f.tags.includes(view.tag) && (!photosFavOnly || f.favorite),
        );
        break;
      case "trash":
        return [...store.files.values()]
          .filter((f) => f.trashed)
          .sort((a, b) => b.updatedAt - a.updatedAt);
      default:
        // Shared items carry no place in this account's tree (their
        // folderId is the owner's business), so folder views skip them.
        files = liveFiles.filter((f) => !f.shared && f.folderId === currentFolderId);
    }
    return sortFiles(files, sort);
  }, [view, liveFiles, store.files, currentFolderId, sort, photosFavOnly]);

  const hits = useMemo(
    () => (searching ? searchFiles(store.files.values(), query, store.folders) : []),
    [store.files, store.folders, query, searching],
  );

  // THE search result list. Every consumer — the headline count, the
  // keyboard cursor, Enter-to-open, the rendered rows — reads this one,
  // or a meaning match sits under a "0 results" headline that arrow keys
  // cannot reach.
  const shownHits = useMemo(() => mergeSearchHits(hits, semanticHits), [hits, semanticHits]);

  const visibleFiles = searching ? shownHits.map((h) => h.file) : viewFiles;

  const previewFile = previewId ? store.files.get(previewId) : undefined;
  const editorFile = editorId ? store.files.get(editorId) : undefined;
  const shareFile = shareId ? store.files.get(shareId) : undefined;
  const renameFile = renameFileId ? store.files.get(renameFileId) : undefined;
  const renameFolder = renameFolderId ? store.folders.get(renameFolderId) : undefined;
  const selectedFile =
    selection.size === 1 ? (store.files.get([...selection][0]!) ?? null) : null;
  // The pane follows the selection; the sheet follows what it was opened on.
  const detailsSubject = detailsSubjectId({
    pinnedId: detailsFileId,
    selectedId: selectedFile?.id ?? null,
    sheet: isMobile,
  });
  const detailsFile = detailsSubject ? (store.files.get(detailsSubject) ?? null) : null;
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
    setSelectMode(false);
    lastSelected.current = null;
  }, []);

  const enterSelect = useCallback((id: string) => {
    setSelectMode(true);
    setSelection(new Set([id]));
    lastSelected.current = id;
  }, []);

  const toggleSelect = useCallback((id: string) => {
    setSelection((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      lastSelected.current = id;
      return next;
    });
  }, []);

  const addSelectionToAlbum = (ids: string[], tag: string) => {
    setAlbumPickerIds(null);
    void store
      .addToAlbum(ids, tag)
      .then(() => showToast(`Added ${ids.length === 1 ? "1 item" : `${ids.length} items`} to ${albumTitle(tag)}`))
      .catch(() => showToast("Could not add to the album."));
  };

  useEffect(() => {
    diag("vault", `mounted (${isMobile ? "phone" : "wide"} layout)`);
  }, [isMobile]);

  useEffect(() => {
    clearSelection();
    if (detailsSheet) {
      diag("details", "closed: the view or the search changed");
    }
    setDetailsSheet(false);
    setDetailsFileId(null);
    // Deliberately not watching detailsSheet: this closes the sheet, and
    // watching what it sets would make it re-run and close it again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, query, clearSelection]);
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
    // On phones the inspector is an on-demand bottom sheet, not a pane.
    setDetailsFileId(id);
    setDetailsSheet(true);
    diag("details", `opened as a ${isMobile ? "sheet" : "pane"}`);
  };

  const uploadTo = useCallback(
    (files: UploadSource[]) => {
      if (files.length > 0) {
        void store.uploadFiles(files, currentFolderId);
      }
    },
    [store, currentFolderId],
  );

  const fileMenuItems = (file: FileEntry): MenuItem[] => [
    { id: "open", label: "Open", run: () => openFile(file.id) },
    // Second from the top and named for what it is: reaching details used
    // to mean opening the file first, then finding a button inside it.
    {
      id: "tags",
      label: "Details and tags",
      icon: <InfoGlyph size={13} />,
      run: () => inspect(file.id),
    },
    {
      id: "album",
      label: "Add to album",
      icon: <PhotoGlyph size={13} />,
      run: () => setAlbumPickerIds([file.id]),
    },
    {
      id: "select",
      label: "Select",
      icon: <GridGlyph size={13} />,
      run: () => enterSelect(file.id),
    },
    ...(["text", "doc", "sheet"].includes(fileKind(file.mime, file.name))
      ? [{ id: "edit", label: "Edit", icon: <PencilGlyph size={13} />, run: () => setEditorId(file.id) }]
      : []),
    ...((file.mime.startsWith("image/") || file.mime === "application/pdf") && !file.hasText
      ? [
          {
            id: "ocr",
            label: file.mime.startsWith("image/") ? "Read text in image" : "Read text in document",
            icon: <ScanTextGlyph size={13} />,
            run: () => {
              showToast("Reading text on this device…");
              void store
                .recognizeFile(file.id)
                .then((found) =>
                  showToast(found ? "Text found. This file is searchable now." : "No text found in this file."),
                )
                .catch(() => showToast("Could not read this file."));
            },
          },
        ]
      : []),
    ...(file.hasClip
      ? [
          {
            id: "similar",
            label: "Find similar",
            icon: <SparkGlyph size={13} />,
            run: () => void findSimilar(file.id),
          },
        ]
      : []),
    { id: "download", label: "Download", icon: <DownloadGlyph size={13} />, run: () => download(file) },
    // Sharing, moving and trashing belong to the file's owner; a shared
    // entry offers Leave instead, and only an editor may touch metadata.
    ...(file.shared
      ? []
      : [{ id: "share", label: "Share", icon: <ShareGlyph size={13} />, run: () => setShareId(file.id) }]),
    { id: "d1", label: "", divider: true, run: () => {} },
    ...(!file.shared || file.role === "editor"
      ? [
          {
            id: "favorite",
            label: file.favorite ? "Remove favorite" : "Add to favorites",
            icon: <StarGlyph size={13} filled={file.favorite} />,
            run: () => void store.toggleFavorite(file.id),
          },
        ]
      : []),

    ...(!file.shared || file.role === "editor"
      ? [{ id: "rename", label: "Rename", icon: <PencilGlyph size={13} />, run: () => setRenameFileId(file.id) }]
      : []),
    ...(file.shared
      ? []
      : [
          {
            id: "move",
            label: "Move to…",
            icon: <MoveGlyph size={13} />,
            run: () =>
              setMoveIds(selection.has(file.id) && selection.size > 1 ? [...selection] : [file.id]),
          },
        ]),
    { id: "d2", label: "", divider: true, run: () => {} },
    ...(file.shared
      ? [
          {
            id: "leave",
            label: "Leave shared file",
            icon: <TrashGlyph size={13} />,
            danger: true,
            run: () => {
              void api
                .leaveShared(file.id)
                .then(() => store.refresh())
                .catch(() => showToast("Could not leave this file."));
              clearSelection();
            },
          },
        ]
      : [
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
        ]),
  ];

  /** Ranks every indexed photo and video by closeness to this file's stored
   * meaning vector. Plain arithmetic over vectors already on this device;
   * the model never loads and nothing is downloaded beyond index blobs. */
  const findSimilar = async (id: string) => {
    showToast("Comparing on this device…");
    await store.warmSearchIndex().catch(() => {});
    const files = useStore.getState().files;
    const target = files.get(id);
    if (!target?.clip || !clipComparable(target, CLIP_MODEL_VERSION)) {
      showToast("This file has no meaning index yet.");
      return;
    }
    const scored: SearchHit[] = [];
    const targetVectors = target.clips ?? [target.clip];
    for (const file of files.values()) {
      if (file.id === id || file.trashed || !clipComparable(file, CLIP_MODEL_VERSION)) {
        continue;
      }
      const vectors = file.clips ?? [file.clip];
      let score = -1;
      for (const mine of targetVectors) {
        for (const theirs of vectors) {
          score = Math.max(score, cosine(mine, theirs));
        }
      }
      if (score >= 0.5) {
        scored.push({
          file,
          score,
          matchedText: null,
          textRanges: [],
          nameRanges: [],
          matchedFolder: null,
          semantic: true,
        });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    if (scored.length === 0) {
      showToast("Nothing similar among indexed photos and videos.");
      return;
    }
    setQuery("");
    setSimilarHits(scored.slice(0, 24));
    setSimilarTo(target);
  };

  const openFileMenu = (id: string, x: number, y: number) => {
    const file = store.files.get(id);
    if (!file) {
      return;
    }
    if (!selection.has(id)) {
      setSelection(new Set([id]));
      lastSelected.current = id;
    }
    // Selecting for a menu must not resurface the phone details sheet.
    if (detailsSheet) {
      diag("details", "closed: a file menu opened");
    }
    setDetailsSheet(false);
    setCtxMenu({ x, y, items: fileMenuItems(file) });
  };

  const openFolderMenu = (folderId: string, x: number, y: number) => {
    setCtxMenu({
      x,
      y,
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
      } else if (nativeShell() && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "r") {
        // Browsers reload on their own; the desktop shell needs the shortcut
        // wired by hand or the page lives until the app quits.
        event.preventDefault();
        window.location.reload();
      } else if (event.key === "/" && !typing && !paletteOpen) {
        event.preventDefault();
        searchInput.current?.focus();
      } else if (event.key === "Escape" && drawerOpen) {
        setDrawerOpen(false);
      } else if (
        event.key === "Escape" &&
        !typing &&
        (selection.size > 0 || selectMode) &&
        !previewId &&
        !editorId &&
        !ctxMenu
      ) {
        clearSelection();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [paletteOpen, selection, selectMode, previewId, editorId, ctxMenu, drawerOpen, clearSelection]);

  // Meaning search runs beside the lexical index: the query embeds on this
  // device and warmed photo vectors rank by similarity. Operator queries
  // stay purely lexical.
  useEffect(() => {
    let cancelled = false;
    setSemanticHits([]);
    const trimmed = query.trim();
    if (!semanticOn || trimmed.length < 3 || trimmed.includes(":")) {
      return;
    }
    const timer = setTimeout(() => {
      void (async () => {
        const vector = await embedQuery(trimmed);
        if (!vector || cancelled) {
          return;
        }
        const scored: SearchHit[] = [];
        for (const file of store.files.values()) {
          // Only vectors from the model that embedded the query: a cosine
          // across models is noise that ranks with confidence.
          if (file.trashed || !clipComparable(file, CLIP_MODEL_VERSION)) {
            continue;
          }
          // Videos carry several frame vectors; the best one speaks for
          // the file, so any scene in the clip can answer the query.
          const vectors = file.clips ?? [file.clip];
          let score = -1;
          for (const candidate of vectors) {
            score = Math.max(score, cosine(vector, candidate));
          }
          if (score >= 0.15) {
            scored.push({
              file,
              score,
              matchedText: null,
              textRanges: [],
              nameRanges: [],
              matchedFolder: null,
              semantic: true,
            });
          }
        }
        scored.sort((a, b) => b.score - a.score);
        if (!cancelled) {
          setSemanticHits(scored.slice(0, 24));
        }
      })();
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, semanticOn, store.files]);

  // Similar-items mode is a transient lens; leaving it for any other view
  // should not require finding the close button.
  useEffect(() => {
    setSimilarTo(null);
    setSimilarHits([]);
  }, [view]);

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
    const transfer = event.dataTransfer;
    void collectDropped(transfer).then((items) => {
      if (items.length === 0) {
        return;
      }
      // Folder drops and big batches go through the tree pipeline; a couple
      // of loose files keep the familiar per-file flow.
      const isTree = items.some((i) => i.path.length > 0) || items.length > 10;
      if (isTree) {
        void store.uploadTree(items, currentFolderId);
      } else {
        uploadTo(items.map((i) => i.file));
      }
    });
  };

  // Lock keeps the Touch ID / passkey enrollment so one touch reopens the
  // vault; without an enrollment it is the same as signing out.
  const lock = () => {
    clearThumbnailCache();
    if (hasDeviceUnlock()) {
      store.lockVault();
    } else {
      store.logout();
    }
  };

  const signOut = () => {
    clearThumbnailCache();
    store.logout();
  };

  // Shared by the sidebar controls and the profile page, so the two
  // surfaces can never disagree about a setting.
  const toggleOcr = () => {
    const next = !ocrOn;
    setOcrEnabled(next);
    setOcrOn(next);
    showToast(
      next
        ? "New images will be read on this device. Cmd+K, then “Make images searchable” for existing ones."
        : "Image reading is off.",
    );
  };

  const toggleSemantic = () => {
    const next = !semanticOn;
    setSemanticEnabled(next);
    setSemanticOn(next);
    showToast(
      next
        ? "Photos and videos will be indexed by meaning on this device (a 65 MB model downloads once). Cmd+K, then “Index photos and videos by meaning” for existing ones."
        : "Meaning search is off.",
    );
  };

  const toggleTheme = () => {
    const next = theme === "dark" ? "light" : "dark";
    applyTheme(next);
    setTheme(next);
  };

  // The media bridge's worker may restart at any time; this responder
  // re-supplies file keys for as long as the vault is open.
  useEffect(() => installMediaKeyResponder(), []);

  // iOS sends people from the Files app to "open the app to connect";
  // returning to the foreground rewrites the extension handoff and
  // signals the drive, so that trip actually reconnects it.
  useEffect(() => installHandoffForegroundRefresh(() => useStore.getState().session), []);

  // Sync is a client-driven pull; this adds the foreground-and-interval
  // heartbeat that makes shared documents and phone uploads appear on
  // their own.
  useEffect(() => installAutoSync(), []);

  // Once the library is in hand this device can see what other paths
  // left unfinished: thumbnails for Files-app arrivals, scanners a
  // backup deferred. The delay inside is what lets a desktop win.
  useEffect(() => {
    if (store.synced) {
      scheduleBackfill();
    }
  }, [store.synced]);

  // Photo backup runs itself when the app opens or comes back to the
  // foreground (iOS shell only; a no-op everywhere else). Waiting for a
  // SERVER sync keeps the already-backed-up ledger honest: `synced` is
  // satisfied by the on-device cache, and a pass against that snapshot
  // re-uploaded whatever the cache had not seen yet.
  useEffect(() => {
    if (store.serverSynced) {
      installAutoBackup();
    }
  }, [store.serverSynced]);

  // Account settings: pull once the server has answered, and from then on
  // push every local toggle flip, so switches follow the account instead
  // of living and dying with one device's storage.
  useEffect(() => {
    const session = store.session;
    if (!store.serverSynced || !session) {
      return;
    }
    void pullSettings(session.email, session.masterKey).catch(() => {});
    installSettingsSync(() => {
      const live = useStore.getState().session;
      return live ? { email: live.email, masterKey: live.masterKey } : null;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.serverSynced]);

  // A blob applied from another device changed the switches under this
  // view's feet; re-read them so the sidebar and Profile stay truthful.
  useEffect(() => {
    const refresh = () => {
      setOcrOn(ocrEnabled());
      setSemanticOn(semanticEnabled());
      setFactsOn(factsEnabled());
      setEntitiesOn(entitiesEnabled());
    };
    settingsEvents.addEventListener(SETTINGS_APPLIED_EVENT, refresh);
    return () => settingsEvents.removeEventListener(SETTINGS_APPLIED_EVENT, refresh);
  }, []);

  // Desktop shell only: pick up watched-folder arrivals, past and live.
  useEffect(() => {
    void startWatchSync();
  }, []);

  // This client can outlive several releases: a home-screen app, a desktop
  // window that reopens rather than relaunches, a tab left open for days.
  // Offered rather than forced, because a reload in the middle of an upload
  // or an unsaved document is the app's decision to make, not ours.
  useEffect(() => watchForUpdate(setUpdateReady), []);

  // Belt to the Auth blur's braces: landing here with a keyboard-stale
  // viewport (iOS) misplaces fixed chrome until something forces relayout.
  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);

  // One-time offer: skip the password next launch. Only on capable
  // surfaces (desktop shell or passkey browser), until enrolled or declined.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (hasDeviceUnlock() || unlockDeclined()) {
        return;
      }
      const capable = (await nativeUnlockAvailable()) || (await deviceUnlockSupported());
      if (capable && !cancelled) {
        setUnlockPromptOpen(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const enrollUnlock = async () => {
    const session = store.session;
    if (!session) {
      return;
    }
    try {
      // The desktop shell's Keychain flavor wins when present; the passkey
      // flavor covers every capable browser.
      const result = (await nativeUnlockAvailable())
        ? await enrollNativeUnlock(session)
        : await enrollDeviceUnlock(session);
      if (result === "enrolled") {
        showToast("Device unlock is on. Next time, one touch opens the vault.");
      } else if (result === "unsupported") {
        markUnlockDeclined();
        showToast("This app cannot unlock with Touch ID or a passkey.");
      }
      // "cancelled" keeps the offer available from the command palette.
    } catch {
      showToast("Device unlock was not set up.");
    }
  };

  // Everything the app can create, in one list. Four buttons that differed
  // only by label collapsed to one menu: at narrow widths their labels hide
  // and they became three identical icons, which is no way to pick between a
  // note, a document and a spreadsheet.
  const newItems: MenuItem[] = [
    { id: "new-note", label: "Note", icon: <NoteGlyph size={15} />, run: () => setNewNoteOpen(true) },
    {
      id: "new-document",
      label: "Word document",
      icon: <DocGlyph size={15} />,
      run: () => setNewOfficeKind("docx"),
    },
    {
      id: "new-spreadsheet",
      label: "Spreadsheet",
      icon: <GridGlyph size={15} />,
      run: () => setNewOfficeKind("xlsx"),
    },
    { id: "new-d", label: "", divider: true, run: () => {} },
    {
      id: "new-folder",
      label: "Folder",
      icon: <FolderGlyph size={15} />,
      run: () => setNewFolderOpen(true),
    },
  ];

  // The tab bar's center [+]: one sheet absorbs every create/upload action
  // that the phone topbar has no room for.
  const openAddSheet = () => {
    setCtxMenu({
      x: 0,
      y: 0,
      title: "Add to your vault",
      items: [
        { id: "upload", label: "Upload files", icon: <UploadGlyph size={15} />, run: () => fileInput.current?.click() },
        {
          id: "photos",
          label: "Photos and videos",
          icon: <PhotoGlyph size={15} />,
          run: () => {
            // The shell's picker keeps originals; the file input cannot, so
            // it is the fallback rather than the other way round.
            void pickPhotos()
              .then((picked) => {
                if (picked === null) {
                  photoInput.current?.click();
                } else if (picked.length > 0) {
                  uploadTo(picked);
                }
              })
              .catch(() => photoInput.current?.click());
          },
        },
        { id: "camera", label: "Take photo", icon: <CameraGlyph size={15} />, run: () => cameraInput.current?.click() },
        {
          id: "tree",
          label: "Upload folder",
          icon: <FolderGlyph size={15} />,
          run: () => folderInput.current?.click(),
        },
        { id: "new-folder", label: "New folder", icon: <PlusGlyph size={15} />, run: () => setNewFolderOpen(true) },
        { id: "new-note", label: "New note", icon: <NoteGlyph size={15} />, run: () => setNewNoteOpen(true) },
        {
          id: "new-document",
          label: "New document",
          icon: <DocGlyph size={15} />,
          run: () => setNewOfficeKind("docx"),
        },
        {
          id: "new-spreadsheet",
          label: "New spreadsheet",
          icon: <GridGlyph size={15} />,
          run: () => setNewOfficeKind("xlsx"),
        },
      ],
    });
  };

  const paletteActions = useMemo<PaletteAction[]>(
    () => [
      { id: "upload", label: "Upload files", hint: "encrypt and store", run: () => fileInput.current?.click() },
      { id: "new-note", label: "New note", hint: "write, encrypted", run: () => setNewNoteOpen(true) },
      {
        id: "new-document",
        label: "New document",
        hint: "Word, encrypted",
        run: () => setNewOfficeKind("docx"),
      },
      {
        id: "new-spreadsheet",
        label: "New spreadsheet",
        hint: "Excel, encrypted",
        run: () => setNewOfficeKind("xlsx"),
      },
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
        label: "Make images and scans searchable",
        hint: "on-device OCR, PDFs included",
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
      {
        id: "clip-all",
        label: "Index photos and videos by meaning",
        hint: "on-device; find media by what is in it",
        run: () => {
          if (!semanticEnabled()) {
            setSemanticEnabled(true);
            setSemanticOn(true);
          }
          void store.embedAllImages().then((indexed) => {
            showToast(
              indexed > 0
                ? `Indexed ${indexed} file${indexed === 1 ? "" : "s"} by meaning.`
                : "No new photos or videos to index.",
            );
          });
        },
      },
      {
        id: "thumbs-all",
        label: "Generate missing thumbnails",
        hint: "for files added outside this app",
        run: () => {
          void store.backfillThumbnails().then((made) => {
            showToast(
              made > 0
                ? `Made thumbnails for ${made} file${made === 1 ? "" : "s"}.`
                : "Every image and video already has a thumbnail.",
            );
          });
        },
      },
      {
        id: "facts-all",
        label: "Find dates in my documents",
        hint: "reads text already stored; nothing is downloaded",
        run: () => {
          if (!factsEnabled()) {
            setFactsEnabled(true);
            setFactsOn(true);
          }
          void store.scanLibraryForFacts().then((found) => {
            showToast(
              found > 0
                ? `Found dates in ${found} document${found === 1 ? "" : "s"}. Confirm the ones worth tracking.`
                : "No dates found in what is already stored.",
            );
          });
        },
      },
      {
        id: "resync",
        label: "Resync library",
        hint: "rebuild this device's cache",
        run: () => {
          void store
            .resyncLibrary()
            .then(() => showToast("Library resynced from the server."))
            .catch(() => showToast("Could not resync. Check your connection."));
        },
      },
      { id: "go-files", label: "Go to All files", run: () => setView({ kind: "folder", id: null }) },
      {
        id: "go-shared-with-me",
        label: "Go to Shared with me",
        run: () => setView({ kind: "shared-with-me" }),
      },
      { id: "go-recent", label: "Go to Recent", run: () => setView({ kind: "recent" }) },
      { id: "go-favorites", label: "Go to Favorites", run: () => setView({ kind: "favorites" }) },
      { id: "go-shared", label: "Go to Shared", run: () => setView({ kind: "shared" }) },
      { id: "go-trash", label: "Go to Trash", run: () => setView({ kind: "trash" }) },
      {
        id: "unlock-enable",
        label: "Enable device unlock",
        hint: "Touch ID or passkey instead of the password",
        run: () => {
          if (hasDeviceUnlock()) {
            showToast("Device unlock is already on for this device.");
            return;
          }
          void enrollUnlock();
        },
      },
      {
        id: "unlock-disable",
        label: "Disable device unlock",
        hint: "require the password on this device",
        run: () => {
          clearNativeUnlock();
          showToast("Device unlock removed. Your password is required next time.");
        },
      },
      { id: "lock", label: "Lock vault", hint: "Touch ID or passkey reopens it", run: lock },
      { id: "signout", label: "Sign out", hint: "full sign-out; password required next time", run: signOut },
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

  // The entry appears only once something is being tracked, so a vault that
  // has never used this never sees a view that would always be empty.
  const expiringCount = liveFiles.filter((f) => soonestDated(f.facts) !== undefined).length;
  // The calendar earns its place once anything is on it: a confirmed dated
  // fact or a trip. Before that, the sidebar stays as short as it was.
  const calendarWorthy = liveFiles.some(
    (f) =>
      f.tags.some((tag) => tag.startsWith("trip:")) ||
      f.facts.some((fact) => fact.confirmed && !fact.dismissed && DATED_KINDS.has(fact.kind)),
  );

  const viewTitle = searching
    ? `${shownHits.length} result${shownHits.length === 1 ? "" : "s"}`
    : view.kind === "folder"
      ? (breadcrumbs[breadcrumbs.length - 1]?.name ?? "All files")
      : view.kind === "category"
        ? view.name
        : view.kind === "recent"
          ? "Recent"
          : view.kind === "favorites"
            ? "Favorites"
            : view.kind === "expiring"
              ? "Expiring soon"
            : view.kind === "calendar"
              ? "Calendar"
            : view.kind === "shared"
              ? "Shared"
              : view.kind === "shared-with-me"
                ? "Shared with me"
              : view.kind === "profile"
                ? "Profile"
                : view.kind === "photos"
                  ? "Photos"
                  : view.kind === "album"
                    ? albumTitle(view.tag)
                    : "Trash";

  const similarActive = !searching && similarTo !== null;
  const showViewControls =
    !searching &&
    !similarActive &&
    view.kind !== "trash" &&
    view.kind !== "shared" &&
    view.kind !== "profile";

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
        setDrawerOpen(false);
        onClick();
      }}
    >
      {icon} {label}
      {count !== undefined && count > 0 && <span className="nav-count">{count}</span>}
    </button>
  );

  return (
    <div
      className={`frame${dragging ? " dropzone-active" : ""}${detailsOpen ? " with-details" : ""}${drawerOpen ? " drawer" : ""}`}
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
      {drawerOpen && <div className="drawer-backdrop" onClick={() => setDrawerOpen(false)} />}
      <aside className="sidebar">
        <div className="brand">
          <BrandMark size={26} />
          <Wordmark />
        </div>
        {navButton(view.kind === "folder", () => setView({ kind: "folder", id: null }), <FolderGlyph />, "Files")}
        {navButton(view.kind === "recent", () => setView({ kind: "recent" }), <ClockGlyph />, "Recent")}
        {navButton(view.kind === "photos", () => setView({ kind: "photos" }), <PhotoGlyph />, "Photos")}
        {navButton(
          view.kind === "favorites",
          () => setView({ kind: "favorites" }),
          <StarGlyph />,
          "Favorites",
          liveFiles.filter((f) => f.favorite).length,
        )}
        {expiringCount > 0 &&
          navButton(
            view.kind === "expiring",
            () => setView({ kind: "expiring" }),
            <ClockGlyph />,
            "Expiring soon",
            expiringCount,
          )}
        {calendarWorthy &&
          navButton(
            view.kind === "calendar",
            () => setView({ kind: "calendar" }),
            <CalendarGlyph />,
            "Calendar",
          )}
        {navButton(view.kind === "shared", () => setView({ kind: "shared" }), <LinkGlyph />, "Shared")}
        {sharedWithMeCount > 0 &&
          navButton(
            view.kind === "shared-with-me",
            () => setView({ kind: "shared-with-me" }),
            <PeopleGlyph />,
            "Shared with me",
            sharedWithMeCount,
          )}
        {navButton(view.kind === "trash", () => setView({ kind: "trash" }), <TrashGlyph />, "Trash")}

        {albums.length > 0 && (
          <>
            <div className="sidebar-label">
              <BookGlyph size={12} /> Albums
            </div>
            <div className="library-list">
              {albums.map((album) => (
                <button
                  key={album.tag}
                  className={`nav-item small${
                    view.kind === "album" && view.tag === album.tag && !searching ? " active" : ""
                  }`}
                  onClick={() => {
                    setQuery("");
                    setDrawerOpen(false);
                    setView({ kind: "album", tag: album.tag });
                  }}
                >
                  <PhotoGlyph size={14} />
                  {album.title}
                  <span className="nav-count">{album.count}</span>
                </button>
              ))}
            </div>
          </>
        )}

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
                      setDrawerOpen(false);
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
          onClick={toggleOcr}
        >
          <ScanTextGlyph size={14} />
          <span>Read text in images</span>
          <span className={`switch${ocrOn ? " on" : ""}`} />
        </button>
        <button
          className={`ocr-toggle${semanticOn ? " on" : ""}`}
          title="A small on-device model makes photos and videos findable by what is in them; nothing leaves this device"
          onClick={toggleSemantic}
        >
          <SparkGlyph size={14} />
          <span>Find media by meaning</span>
          <span className={`switch${semanticOn ? " on" : ""}`} />
        </button>
        <div className="appearance">
          <button className="theme-toggle" title="Toggle day and night" onClick={toggleTheme}>
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
        <div className="build-line" title="The version running in this page">
          v{APP_VERSION}
        </div>
        <div className="account-row">
          <button
            className="account-link"
            title="Profile and settings"
            onClick={() => {
              setDrawerOpen(false);
              setView({ kind: "profile" });
            }}
          >
            {store.session?.email}
          </button>
          {store.isAdmin && (
            <button
              className="icon-btn"
              title="Server administration"
              onClick={() => {
                setDrawerOpen(false);
                setAdminOpen(true);
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 3l8 3v6c0 4.5-3.2 7.8-8 9-4.8-1.2-8-4.5-8-9V6l8-3z" />
              </svg>
            </button>
          )}
          <button
            className="icon-btn"
            title="Two-factor authentication"
            onClick={() => {
              setDrawerOpen(false);
              setSecurityOpen(true);
            }}
          >
            <KeyGlyph size={14} />
          </button>
          <button className="icon-btn" title="Lock vault" onClick={lock}>
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
              placeholder={
                isMobile || compactSearch
                  ? "Search your vault"
                  : "Search names, contents, tags, folders   /"
              }
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onFocus={() => {
                setSearchFocused(true);
                void store.warmSearchIndex();
              }}
              onBlur={() => setTimeout(() => setSearchFocused(false), 150)}
              onKeyDown={(e) => {
                if (!searching) {
                  return;
                }
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setSearchCursor((c) => Math.min(c + 1, shownHits.length - 1));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setSearchCursor((c) => Math.max(c - 1, 0));
                } else if (e.key === "Enter" && shownHits[searchCursor]) {
                  e.preventDefault();
                  openFile(shownHits[searchCursor]!.file.id);
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
          <button
            className="btn"
            title="Create a note, document, spreadsheet or folder"
            aria-haspopup="menu"
            onClick={(event) => {
              // Anchored under the button, so the menu reads as belonging to
              // it. On a phone the same component becomes a bottom sheet.
              const at = event.currentTarget.getBoundingClientRect();
              setCtxMenu({ x: at.left, y: at.bottom + 6, title: "Create", items: newItems });
            }}
          >
            <PlusGlyph /> <span className="btn-word">New</span>
          </button>
          <button
            className="btn"
            title="Upload a whole folder, structure preserved"
            onClick={() => folderInput.current?.click()}
          >
            <FolderGlyph size={14} /> <span className="btn-label">Folder</span>
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
          <input
            ref={folderInput}
            type="file"
            multiple
            hidden
            {...{ webkitdirectory: "" }}
            onChange={(e) => {
              const items = fromDirectoryInput([...(e.target.files ?? [])]);
              if (items.length > 0) {
                void store.uploadTree(items, currentFolderId);
              }
              e.target.value = "";
            }}
          />
          <input
            ref={cameraInput}
            type="file"
            accept="image/*,image/heic,image/heif"
            capture="environment"
            hidden
            onChange={(e) => {
              uploadTo([...(e.target.files ?? [])]);
              e.target.value = "";
            }}
          />
          {/* Naming the formats outright, wildcard-free, is what stops iOS
              transcoding picked photos to JPEG before the page ever sees
              them; see PHOTO_ACCEPT. */}
          <input
            ref={photoInput}
            type="file"
            accept={PHOTO_ACCEPT}
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
            {view.kind === "folder" && !searching && !similarActive ? (
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
              <span className="current">{similarActive ? "Similar items" : viewTitle}</span>
            )}
            <span className="crumb-note">
              {searching
                ? `for “${query}”${
                    store.indexWarm
                      ? ` · indexing ${store.indexWarm.done} of ${store.indexWarm.total}`
                      : ""
                  }`
                : similarActive
                  ? `like “${similarTo!.name}”`
                  : view.kind === "shared"
                  ? "links and file requests"
                  : view.kind === "profile"
                  ? "account, security, and settings"
                  : `${visibleFiles.length} file${visibleFiles.length === 1 ? "" : "s"}${
                      view.kind === "folder" && childFolders.length
                        ? ` · ${childFolders.length} folder${childFolders.length === 1 ? "" : "s"}`
                        : ""
                    }`}
            </span>
            {(searching || similarActive) && (
              <button
                className="icon-btn"
                onClick={() => {
                  setQuery("");
                  setSimilarTo(null);
                  setSimilarHits([]);
                }}
                title={searching ? "Clear search" : "Back to files"}
              >
                <XGlyph size={13} />
              </button>
            )}
          </div>
          {showViewControls && (
            <div className="view-controls">
              {(view.kind === "photos" || view.kind === "album") && (
                <div className="seg">
                  <button className={photosFavOnly ? "" : "active"} onClick={() => setPhotosFavOnly(false)}>
                    All
                  </button>
                  <button
                    className={photosFavOnly ? "active" : ""}
                    title="Only favorites"
                    onClick={() => setPhotosFavOnly(true)}
                  >
                    <StarGlyph size={12} />
                  </button>
                </div>
              )}
              {!selectMode && visibleFiles.length > 0 && (
                <button
                  className="btn btn-ghost select-toggle"
                  onClick={() => setSelectMode(true)}
                >
                  Select
                </button>
              )}
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

        <div
          className="content"
          onClick={(e) => e.target === e.currentTarget && clearSelection()}
          {...(isMobile ? pullToRefresh.containerProps : {})}
        >
          {(pullToRefresh.pulling || pullToRefresh.refreshing) && (
            <div className="ptr-indicator" aria-live="polite">
              {pullToRefresh.refreshing ? "Refreshing…" : "Release to refresh"}
            </div>
          )}
          {/* Above the files, and only when it has something to say. It is
              deliberately not shown while searching or in trash: both are
              places you arrived at with a question of your own. */}
          {!searching && (view.kind === "folder" || view.kind === "expiring") && (
            <>
              <HeadsUp
                files={liveFiles}
                onOpen={(id) => openFile(id)}
                onConfirm={(fileId, factId, value) => void store.confirmFact(fileId, factId, value)}
                onDismiss={(fileId, factId) => void store.dismissFact(fileId, factId)}
              />
              <TripHeadsUp files={liveFiles} onOpen={(id) => openFile(id)} />
            </>
          )}
          {searching ? (
            <SearchResults
              hits={shownHits}
              folders={store.folders}
              cursor={searchCursor}
              selection={selection}
              onSelect={select}
              onOpen={openFile}
              onMenu={openFileMenu}
            />
          ) : similarActive ? (
            <SearchResults
              hits={similarHits}
              folders={store.folders}
              cursor={-1}
              selection={selection}
              onSelect={select}
              onOpen={openFile}
              onMenu={openFileMenu}
            />
          ) : view.kind === "shared" ? (
            <SharedView onToast={showToast} />
          ) : view.kind === "calendar" ? (
            <CalendarView files={liveFiles} onOpen={openFile} />
          ) : view.kind === "profile" ? (
            <ProfileView
              ocrOn={ocrOn}
              onToggleOcr={toggleOcr}
              semanticOn={semanticOn}
              onToggleSemantic={toggleSemantic}
              factsOn={factsOn}
              onToggleFacts={() => {
                const next = !factsOn;
                setFactsEnabled(next);
                setFactsOn(next);
              }}
              entitiesOn={entitiesOn}
              onToggleEntities={() => {
                const next = !entitiesOn;
                setEntitiesEnabled(next);
                setEntitiesOn(next);
              }}
              theme={theme}
              onToggleTheme={toggleTheme}
              accent={accent}
              onAccent={(id) => {
                applyAccent(id);
                setAccent(id);
              }}
              onOpenTwoFactor={() => setSecurityOpen(true)}
              onLock={lock}
              onSignOut={signOut}
              onToast={showToast}
            />
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
          ) : !searching &&
            (view.kind === "photos" ||
              view.kind === "album" ||
              (layout === "grid" &&
                view.kind === "category" &&
                (view.name === "Photos" || view.name === "Screenshots")) ||
              (view.kind === "favorites" &&
                visibleFiles.length > 0 &&
                visibleFiles.every((f) => {
                  const kind = fileKind(f.mime, f.name);
                  return kind === "image" || kind === "video";
                }))) ? (
            <PhotoGrid
              files={visibleFiles}
              selection={selection}
              selectMode={selectMode}
              onSelect={(id, e) => (selectMode ? toggleSelect(id) : select(id, e))}
              onOpen={openFile}
              onMenu={openFileMenu}
              onEnterSelect={enterSelect}
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
                      onMenu={(x, y) => openFolderMenu(folder.id, x, y)}
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
                onMenu={openFileMenu}
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
                    onMenu={(x, y) => openFolderMenu(folder.id, x, y)}
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
                  selectMode={selectMode}
                  onToggleSelect={() => toggleSelect(file.id)}
                  onSelect={(e) => select(file.id, e)}
                  onOpen={() => openFile(file.id)}
                  onMenu={(x, y) => openFileMenu(file.id, x, y)}
                  onDragStart={(e) => startFileDrag(file.id, e)}
                />
              ))}
            </div>
          )}
        </div>
      </main>

      {(isMobile ? detailsSheet && detailsFile !== null : detailsOpen) &&
        view.kind !== "trash" &&
        view.kind !== "shared" && (
          <DetailsPanel
            file={detailsFile}
            allFiles={liveFiles}
            selectionCount={selection.size}
            onOpen={openFile}
            onEdit={(id) => setEditorId(id)}
            onDownload={download}
            onShare={(id) => setShareId(id)}
            onRename={(id) => setRenameFileId(id)}
            onTrash={(id) => {
              const name = store.files.get(id)?.name;
              void store.trashFile(id);
              clearSelection();
              // The sheet was opened on this file; with the file gone it
              // must close, and the action needs an acknowledgement.
              setDetailsSheet(false);
              setDetailsFileId(null);
              setDetailsOpen(false);
              showToast(name ? `Moved "${name}" to trash` : "Moved to trash");
            }}
            onTagClick={searchTag}
            onOpenAlbum={(tag) => {
              setQuery("");
              setView({ kind: "album", tag });
            }}
            onAddToAlbum={(id) => setAlbumPickerIds([id])}
            onToast={showToast}
            onClose={() => {
              diag("details", "closed: the close button");
              if (isMobile) {
                setDetailsSheet(false);
                setDetailsFileId(null);
                return;
              }
              setDetailsOpen(false);
              persist("engramer-details", false);
            }}
          />
        )}

      <nav className="tabbar">
        <button
          className={`tab${view.kind === "folder" && !drawerOpen ? " active" : ""}`}
          onClick={() => {
            setQuery("");
            setDrawerOpen(false);
            setView({ kind: "folder", id: null });
          }}
        >
          <FolderGlyph size={19} />
          <span>Files</span>
        </button>
        <button
          className={`tab${view.kind === "recent" && !drawerOpen ? " active" : ""}`}
          onClick={() => {
            setQuery("");
            setDrawerOpen(false);
            setView({ kind: "recent" });
          }}
        >
          <ClockGlyph size={19} />
          <span>Recent</span>
        </button>
        <button className="tab tab-add" aria-label="Add" onClick={openAddSheet}>
          <PlusGlyph size={22} />
        </button>
        <button
          className={`tab${view.kind === "favorites" && !drawerOpen ? " active" : ""}`}
          onClick={() => {
            setQuery("");
            setDrawerOpen(false);
            setView({ kind: "favorites" });
          }}
        >
          <StarGlyph size={19} />
          <span>Favorites</span>
        </button>
        <button
          className={`tab${drawerOpen ? " active" : ""}`}
          onClick={() => {
            // The drawer and the details sheet never stack.
            if (detailsSheet) {
              diag("details", "closed: the More drawer opened");
            }
            setDetailsSheet(false);
            setDrawerOpen(true);
          }}
        >
          <MenuGlyph size={19} />
          <span>More</span>
        </button>
      </nav>

      {/* One stacked column holds every phone-bottom overlay so they never
          overlap; see .bottom-stack in styles.css. */}
      <div className="bottom-stack">
        {updateReady && (
          <div className="update-bar" role="status">
            <span>
              Version {updateReady} is ready. This window is running {APP_VERSION}.
            </span>
            <button className="btn btn-primary" onClick={() => void reloadForUpdate()}>
              Reload
            </button>
            <button className="icon-btn" title="Later" onClick={() => setUpdateReady(null)}>
              <XGlyph />
            </button>
          </div>
        )}
        {store.batch && (
          <div className="ocr-pill">
            <span className="spinner" />
            Uploading {store.batch.current || "…"} · {store.batch.done + store.batch.failed} of{" "}
            {store.batch.total}
            {store.batch.failed > 0 ? ` · ${store.batch.failed} failed` : ""}
            {store.batchStop && (
              <button className="tray-cancel" onClick={() => store.batchStop?.()}>
                Stop
              </button>
            )}
          </div>
        )}
        {store.ocrProgress && (
          <div className="ocr-pill">
            <span className="spinner" />
            Reading {store.ocrProgress.current} · {store.ocrProgress.done + 1} of{" "}
            {store.ocrProgress.total}
          </div>
        )}
        {store.semanticProgress && (
          <div className="ocr-pill">
            <span className="spinner" />
            Indexing {store.semanticProgress.current} · {store.semanticProgress.done + 1} of{" "}
            {store.semanticProgress.total}
          </div>
        )}
        {store.thumbProgress && (
          <div className="ocr-pill">
            <span className="spinner" />
            Preparing {store.thumbProgress.current} · {store.thumbProgress.done + 1} of{" "}
            {store.thumbProgress.total}
          </div>
        )}
        {toast && <div className="toast">{toast}</div>}
        {store.reveal && (
          <RevealToast
            onOpen={(folderId) => {
              store.dismissReveal();
              setQuery("");
              setView({ kind: "folder", id: folderId });
            }}
          />
        )}
        <UploadTray />
        {(selectMode || selection.size > 1) && (
          <SelectionBar
            count={selection.size}
            total={visibleFiles.length}
            onFavorite={() => {
              for (const id of selection) {
                void store.toggleFavorite(id);
              }
            }}
            onAlbum={() => setAlbumPickerIds([...selection])}
            onMove={() => setMoveIds([...selection])}
            onDownload={() => {
              for (const id of selection) {
                const file = store.files.get(id);
                if (file) {
                  download(file);
                }
              }
            }}
            onTrash={() => {
              for (const id of selection) {
                void store.trashFile(id);
              }
              clearSelection();
            }}
            onSelectAll={() => setSelection(new Set(visibleFiles.map((f) => f.id)))}
            onDone={clearSelection}
          />
        )}
      </div>
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
      {albumPickerIds && (
        <AlbumPicker
          albums={albums}
          count={albumPickerIds.length}
          onPick={(tag) => addSelectionToAlbum(albumPickerIds, tag)}
          onClose={() => setAlbumPickerIds(null)}
        />
      )}
      {paletteOpen && (
        <CommandPalette actions={paletteActions} onOpenFile={openFile} onClose={() => setPaletteOpen(false)} />
      )}
      {previewFile && !editorFile && (
        <Preview
          file={previewFile}
          onClose={() => setPreviewId(null)}
          onFavorite={() => void store.toggleFavorite(previewFile.id)}
          onShare={() => {
            setShareId(previewFile.id);
            setPreviewId(null);
          }}
          onStep={(direction) => {
            const to = stepThrough(
              visibleFiles.map((f) => f.id),
              previewFile.id,
              direction,
            );
            if (to) {
              setPreviewId(to);
            }
          }}
          canStepBack={stepThrough(visibleFiles.map((f) => f.id), previewFile.id, -1) !== null}
          canStepOn={stepThrough(visibleFiles.map((f) => f.id), previewFile.id, 1) !== null}
          onRename={() => setRenameFileId(previewFile.id)}
          onDetails={() => {
            setPreviewId(null);
            inspect(previewFile.id);
          }}
          onEdit={
            ["text", "doc", "sheet"].includes(fileKind(previewFile.mime, previewFile.name))
              ? () => {
                  setEditorId(previewFile.id);
                  setPreviewId(null);
                }
              : undefined
          }
        />
      )}
      {editorFile && officeKind(editorFile) ? (
        <Suspense
          fallback={
            <div className="preview-shell">
              <div className="spinner" style={{ margin: "auto" }} />
            </div>
          }
        >
          <OfficeEditor
            file={editorFile}
            fileType={officeKind(editorFile)!}
            onSave={async (bytes, opts) => {
              // The saved bytes are a fresh document; its words join the
              // search index the same way an upload's do.
              const text = await extractText(
                new File([bytes.slice().buffer as ArrayBuffer], editorFile.name, {
                  type: editorFile.mime,
                }),
              ).catch(() => undefined);
              await store.saveFileBinary(editorFile.id, bytes, text, {
                collabSnapshot: opts?.snapshot,
                collabUpTo: opts?.upTo,
                collabMode: opts?.mode,
                collabConn: opts?.conn,
              });
            }}
            onSaveCopy={async (bytes) => {
              const text = await extractText(
                new File([bytes.slice().buffer as ArrayBuffer], editorFile.name, {
                  type: editorFile.mime,
                }),
              ).catch(() => undefined);
              const id = await store.saveFileCopy(editorFile.id, bytes, text);
              setEditorId(id);
              showToast("Saved as your own copy.");
            }}
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
      {newOfficeKind && (
        <TextPrompt
          title={newOfficeKind === "docx" ? "New document" : "New spreadsheet"}
          sub="Created empty and encrypted here, then opened for editing."
          submitLabel="Create and open"
          onSubmit={async (name) => {
            const id = await store.createOfficeDocument(name, newOfficeKind, currentFolderId);
            setEditorId(id);
          }}
          onClose={() => setNewOfficeKind(null)}
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
      {adminOpen && <AdminPanel onToast={showToast} onClose={() => setAdminOpen(false)} />}
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
      {unlockPromptOpen && (
        <Confirm
          title="Unlock with Touch ID next time?"
          sub="Skip the password on this device: your vault key stays wrapped under a key only this device's screen-lock passkey can release. Signing out removes it, and you can disable it anytime from the command palette."
          confirmLabel="Enable"
          onConfirm={enrollUnlock}
          onClose={() => {
            setUnlockPromptOpen(false);
            if (!hasDeviceUnlock()) {
              markUnlockDeclined();
            }
          }}
        />
      )}
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
  if (props.view.kind === "expiring") {
    return (
      <div className="empty">
        <span className="empty-mark">◷</span>
        <h3>Nothing is expiring</h3>
        <p>
          Dates found in your documents appear here once you confirm them. Turn on "Read dates in
          documents" in your profile to start looking.
        </p>
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
  if (props.view.kind === "photos" || props.view.kind === "album") {
    return (
      <div className="empty">
        <span className="empty-mark">▦</span>
        <h3>{props.view.kind === "album" ? "This album is empty" : "No photos yet"}</h3>
        <p>Photos and videos you add appear here as a timeline.</p>
        <div className="empty-actions">
          <button className="btn btn-primary" onClick={props.onUpload}>
            Add photos
          </button>
        </div>
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

function ResultRow(props: {
  hit: SearchHit;
  path: string | null;
  index: number;
  cursor: boolean;
  selected: boolean;
  onSelect: (event: React.MouseEvent) => void;
  onOpen: () => void;
  onMenu: (x: number, y: number) => void;
}) {
  const { hit } = props;
  const longPress = useLongPress(props.onMenu);
  const coarse = window.matchMedia("(pointer: coarse)").matches;

  return (
    <div
      className={`row result${props.selected ? " selected" : ""}${props.cursor ? " cursor" : ""}`}
      data-cursor={props.cursor}
      style={{ "--i": Math.min(props.index, 20) } as CSSProperties}
      onClick={(e) => (coarse ? props.onOpen() : props.onSelect(e))}
      onDoubleClick={props.onOpen}
      onContextMenu={(e) => {
        e.preventDefault();
        props.onMenu(e.clientX, e.clientY);
      }}
      {...longPress}
    >
      <ResultThumb file={hit.file} />
      <div className="row-main">
        <div className="name">
          <Highlighted value={hit.file.name} ranges={hit.nameRanges} />
        </div>
        <div className="result-where">
          {props.path ? (
            <span className={hit.matchedFolder ? "result-folder hit" : "result-folder"}>
              <FolderGlyph size={11} /> {props.path}
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
      {hit.semantic && <span className="row-tag meaning">meaning</span>}
      {hit.file.category && <span className="row-tag">{hit.file.category}</span>}
      <span className="row-meta">{formatBytes(hit.file.size)}</span>
    </div>
  );
}

function SearchResults(props: {
  hits: SearchHit[];
  folders: ReadonlyMap<string, FolderEntry>;
  cursor: number;
  selection: ReadonlySet<string>;
  onSelect: (id: string, event: React.MouseEvent) => void;
  onOpen: (id: string) => void;
  onMenu: (id: string, x: number, y: number) => void;
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
      {props.hits.map((hit, i) => (
        <ResultRow
          key={hit.file.id}
          hit={hit}
          path={folderPath(hit.file.folderId, props.folders)}
          index={i}
          cursor={i === props.cursor}
          selected={props.selection.has(hit.file.id)}
          onSelect={(e) => props.onSelect(hit.file.id, e)}
          onOpen={() => props.onOpen(hit.file.id)}
          onMenu={(x, y) => props.onMenu(hit.file.id, x, y)}
        />
      ))}
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
