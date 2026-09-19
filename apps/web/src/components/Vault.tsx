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
  applyAccent,
  applyTheme,
  currentAccent,
  currentTheme,
  type ThemeMode,
} from "../theme";
import { mergeSearchHits, searchFiles, type SearchHit } from "../search";
import {
  interpretationSchema,
  isQuestionShaped,
  promptFor,
  shouldInterpret,
  toQueryString,
  topTags,
  validateInterpretation,
  type Vocabulary,
} from "../search/natural";
import { SCENES } from "../intel/scenes";
import { collectDropped, fromDirectoryInput, type TreeFile } from "../uploader";
import { MOBILE_QUERY, useMediaQuery, useViewportWidth } from "../media";
import {
  DETAILS_DEFAULT,
  SIDEBAR_DEFAULT,
  planLayout,
  resizeDetails,
  resizeSidebar,
} from "../layout";
import { useDivider } from "../usedivider";
import { isGathering, nextSelection } from "../selection";
import { isEmptySpace, marqueeSelection, useMarquee } from "../marquee";
import { FILE_DRAG_TYPE, useDropTarget } from "../droptarget";
import { setFileDragImage } from "../dragghost";
import type { BulkResult } from "../store";
import { describeProcessing } from "../activity";
import { ActivityBell, ActivityPanel } from "./Activity";
import { AskCard, type AskStatus } from "./AskCard";
import { buildAskPrompt, excerpts, rankSources, retrievalTerms } from "../intel/ask";
import { AssistantError, lastAssistantState } from "../intel/assistant";
import { dueNotices } from "../notices";
import {
  DECISIONS_EVENT,
  decisionEvents,
  pinned,
  recentSearches as accountRecentSearches,
  rememberSearch,
  setPin,
} from "../decisions";
import { notifyDue } from "../notifications";
import { installMediaKeyResponder } from "../mediastream";
import { installHandoffForegroundRefresh } from "../handoff";
import { idleLockMinutes, installIdleLock } from "../idlelock";
import { installAutoSync } from "../autosync";
import { folderPath, SearchResults } from "./SearchResults";
import {
  clearNativeUnlock,
  deviceUnlockSupported,
  enrollDeviceUnlock,
  enrollNativeUnlock,
  hasDeviceUnlock,
  markUnlockDeclined,
  unlockDeclined,
} from "../unlock";
import { nativeOpenWith, nativeShell, nativeUnlockAvailable, pickPhotos } from "../native";
import {
  installSettingsSync,
  pullSettings,
  settingsEvents,
  SETTINGS_APPLIED_EVENT,
} from "../settingsync";
import { downloadAndDecrypt, type UploadSource } from "../transfer";
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
import {
  assistantEnabled,
  assistantState,
  describeAssistantState,
  generate as assistantGenerate,
  setAssistantEnabled,
} from "../intel/assistant";
import { DATED_KINDS, soonestDated } from "../intel/facts";
import { extractText } from "../intel/extract";
import { CalendarView } from "./CalendarView";
import { HeadsUp, TripHeadsUp } from "./HeadsUp";
import { extension, fileKind, formatBytes } from "../format";
import { albumTitle, albumsFrom, type Album } from "../albums";
import { orderCollections } from "../sidebar";
import { PhotoGrid } from "./PhotoGrid";
import { AlbumPicker } from "./AlbumPicker";
import { SelectionBar } from "./SelectionBar";
import { usePullToRefresh } from "../pulltorefresh";
import { useKeyboardInset } from "../keyboard";
import { saveDecryptedFile } from "../download";
import { offlineExcuse } from "../offlinefiles";
import { clearThumbnailCache } from "../thumbs";
import { FileCard, FolderCard } from "./FileCard";
import { BrandMark, FolderArt, Wordmark } from "./FileArt";
import { FileList, sortFiles, type SortKey, type SortState } from "./FileList";
import { DetailsPanel } from "./DetailsPanel";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { MoveDialog } from "./MoveDialog";
import { Preview } from "./Preview";
import { Editor } from "./Editor";
import { ImageEditor } from "./ImageEditor";
import type { ExtractedEntry } from "../archive";
import { isHandheld } from "../analysisslot";

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
import { SaveOverlay } from "./SaveOverlay";
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
  ChevronRightGlyph,
  MonitorGlyph,
  MoveGlyph,
  NoteGlyph,
  OfflineGlyph,
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

const DRAG_TYPE = FILE_DRAG_TYPE;

/** A breadcrumb that takes a drop and springs open when a drag lingers. */
function Crumb(props: {
  label: string;
  onOpen: () => void;
  onDropFiles: (event: DragEvent) => void;
}) {
  const drop = useDropTarget(props.onDropFiles, { springLoad: props.onOpen });
  return (
    <button className={drop.dropping ? "drop-target" : undefined} onClick={props.onOpen} {...drop.props}>
      {props.label}
    </button>
  );
}

function loadPref<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
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
  // The columns' chosen widths and the sidebar's collapsed state, remembered
  // like any other layout preference; the plan below fits them to the window.
  const [sidebarWidth, setSidebarWidth] = useState(() =>
    loadPref("engramer-sidebar-w", SIDEBAR_DEFAULT),
  );
  const [detailsWidth, setDetailsWidth] = useState(() =>
    loadPref("engramer-details-w", DETAILS_DEFAULT),
  );
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() =>
    loadPref("engramer-sidebar-collapsed", false),
  );
  const [albumsOpen, setAlbumsOpen] = useState(() => loadPref("engramer-side-albums", true));
  const [libraryOpen, setLibraryOpen] = useState(() => loadPref("engramer-side-library", true));
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
  const [activityOpen, setActivityOpen] = useState(false);
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
  // A toast that created or moved something carries the way there.
  const [toast, setToast] = useState<{ text: string; action?: () => void } | null>(null);
  const [updateReady, setUpdateReady] = useState<string | null>(null);
  const [theme, setTheme] = useState<ThemeMode>(() => currentTheme());
  const [accent, setAccent] = useState<string>(() => currentAccent());
  const [searchFocused, setSearchFocused] = useState(false);
  const [searchCursor, setSearchCursor] = useState(0);
  // The account's recent searches, re-read when a decision lands from
  // any device.
  const [recentSearches, setRecentSearches] = useState<string[]>(() =>
    accountRecentSearches(store.session?.email ?? ""),
  );
  useEffect(() => {
    const account = store.session?.email ?? "";
    const reread = () => {
      setRecentSearches(accountRecentSearches(account));
      setPins(pinned(account));
    };
    reread();
    decisionEvents.addEventListener(DECISIONS_EVENT, reread);
    return () => decisionEvents.removeEventListener(DECISIONS_EVENT, reread);
  }, [store.session?.email]);
  const [ocrOn, setOcrOn] = useState(() => ocrEnabled());
  const [semanticOn, setSemanticOn] = useState(() => semanticEnabled());
  const [factsOn, setFactsOn] = useState(() => factsEnabled());
  const [entitiesOn, setEntitiesOn] = useState(() => entitiesEnabled());
  const [assistantOn, setAssistantOn] = useState(() => assistantEnabled());
  // Whether the on-device model is here, probed on mount and on every
  // return to the foreground (a downloading model becomes ready silently).
  const [assistantReady, setAssistantReady] = useState(false);
  // A sentence the assistant read into filters, keyed by the exact query it
  // read; "×" on the line remembers the query the user wants as typed.
  const [interpretation, setInterpretation] = useState<{ literal: string; rewritten: string } | null>(null);
  const [interpretDismissed, setInterpretDismissed] = useState<string | null>(null);
  // A question in the search field, and where its answer stands. Keyed by
  // the exact question; a changed query is a new question. Never stored.
  const [ask, setAsk] = useState<{ question: string; status: AskStatus } | null>(null);
  const askAbort = useRef<AbortController | null>(null);
  const [semanticHits, setSemanticHits] = useState<SearchHit[]>([]);
  const [similarTo, setSimilarTo] = useState<FileEntry | null>(null);
  const [similarHits, setSimilarHits] = useState<SearchHit[]>([]);
  const isMobile = useMediaQuery(MOBILE_QUERY);
  // The Mac shell hides the system title bar; the app's own top strip
  // takes its place and starts below the inset traffic lights.
  const macShell = nativeShell() && !isHandheld();
  const viewportWidth = useViewportWidth();
  const plan = planLayout(viewportWidth, {
    sidebarWidth,
    detailsWidth,
    sidebarCollapsed,
    detailsOpen,
  });
  const frameRef = useRef<HTMLDivElement>(null);

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((collapsed) => {
      persist("engramer-sidebar-collapsed", !collapsed);
      return !collapsed;
    });
  }, []);
  const toggleDetails = useCallback(() => {
    setDetailsOpen((open) => {
      persist("engramer-details", !open);
      return !open;
    });
  }, []);

  // Dividers: the sidebar's reads its width from the pointer; pulled well
  // past its floor it snaps to the rail. The details' does the same and
  // closes, keeping the width it had before the drag so it reopens as it
  // was. Every landing is written down as it happens: a drag that ends on
  // a snap must not be remembered as the last width the pointer crossed.
  const sidebarDragStart = useRef(SIDEBAR_DEFAULT);
  const sidebarDivider = useDivider({
    onStart: () => {
      sidebarDragStart.current = sidebarWidth;
    },
    onDrag: (clientX) => {
      const left = frameRef.current?.getBoundingClientRect().left ?? 0;
      const landed = resizeSidebar(clientX - left);
      if (landed.collapsed) {
        setSidebarCollapsed(true);
        setSidebarWidth(sidebarDragStart.current);
        persist("engramer-sidebar-collapsed", true);
        persist("engramer-sidebar-w", sidebarDragStart.current);
      } else {
        setSidebarCollapsed(false);
        setSidebarWidth(landed.width);
        persist("engramer-sidebar-collapsed", false);
        persist("engramer-sidebar-w", landed.width);
      }
    },
    onEnd: () => {},
    onReset: () => {
      setSidebarWidth(SIDEBAR_DEFAULT);
      setSidebarCollapsed(false);
      persist("engramer-sidebar-w", SIDEBAR_DEFAULT);
      persist("engramer-sidebar-collapsed", false);
    },
  });
  const detailsDragStart = useRef(DETAILS_DEFAULT);
  const detailsDivider = useDivider({
    onStart: () => {
      detailsDragStart.current = detailsWidth;
    },
    onDrag: (clientX) => {
      const right = frameRef.current?.getBoundingClientRect().right ?? window.innerWidth;
      const landed = resizeDetails(right - clientX);
      if (!landed.open) {
        setDetailsOpen(false);
        setDetailsWidth(detailsDragStart.current);
        persist("engramer-details", false);
        persist("engramer-details-w", detailsDragStart.current);
      } else {
        setDetailsOpen(true);
        setDetailsWidth(landed.width);
        persist("engramer-details", true);
        persist("engramer-details-w", landed.width);
      }
    },
    onEnd: () => {},
    onReset: () => {
      setDetailsWidth(DETAILS_DEFAULT);
      persist("engramer-details-w", DETAILS_DEFAULT);
    },
  });

  // A phone drawer left open has no meaning once the window is wide again;
  // its backdrop would sit over the desktop layout.
  useEffect(() => {
    if (!isMobile) {
      setDrawerOpen(false);
      setDetailsSheet(false);
    }
  }, [isMobile]);

  // The floating details pane starts under the toolbar, so its buttons
  // (the details toggle among them) stay reachable while it is up.
  const topbarRef = useRef<HTMLDivElement>(null);
  const [topbarHeight, setTopbarHeight] = useState(65);
  useEffect(() => {
    const bar = topbarRef.current;
    if (!bar) {
      return;
    }
    const measure = () => setTopbarHeight(bar.getBoundingClientRect().height);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(bar);
    return () => observer.disconnect();
  }, []);
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

  const showToast = useCallback((message: string, action?: () => void) => {
    setToast({ text: message, action });
    if (toastTimer.current) {
      clearTimeout(toastTimer.current);
    }
    // One with somewhere to go stays a little longer.
    toastTimer.current = setTimeout(() => setToast(null), action ? 5000 : 3200);
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
  // What the user pinned follows the account (decisions.ts); the sidebar
  // leads with it, then with what changed most recently.
  const [pins, setPins] = useState<Set<string>>(() => pinned(store.session?.email ?? ""));
  const orderedAlbums = useMemo(() => orderCollections(albums, pins), [albums, pins]);
  const albumCovers = useMemo(() => {
    const byId = new Map(liveFiles.map((f) => [f.id, f]));
    return orderedAlbums.map((album) => ({
      album,
      cover: album.coverFileId ? byId.get(album.coverFileId) : undefined,
    }));
  }, [orderedAlbums, liveFiles]);

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

  const literalHits = useMemo(
    () => (searching ? searchFiles(store.files.values(), query, store.folders) : []),
    [store.files, store.folders, query, searching],
  );
  const interpretedActive =
    interpretation !== null && interpretation.literal === query && interpretDismissed !== query;
  const askable = searching && assistantReady && assistantOn && isQuestionShaped(query.trim());
  // The engine runs the assistant's rewrite when there is one for exactly
  // this query; the words as typed are one click away on the line above.
  const hits = useMemo(
    () =>
      interpretedActive && interpretation
        ? searchFiles(store.files.values(), interpretation.rewritten, store.folders)
        : literalHits,
    [interpretedActive, interpretation, literalHits, store.files, store.folders],
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

  // The bulk bar shows exactly while this holds, and clicks toggle exactly
  // while the bar shows: one predicate for what is seen and what happens.
  const gathering = isGathering(selectMode, selection.size);

  const select = useCallback(
    (id: string, event: React.MouseEvent) => {
      setSelection((prev) => {
        const next = nextSelection(
          { selection: prev, anchor: lastSelected.current },
          id,
          visibleFiles.map((f) => f.id),
          {
            meta: event.metaKey || event.ctrlKey,
            shift: event.shiftKey,
            gathering: isGathering(selectMode, prev.size),
          },
        );
        lastSelected.current = next.anchor;
        return next.selection;
      });
    },
    [visibleFiles, selectMode],
  );

  const selectAll = useCallback(() => {
    setSelection(new Set(visibleFiles.map((f) => f.id)));
    // Everything picked is a gathering, whichever button asked for it.
    setSelectMode(true);
  }, [visibleFiles]);

  // Rubber band on empty space. The band replaces the selection as it is
  // drawn, or adds to what was selected when ⇧ or ⌘ was held at the start.
  const contentRef = useRef<HTMLDivElement>(null);
  const bandBase = useRef<ReadonlySet<string>>(new Set());
  const bandStarted = useRef(false);
  const band = useMarquee(contentRef, {
    onChange: (ids, extend) => {
      if (!bandStarted.current) {
        bandStarted.current = true;
        bandBase.current = selection;
      }
      setSelection(marqueeSelection(bandBase.current, ids, extend));
    },
  });
  useEffect(() => {
    if (!band) {
      bandStarted.current = false;
    }
  }, [band]);

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

  /** An archive's entries into the vault, in a folder named after it,
   * through the tree upload so nested folders come along. */
  const extractInto = async (entries: ExtractedEntry[], archive: FileEntry) => {
    const base = archive.name.replace(/\.(zip|tar|tgz|tar\.gz)$/i, "") || "Extracted";
    const items: TreeFile[] = entries.map((entry) => {
      const parts = entry.path.split("/");
      const name = parts.pop() ?? "file";
      return {
        file: new File([entry.data.slice().buffer as ArrayBuffer], name),
        path: [base, ...parts],
      };
    });
    setPreviewId(null);
    await store.uploadTree(items, archive.shared ? null : archive.folderId);
    showToast(`Extracted ${items.length === 1 ? "1 file" : `${items.length} files`} into ${base}`);
  };

  /** Hands a decrypted copy to whatever app the Mac has for it. */
  const openElsewhere = async (file: FileEntry) => {
    const token = store.session?.token;
    if (!token) {
      return;
    }
    try {
      const opened = await nativeOpenWith(file, token);
      if (!opened) {
        showToast("This shell cannot open files in other apps; use Download.");
      }
    } catch (err) {
      showToast(err instanceof Error && err.message ? `Could not open: ${err.message}` : "Could not open the file.");
    }
  };

  /** One PDF from several, in the order the view shows them; a new file
   * beside the first, with the Activity log saying what was combined. */
  const combinePdfs = async (ids: string[]) => {
    const files = ids.map((id) => store.files.get(id)).filter((f): f is FileEntry => Boolean(f));
    if (files.length < 2) {
      return;
    }
    store.beginActivity({ kind: "processing", title: "Combining PDFs", done: 0, total: files.length, failed: 0 });
    try {
      const documents: Uint8Array[] = [];
      for (const file of files) {
        documents.push(await downloadAndDecrypt(file.id, file.key, file.digest));
        store.updateActivity({ done: documents.length });
      }
      const { mergeDocuments } = await import("../pdf/pages");
      const bytes = await mergeDocuments(documents);
      const name = `${files[0]!.name.replace(/\.pdf$/i, "")} + ${files.length - 1} more.pdf`;
      const id = await store.saveFileCopy(files[0]!.id, bytes, undefined, { name });
      store.finishActivity("processing", `Combined ${files.length} PDFs into ${name}`);
      clearSelection();
      showToast(`Saved ${name}`, () => setPreviewId(id));
    } catch (err) {
      store.finishActivity("processing", "Could not combine the PDFs", err instanceof Error ? err.message : undefined);
      showToast("Could not combine the PDFs.");
    }
  };

  /** The album a change just touched: its sidebar row shows itself. */
  const [revealTag, setRevealTag] = useState<string | null>(null);
  const revealAlbum = (tag: string) => {
    // A group the user just added to opens, whatever its remembered
    // state, and the row is scrolled into view and lit for a moment.
    setAlbumsOpen(true);
    persist("engramer-side-albums", true);
    setRevealTag(tag);
    setTimeout(() => {
      document
        .querySelector<HTMLElement>(`[data-album="${tag}"]`)
        ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }, 60);
    setTimeout(() => setRevealTag((current) => (current === tag ? null : current)), 1800);
  };

  const openAlbum = (tag: string) => {
    setQuery("");
    setDrawerOpen(false);
    setView({ kind: "album", tag });
  };

  const addSelectionToAlbum = (ids: string[], tag: string) => {
    setAlbumPickerIds(null);
    void store
      .addToAlbum(ids, tag)
      .then(() => {
        revealAlbum(tag);
        showToast(
          `Added ${ids.length === 1 ? "1 item" : `${ids.length} items`} to ${albumTitle(tag)}`,
          () => openAlbum(tag),
        );
      })
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
    void saveDecryptedFile(file).catch((err: unknown) =>
      showToast(
        offlineExcuse(navigator.onLine) ??
          (err instanceof Error && err.message ? `Download failed: ${err.message}` : "Download failed."),
      ),
    );
  };

  const toggleOffline = (file: FileEntry) => {
    const kept = store.offline.some((entry) => entry.fileId === file.id && entry.pinned);
    if (kept) {
      void store
        .unpinOffline(file.id)
        .then(() => showToast(`"${file.name}" is no longer kept offline.`));
    } else {
      void store
        .pinOffline(file.id)
        .then((pinned) =>
          showToast(
            pinned
              ? `"${file.name}" is available offline.`
              : "Could not save this file for offline access.",
          ),
        );
    }
  };

  const openFile = (id: string) => {
    // A search is remembered; a question asked of the assistant is not,
    // and the answer's sources open through here too.
    if (query.trim() && !isQuestionShaped(query.trim())) {
      setRecentSearches(rememberSearch(store.session?.email ?? "", query));
    }
    setPreviewId(id);
    setQuery("");
  };

  // A folder opens on one click. The second click of a double-click lands
  // on whatever card now sits under the pointer inside that folder, and
  // used to open it too, two levels down in one gesture.
  const lastFolderOpen = useRef(0);
  const openFolder = (id: string) => {
    const now = Date.now();
    if (now - lastFolderOpen.current < 350) {
      return;
    }
    lastFolderOpen.current = now;
    setView({ kind: "folder", id });
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
    // The assistant reads text-bearing files on request too, where it is
    // present; the automatic pass does the same in the background.
    ...(assistantReady &&
    assistantOn &&
    !/^(image|video|audio)\//.test(file.mime) &&
    (file.hasText || file.inlineText)
      ? [
          {
            id: "summarize",
            label: file.summary ? "Summarize again" : "Summarize now",
            icon: <SparkGlyph size={13} />,
            run: () => {
              showToast("Reading on this device…");
              void store
                .processFile(file.id, { force: { summary: true } })
                .then((outcome) =>
                  showToast(
                    outcome && outcome.summaries > 0
                      ? "Summary added; see the details pane."
                      : "The assistant could not summarize this file.",
                  ),
                )
                .catch(() => showToast("The assistant could not summarize this file."));
            },
          },
        ]
      : []),
    { id: "download", label: "Download", icon: <DownloadGlyph size={13} />, run: () => download(file) },
    // The Mac's other apps: the shell decrypts a private copy and asks
    // the system to open it. Where there is no shell, Download is the way.
    ...(nativeShell() && !isHandheld()
      ? [{ id: "open-with", label: "Open in another app", run: () => void openElsewhere(file) }]
      : []),
    // Offline access is a shell promise: the store on disk does not
    // exist in a plain browser, so the choice only appears where it can
    // be kept.
    ...(nativeShell()
      ? [
          {
            id: "offline",
            label: store.offline.some((e) => e.fileId === file.id && e.pinned)
              ? "Remove offline access"
              : "Offline access",
            icon: <OfflineGlyph size={13} />,
            run: () => toggleOffline(file),
          },
        ]
      : []),
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
    // The ghost says what travels: this card's picture and how many more.
    const img = (event.currentTarget as HTMLElement).querySelector("img");
    setFileDragImage(event.dataTransfer, {
      thumb: img?.currentSrc || img?.src || null,
      label: store.files.get(id)?.name ?? "",
      count: ids.length,
    });
  };

  /** What a move did, in words that count only what actually moved. */
  const describeMove = (result: BulkResult, destination: string | null) => {
    const where = destination === null ? "All files" : (store.folders.get(destination)?.name ?? "the folder");
    const moved = result.done.length;
    const head =
      moved === 0
        ? "Nothing moved"
        : `Moved ${moved} item${moved === 1 ? "" : "s"} to ${where}`;
    return result.failed.length === 0
      ? head
      : `${head} · ${result.failed.length} could not be moved`;
  };

  const dropOnFolder = (folderId: string | null, event: React.DragEvent) => {
    try {
      const ids = JSON.parse(event.dataTransfer.getData(DRAG_TYPE)) as string[];
      void store.moveFiles(ids, folderId).then((result) => {
        showToast(describeMove(result, folderId));
        clearSelection();
      });
    } catch {
      // Not an internal drag.
    }
  };

  // Drop targets that are not folder cards: the sidebar's Files entry is the
  // root, and every breadcrumb is an ancestor. Crumbs spring open on hover
  // like folder cards; the root entry does not, it is already where you are.
  const rootDrop = useDropTarget((event) => dropOnFolder(null, event));

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
      } else if ((event.metaKey || event.ctrlKey) && event.altKey && event.code === "KeyS") {
        // ⌘⌥S, the Finder's own: the sidebar folds to a rail and back.
        event.preventDefault();
        toggleSidebar();
      } else if ((event.metaKey || event.ctrlKey) && event.altKey && event.code === "KeyI") {
        event.preventDefault();
        toggleDetails();
      } else if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === "a" &&
        !typing &&
        !paletteOpen &&
        !previewId &&
        !editorId &&
        !ctxMenu &&
        visibleFiles.length > 0
      ) {
        event.preventDefault();
        selectAll();
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
  }, [
    paletteOpen,
    selection,
    selectMode,
    previewId,
    editorId,
    ctxMenu,
    drawerOpen,
    clearSelection,
    selectAll,
    visibleFiles.length,
    toggleSidebar,
    toggleDetails,
  ]);

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

  useEffect(() => {
    let live = true;
    const probe = () => {
      void assistantState({ refresh: true }).then((state) => {
        if (live) {
          setAssistantReady(state.state === "available");
        }
      });
    };
    probe();
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        probe();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      live = false;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  // A sentence the literal search cannot serve goes to the on-device model
  // once it settles; the answer is kept only if the vocabulary and the
  // calendar confirm it, and only for this exact query.
  useEffect(() => {
    const trimmed = query.trim();
    if (
      !shouldInterpret(trimmed, {
        available: assistantReady,
        enabled: assistantOn,
        literalHits: literalHits.length,
      }) ||
      interpretDismissed === query
    ) {
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      const { instructions, prompt } = promptFor(trimmed, vocabularyRef.current, new Date());
      void assistantGenerate({
        instructions,
        prompt,
        priority: "interactive",
        schema: interpretationSchema,
        signal: controller.signal,
      })
        .then((raw) => {
          if (controller.signal.aborted) {
            return;
          }
          const parsed = validateInterpretation(raw, vocabularyRef.current, new Date(), trimmed);
          if (parsed) {
            const rewritten = toQueryString(parsed);
            diag("search", `interpreted "${trimmed}" as "${rewritten}"`);
            setInterpretation({ literal: query, rewritten });
          }
        })
        .catch((err: unknown) => {
          diag("search", `interpretation declined: ${err instanceof Error ? err.message : String(err)}`);
        });
    }, 350);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [query, assistantReady, assistantOn, literalHits.length, interpretDismissed]);

  // What is due reaches the system's notifications once the library has
  // settled, one notification per fact, never twice; the pass is a few
  // seconds behind the last change so a sync in progress does not fire it
  // several times.
  useEffect(() => {
    const account = store.session?.email;
    if (!account) {
      return;
    }
    const timer = setTimeout(() => {
      void notifyDue(account, dueNotices(liveFiles, Date.now())).then((sent) => {
        if (sent > 0) {
          diag("notices", `${sent} notification${sent === 1 ? "" : "s"} sent`);
        }
      });
    }, 3000);
    return () => clearTimeout(timer);
  }, [liveFiles, store.session?.email]);

  const stopAsk = useCallback(() => {
    askAbort.current?.abort();
    askAbort.current = null;
    setAsk((current) => (current ? { question: current.question, status: { kind: "offer" } } : null));
  }, []);

  // A new query is a new question: whatever was being answered stops.
  useEffect(() => {
    askAbort.current?.abort();
    askAbort.current = null;
    setAsk(null);
  }, [query]);

  /**
   * Answers the question from the few files that can: the retrieval reads
   * what is already known about every file (names, tags, summaries, text)
   * plus the meaning matches, fetches the text of the picked sources on
   * demand, and hands the model excerpts only. Nothing is persisted.
   */
  const runAsk = useCallback(
    async (question: string) => {
      askAbort.current?.abort();
      const controller = new AbortController();
      askAbort.current = controller;
      setAsk({ question, status: { kind: "running", answer: "", sources: [] } });
      const terms = retrievalTerms(question);
      const boosts = new Map(semanticHits.map((hit) => [hit.file.id, 1.5]));
      const ranked = rankSources(liveFiles, terms, boosts);
      if (ranked.length === 0) {
        setAsk({ question, status: { kind: "empty" } });
        return;
      }
      const sources = [];
      for (const file of ranked) {
        const text = file.text ?? (file.hasText ? await store.loadText(file.id) : undefined);
        if (controller.signal.aborted) {
          return;
        }
        sources.push({ id: file.id, name: file.name, summary: file.summary, excerpts: text ? excerpts(text, terms) : [] });
      }
      const state = lastAssistantState();
      const built = buildAskPrompt(question, sources, state.state === "available" ? state.contextSize : 4096);
      const used = sources.filter((source) => built.used.includes(source.id)).map(({ id, name }) => ({ id, name }));
      diag("ask", `${used.length} source${used.length === 1 ? "" : "s"}`);
      try {
        const answer = await assistantGenerate({
          instructions: built.instructions,
          prompt: built.prompt,
          priority: "interactive",
          maxTokens: 350,
          deadlineMs: 25_000,
          signal: controller.signal,
          onChunk: (text) => setAsk({ question, status: { kind: "running", answer: text, sources: used } }),
        });
        if (!controller.signal.aborted) {
          setAsk({ question, status: { kind: "done", answer: typeof answer === "string" ? answer : String(answer ?? ""), sources: used } });
        }
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }
        const code = error instanceof AssistantError ? error.code : "other";
        setAsk({
          question,
          status: {
            kind: "error",
            message:
              code === "guardrail"
                ? "The assistant declined to answer this."
                : code === "timeout"
                  ? "The assistant took too long; try a shorter question."
                  : "The assistant could not answer right now.",
          },
        });
      } finally {
        if (askAbort.current === controller) {
          askAbort.current = null;
        }
      }
    },
    [liveFiles, semanticHits, store],
  );

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

  // Lock after inactivity, where the account has asked for it: the same
  // lock as the button, so device unlock or the password reopens it.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => installIdleLock({ minutes: idleLockMinutes, onLock: lock }), []);

  // Sync is a client-driven pull; this adds the foreground-and-interval
  // heartbeat that makes shared documents and phone uploads appear on
  // their own.
  useEffect(() => installAutoSync(), []);
  // What finished while this account was away, per device.
  const sessionEmail = store.session?.email;
  useEffect(() => {
    if (sessionEmail) {
      useStore.getState().loadActivity();
    }
  }, [sessionEmail]);

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
    // Interrupted uploads wait for exactly this moment: signed in, synced,
    // the shell reachable. Whatever cannot continue is cleaned up, and the
    // staging directory is swept around what can.
    void useStore.getState().scanResumableUploads();
    // What the shell already keeps offline, so badges and the Profile
    // row are truthful from the first paint.
    void useStore.getState().refreshOffline();
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
      setAssistantOn(assistantEnabled());
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
    // The topbar's Folder upload button folds into this menu when the
    // content column is narrow, so the action never disappears with it.
    {
      id: "upload-folder",
      label: "Upload a folder…",
      icon: <UploadGlyph size={15} />,
      run: () => folderInput.current?.click(),
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
      // Development builds only: one round trip through the on-device
      // assistant, so a shell build can be checked without any feature
      // that uses it.
      ...(import.meta.env.DEV
        ? [
            {
              id: "assistant-self-test",
              label: "Assistant self-test",
              hint: "one short answer from the on-device model",
              run: () => {
                void assistantState({ refresh: true }).then(async (state) => {
                  if (state.state !== "available") {
                    showToast(describeAssistantState(state));
                    return;
                  }
                  try {
                    const answer = await assistantGenerate({
                      instructions: "Answer with the requested structure only.",
                      prompt: "Name one everyday object and its color.",
                      priority: "interactive",
                      schema: {
                        type: "object",
                        properties: {
                          object: { type: "string", description: "the object" },
                          color: { type: "string", enum: ["red", "green", "blue", "other"] },
                        },
                        required: ["object", "color"],
                        order: ["object", "color"],
                      },
                    });
                    showToast(`Assistant answered: ${JSON.stringify(answer)}`);
                  } catch (err) {
                    showToast(`Assistant refused: ${err instanceof Error ? err.message : String(err)}`);
                  }
                });
              },
            },
          ]
        : []),
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
      { id: "toggle-sidebar", label: "Show or hide the sidebar", hint: "⌘⌥S", run: toggleSidebar },
      { id: "toggle-details", label: "Show or hide details", hint: "⌘⌥I", run: toggleDetails },
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
          void store.processLibrary().then((counts) => showToast(describeProcessing(counts).title));
        },
      },
      {
        id: "clip-all",
        label: "Index photos and videos by meaning",
        hint: "on-device; find media by what is in it, and label it",
        run: () => {
          if (!semanticEnabled()) {
            setSemanticEnabled(true);
            setSemanticOn(true);
          }
          void store.processLibrary().then((counts) => showToast(describeProcessing(counts).title));
        },
      },
      {
        id: "fill-in",
        label: "Fill in everything missing",
        hint: "previews, tags, text and meaning in one pass",
        run: () => {
          void store.processLibrary().then((counts) => showToast(describeProcessing(counts).title));
        },
      },
      {
        id: "tidy-backup-names",
        label: "Tidy backed-up photo names",
        hint: "renames earlier backups to their camera names",
        run: () => {
          void store.tidyBackupNames().then((renamed) => {
            showToast(
              renamed > 0
                ? `Renamed ${renamed} backed-up file${renamed === 1 ? "" : "s"}.`
                : "Every backed-up file already carries its camera name.",
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

  // The vocabulary the assistant may use, read at the moment of a request
  // rather than tracked as a dependency: the library changes constantly and
  // must not re-run an interpretation under a query the user has settled.
  const vocabularyRef = useRef<Vocabulary>({ categories: [], scenes: [], tags: [], folders: [] });
  vocabularyRef.current = {
    categories: libraryCategories,
    scenes: SCENES.map((scene) => scene.label),
    tags: topTags(liveFiles, 50),
    folders: [...store.folders.values()].map((folder) => folder.name),
  };


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
    drop?: typeof rootDrop,
  ) => (
    <button
      className={`nav-item${active && !searching ? " active" : ""}${drop?.dropping ? " drop-target" : ""}`}
      onClick={() => {
        setQuery("");
        setDrawerOpen(false);
        onClick();
      }}
      {...(drop ? drop.props : {})}
      title={label}
    >
      {icon} <span className="nav-label">{label}</span>
      {count !== undefined && count > 0 && <span className="nav-count">{count}</span>}
    </button>
  );

  /** A sidebar section heading that folds its list, Finder-style. */
  // A group header keeps its icon in the rail (only the words go), so a
  // group is never without a footprint; collapsed, it shows its count.
  const sectionLabel = (
    icon: React.ReactNode,
    label: string,
    open: boolean,
    onToggle: () => void,
    count?: number,
  ) => (
    <button className="sidebar-label" aria-expanded={open} onClick={onToggle} title={label}>
      {icon} <span className="sidebar-label-text">{label}</span>
      {!open && count !== undefined && count > 0 && <span className="nav-count">{count}</span>}
      <span className="disclosure" aria-hidden="true">
        <ChevronRightGlyph size={11} />
      </span>
    </button>
  );

  return (
    <div
      ref={frameRef}
      className={`frame${dragging ? " dropzone-active" : ""}${plan.details === "pane" ? " with-details" : ""}${
        plan.details === "overlay" ? " details-overlay" : ""
      }${plan.sidebar === "rail" ? " sidebar-rail" : ""}${plan.compact ? " compact" : ""}${drawerOpen ? " drawer" : ""}${
        macShell ? " shell-mac" : ""
      }`}
      style={
        {
          "--sidebar-w": `${plan.sidebarWidth}px`,
          "--details-w": `${plan.detailsWidth}px`,
          "--topbar-h": `${topbarHeight}px`,
        } as CSSProperties
      }
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
      {/* The dividers belong to the frame, not to the panels they resize:
          a scrolling panel clips whatever pokes past its edge. */}
      {!isMobile && (
        <div
          className={`divider divider-sidebar${sidebarDivider.active ? " active" : ""}`}
          title="Drag to resize · double-click to reset"
          {...sidebarDivider.props}
        />
      )}
      {!isMobile && plan.details === "pane" && (
        <div
          className={`divider divider-details${detailsDivider.active ? " active" : ""}`}
          title="Drag to resize · double-click to reset"
          {...detailsDivider.props}
        />
      )}
      <aside className="sidebar">
        {/* In the Mac shell the title bar is the app's own top strip: the
            brand row and the top bar drag the window, and the sidebar
            starts below the inset traffic lights. */}
        <div className="brand" data-tauri-drag-region>
          <BrandMark size={26} />
          <Wordmark />
        </div>
        {navButton(
          view.kind === "folder",
          () => setView({ kind: "folder", id: null }),
          <FolderGlyph />,
          "Files",
          undefined,
          rootDrop,
        )}
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
            {sectionLabel(
              <BookGlyph size={12} />,
              "Albums",
              albumsOpen,
              () => {
                setAlbumsOpen(!albumsOpen);
                persist("engramer-side-albums", !albumsOpen);
              },
              albums.length,
            )}
            {albumsOpen && (
            <div className="library-list" data-group="albums">
              {orderedAlbums.map((album) => (
                <button
                  key={album.tag}
                  data-album={album.tag}
                  className={`nav-item small${
                    view.kind === "album" && view.tag === album.tag && !searching ? " active" : ""
                  }${revealTag === album.tag ? " reveal" : ""}`}
                  onClick={() => openAlbum(album.tag)}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    const isPinned = pins.has(album.tag);
                    setCtxMenu({
                      x: event.clientX,
                      y: event.clientY,
                      title: album.title,
                      items: [
                        { id: "open", label: "Open", run: () => openAlbum(album.tag) },
                        {
                          id: "pin",
                          label: isPinned ? "Unpin" : "Pin to the top",
                          run: () => setPin(store.session?.email ?? "", album.tag, !isPinned),
                        },
                      ],
                    });
                  }}
                >
                  <PhotoGlyph size={14} />
                  {album.title}
                  {pins.has(album.tag) && <span className="nav-pin">pinned</span>}
                  <span className="nav-count">{album.count}</span>
                </button>
              ))}
            </div>
            )}
          </>
        )}

        {libraryCategories.length > 0 && (
          <>
            {sectionLabel(
              <SparkGlyph size={12} />,
              "Library",
              libraryOpen,
              () => {
                setLibraryOpen(!libraryOpen);
                persist("engramer-side-library", !libraryOpen);
              },
              libraryCategories.length,
            )}
            {libraryOpen && (
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
            )}
          </>
        )}

        <div className="spacer" />
        {/* The foot holds state, never settings: the switches and the
            appearance live in Profile > Preferences (IA §4.4). */}
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
        <div className="topbar" ref={topbarRef} data-tauri-drag-region>
          <button
            className={`icon-btn sidebar-toggle${plan.sidebar === "rail" ? " active" : ""}`}
            title={plan.sidebar === "rail" ? "Show sidebar (⌘⌥S)" : "Hide sidebar (⌘⌥S)"}
            aria-label={plan.sidebar === "rail" ? "Show sidebar" : "Hide sidebar"}
            onClick={toggleSidebar}
          >
            <MenuGlyph size={16} />
          </button>
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
                } else if (e.key === "Enter" && askable && shownHits.length === 0) {
                  // Nothing to open, and the query is a question: ask it.
                  e.preventDefault();
                  void runAsk(query.trim());
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
          <ActivityBell
            open={activityOpen}
            onToggle={() => {
              setActivityOpen((open) => !open);
            }}
          />
          <button className="icon-btn add-btn" title="Add to your vault" aria-label="Add" onClick={openAddSheet}>
            <PlusGlyph size={18} />
          </button>
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
            className="btn folder-btn"
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
            title={detailsOpen ? "Hide details (⌘⌥I)" : "Show details (⌘⌥I)"}
            onClick={toggleDetails}
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
                <Crumb
                  label="All files"
                  onOpen={() => setView({ kind: "folder", id: null })}
                  onDropFiles={(e) => dropOnFolder(null, e)}
                />
                {breadcrumbs.map((crumb, i) => (
                  <span key={crumb.id} style={{ display: "contents" }}>
                    <span className="sep">/</span>
                    {i === breadcrumbs.length - 1 ? (
                      <span className="current">{crumb.name}</span>
                    ) : (
                      <Crumb
                        label={crumb.name}
                        onOpen={() => setView({ kind: "folder", id: crumb.id })}
                        onDropFiles={(e) => dropOnFolder(crumb.id, e)}
                      />
                    )}
                  </span>
                ))}
              </>
            ) : (
              <span className="current">{similarActive ? "Similar items" : viewTitle}</span>
            )}
            <span className="crumb-note">
              {searching ? (
                <>
                  {`for “${query}”${
                    store.indexWarm
                      ? ` · indexing ${store.indexWarm.done} of ${store.indexWarm.total}`
                      : ""
                  }`}
                  {interpretedActive && interpretation && (
                    <>
                      {" · interpreted as "}
                      {interpretation.rewritten.split(" ").map((token, i) => (
                        <span key={`${token}-${i}`} className="search-op mono interpreted-token">
                          {token}
                        </span>
                      ))}
                      <button
                        className="interpret-off"
                        title="Search these words as typed instead"
                        aria-label="Search these words as typed instead"
                        onClick={() => setInterpretDismissed(query)}
                      >
                        ×
                      </button>
                    </>
                  )}
                </>
              ) : similarActive
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
          ref={contentRef}
          className="content"
          onClick={(e) => isEmptySpace(e.target) && clearSelection()}
          {...(isMobile ? pullToRefresh.containerProps : {})}
        >
          {band && (
            <div
              className="marquee"
              aria-hidden="true"
              style={{
                left: band.rect.left,
                top: band.rect.top,
                width: band.rect.right - band.rect.left,
                height: band.rect.bottom - band.rect.top,
              }}
            />
          )}
          {(pullToRefresh.pulling || pullToRefresh.refreshing) && (
            <div className="ptr-indicator" aria-live="polite">
              {pullToRefresh.refreshing ? "Refreshing…" : "Release to refresh"}
            </div>
          )}
          {/* Above the files, and only when it has something to say. It is
              deliberately not shown while searching or in trash: both are
              places you arrived at with a question of your own. */}
          {askable && (
            <AskCard
              question={query.trim()}
              status={ask && ask.question === query.trim() ? ask.status : { kind: "offer" }}
              onAsk={() => void runAsk(query.trim())}
              onStop={stopAsk}
              onOpen={openFile}
            />
          )}
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
              assistantOn={assistantOn}
              onToggleAssistant={() => {
                const next = !assistantOn;
                setAssistantEnabled(next);
                setAssistantOn(next);
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
              onSelect={select}
              onOpen={openFile}
              onMenu={openFileMenu}
              onEnterSelect={enterSelect}
              onDragStart={startFileDrag}
              // Albums are content as well as places: the Photos place
              // carries a shelf of them, so they are reachable without the
              // sidebar at all (IA §4.6).
              albums={view.kind === "photos" ? albumCovers : undefined}
              onOpenAlbum={openAlbum}
              onNewAlbum={() => {
                setSelectMode(true);
                showToast("Select photos, then choose Add to album.");
              }}
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
                      onOpen={() => openFolder(folder.id)}
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
                    onOpen={() => openFolder(folder.id)}
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

      {(isMobile ? detailsSheet && detailsFile !== null : plan.details === "pane" || plan.details === "overlay") &&
        view.kind !== "trash" &&
        view.kind !== "shared" && (
          <DetailsPanel
            file={detailsFile}
            selectionCount={selection.size}
            selectionBytes={[...selection].reduce((sum, id) => sum + (store.files.get(id)?.size ?? 0), 0)}
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

      {/* The phone's places, per IA §6: Files, Photos, Search, Notices,
          More. Tabs are places, never actions: Add lives in the top bar. */}
      <nav className="tabbar">
        <button
          className={`tab${view.kind === "folder" && !drawerOpen && !activityOpen ? " active" : ""}`}
          onClick={() => {
            setQuery("");
            setDrawerOpen(false);
            setActivityOpen(false);
            setView({ kind: "folder", id: null });
          }}
        >
          <FolderGlyph size={19} />
          <span>Files</span>
        </button>
        <button
          className={`tab${view.kind === "photos" && !drawerOpen && !activityOpen ? " active" : ""}`}
          onClick={() => {
            setQuery("");
            setDrawerOpen(false);
            setActivityOpen(false);
            setView({ kind: "photos" });
          }}
        >
          <PhotoGlyph size={19} />
          <span>Photos</span>
        </button>
        <button
          className={`tab${searchFocused || searching ? " active" : ""}`}
          onClick={() => {
            setDrawerOpen(false);
            setActivityOpen(false);
            searchInput.current?.focus();
          }}
        >
          <SearchGlyph size={19} />
          <span>Search</span>
        </button>
        <button
          className={`tab${activityOpen ? " active" : ""}`}
          onClick={() => {
            setDrawerOpen(false);
            setActivityOpen((open) => !open);
          }}
        >
          <InboxGlyph size={19} />
          <span>Notices</span>
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
        {activityOpen && (
          <ActivityPanel
            sheet={isMobile}
            onClose={() => setActivityOpen(false)}
            onOpen={(id) => {
              setActivityOpen(false);
              openFile(id);
            }}
            onOpenProfile={() => {
              setActivityOpen(false);
              setView({ kind: "profile" });
            }}
          />
        )}
        {toast &&
          (toast.action ? (
            <button
              className="toast toast-action"
              onClick={() => {
                toast.action?.();
                setToast(null);
              }}
            >
              {toast.text} <span className="toast-go">Open</span>
            </button>
          ) : (
            <div className="toast">{toast.text}</div>
          ))}
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
        <SaveOverlay />
        {gathering && (
          <SelectionBar
            count={selection.size}
            total={visibleFiles.length}
            onFavorite={() => {
              // One request flips them all; a mixed selection becomes all
              // favorites, the Finder's rule for a mixed toggle.
              const ids = [...selection];
              const allOn = ids.every((id) => store.files.get(id)?.favorite);
              void store
                .patchFilesMeta(ids, (file) =>
                  file.favorite === !allOn ? null : { favorite: !allOn },
                )
                .then((result) => {
                  if (result.failed.length > 0) {
                    showToast(`${result.failed.length} could not be updated`);
                  }
                });
            }}
            onAlbum={() => setAlbumPickerIds([...selection])}
            onMove={() => setMoveIds([...selection])}
            onCombinePdf={
              selection.size >= 2 &&
              [...selection].every((id) => {
                const file = store.files.get(id);
                return file && !file.shared && fileKind(file.mime, file.name) === "pdf";
              })
                ? () => void combinePdfs(visibleFiles.filter((f) => selection.has(f.id)).map((f) => f.id))
                : undefined
            }
            onDownload={() => {
              for (const id of selection) {
                const file = store.files.get(id);
                if (file) {
                  download(file);
                }
              }
            }}
            onTrash={() => {
              const ids = [...selection];
              void store.trashFiles(ids).then((result) => {
                const moved = result.done.length;
                showToast(
                  result.failed.length === 0
                    ? `Moved ${moved} item${moved === 1 ? "" : "s"} to trash`
                    : `Moved ${moved} to trash · ${result.failed.length} could not be moved`,
                );
              });
              clearSelection();
            }}
            onSelectAll={selectAll}
            onDone={clearSelection}
          />
        )}
      </div>
      {ctxMenu && <ContextMenu {...ctxMenu} onClose={() => setCtxMenu(null)} />}
      {moveIds && (
        <MoveDialog
          fileIds={moveIds}
          onMoved={(result, destination) => {
            showToast(describeMove(result, destination));
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
        <CommandPalette
          actions={paletteActions}
          onOpenFile={openFile}
          onClose={() => setPaletteOpen(false)}
          onAsk={
            assistantReady && assistantOn
              ? (question) => {
                  // The palette mirrors; the search field is the home.
                  setQuery(question);
                  searchInput.current?.focus();
                  void runAsk(question);
                }
              : undefined
          }
        />
      )}
      {previewFile && !editorFile && (
        <Preview
          file={previewFile}
          onClose={() => setPreviewId(null)}
          onToast={showToast}
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
            ["text", "doc", "sheet", "image"].includes(fileKind(previewFile.mime, previewFile.name)) &&
            !previewFile.shared
              ? () => {
                  setEditorId(previewFile.id);
                  setPreviewId(null);
                }
              : undefined
          }
          onExtract={
            previewFile.shared
              ? undefined
              : async (entries) => {
                  await extractInto(entries, previewFile);
                }
          }
          onOpenElsewhere={
            nativeShell() && !isHandheld()
              ? () => {
                  void openElsewhere(previewFile);
                }
              : undefined
          }
          // A PDF is marked up, filled in and re-paged inside the preview;
          // every write is a new version through the one binary save.
          onSavePdf={
            previewFile.shared
              ? undefined
              : async (bytes) => {
                  await store.saveFileBinary(previewFile.id, bytes);
                  store.finishActivity("processing", `Saved ${previewFile.name}`, "A new version with your changes.");
                }
          }
          onSavePdfCopy={
            previewFile.shared
              ? undefined
              : async (bytes, name) => {
                  const id = await store.saveFileCopy(previewFile.id, bytes, undefined, { name });
                  store.finishActivity("processing", `Extracted pages to ${name}`);
                  showToast(`Saved ${name}`, () => {
                    setPreviewId(id);
                  });
                }
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
      ) : editorFile && fileKind(editorFile.mime, editorFile.name) === "image" ? (
        <ImageEditor
          file={editorFile}
          onSave={async (bytes, mime, name) => {
            if (name === editorFile.name) {
              // Same type: a new version of the same picture.
              await store.saveFileBinary(editorFile.id, bytes);
              store.finishActivity("processing", `Saved ${editorFile.name}`, "A new version with your edits.");
            } else {
              // A HEIC (or another type the browser cannot write) becomes a
              // JPEG beside the original, which stays as it was.
              const id = await store.saveFileCopy(editorFile.id, bytes, undefined, { name });
              store.finishActivity("processing", `Saved ${name}`, `Edited from ${editorFile.name}.`);
              showToast(`Saved ${name}`, () => setPreviewId(id));
            }
          }}
          onClose={() => setEditorId(null)}
        />
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
