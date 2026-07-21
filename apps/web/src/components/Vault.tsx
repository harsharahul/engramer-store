import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
} from "react";
import { useStore, type FileEntry } from "../store";
import { searchFiles } from "../search";
import { extension, fileKind, formatBytes, formatDate } from "../format";
import { saveDecryptedFile } from "../download";
import { clearThumbnailCache } from "../thumbs";
import { FileCard, FolderCard } from "./FileCard";
import { Preview } from "./Preview";
import { Editor } from "./Editor";
import { ShareDialog } from "./ShareDialog";
import { UploadTray } from "./UploadTray";
import { TagEditor } from "./TagEditor";
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
  EaselGlyph,
  FolderGlyph,
  GridGlyph,
  Keyhole,
  LockGlyph,
  MonitorGlyph,
  NoteGlyph,
  PenNibGlyph,
  PhotoGlyph,
  PlusGlyph,
  ReceiptGlyph,
  RestoreGlyph,
  SearchGlyph,
  SparkGlyph,
  StarGlyph,
  TrashGlyph,
  UploadGlyph,
  VideoGlyph,
  XGlyph,
} from "./Icon";

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

type View =
  | { kind: "folder"; id: string | null }
  | { kind: "recent" }
  | { kind: "trash" }
  | { kind: "favorites" }
  | { kind: "category"; name: string };

const CATEGORY_ORDER = [
  "Photos",
  "Screenshots",
  "Documents",
  "Receipts",
  "Notes",
  "Code",
  "Videos",
  "Audio",
  "Spreadsheets",
  "Presentations",
  "Design",
  "Archives",
  "Books",
  "Other",
];

export function Vault() {
  const store = useStore();
  const [view, setView] = useState<View>({ kind: "folder", id: null });
  const [query, setQuery] = useState("");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [editorId, setEditorId] = useState<string | null>(null);
  const [newNoteOpen, setNewNoteOpen] = useState(false);
  const [shareId, setShareId] = useState<string | null>(null);
  const [tagsId, setTagsId] = useState<string | null>(null);
  const [renameFileId, setRenameFileId] = useState<string | null>(null);
  const [renameFolderId, setRenameFolderId] = useState<string | null>(null);
  const [deleteFolderId, setDeleteFolderId] = useState<string | null>(null);
  const [deleteForeverId, setDeleteForeverId] = useState<string | null>(null);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const dragDepth = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  const allTags = useMemo(() => {
    const counts = new Map<string, number>();
    for (const file of liveFiles) {
      for (const tag of file.tags) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([tag]) => tag);
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

  const childFiles = useMemo(
    () =>
      liveFiles
        .filter((f) => f.folderId === currentFolderId)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [liveFiles, currentFolderId],
  );

  const recentFiles = useMemo(
    () => [...liveFiles].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 60),
    [liveFiles],
  );

  const favoriteFiles = useMemo(() => liveFiles.filter((f) => f.favorite), [liveFiles]);

  const categoryFiles = useMemo(
    () =>
      view.kind === "category"
        ? liveFiles
            .filter((f) => (f.category ?? "Other") === view.name)
            .sort((a, b) => b.updatedAt - a.updatedAt)
        : [],
    [liveFiles, view],
  );

  const trashedFiles = useMemo(
    () =>
      [...store.files.values()]
        .filter((f) => f.trashed)
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [store.files],
  );

  const hits = useMemo(
    () => (searching ? searchFiles(store.files.values(), query, store.folders) : []),
    [store.files, store.folders, query, searching],
  );

  const previewFile = previewId ? store.files.get(previewId) : undefined;
  const editorFile = editorId ? store.files.get(editorId) : undefined;
  const shareFile = shareId ? store.files.get(shareId) : undefined;
  const tagsFile = tagsId ? store.files.get(tagsId) : undefined;
  const renameFile = renameFileId ? store.files.get(renameFileId) : undefined;
  const renameFolder = renameFolderId ? store.folders.get(renameFolderId) : undefined;

  const uploadTo = useCallback(
    (files: File[]) => {
      if (files.length > 0) {
        void store.uploadFiles(files, currentFolderId);
      }
    },
    [store, currentFolderId],
  );

  // Cmd+K opens the palette; "/" jumps to search when not already typing.
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
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [paletteOpen]);

  // Paste an image or file anywhere to upload it.
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

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    uploadTo([...event.dataTransfer.files]);
  };

  const lock = () => {
    clearThumbnailCache();
    store.logout();
  };

  const download = (file: FileEntry) => {
    void saveDecryptedFile(file).catch(() => showToast("Download failed."));
  };

  const searchTag = (tag: string) => {
    setQuery(`tag:${tag}`);
    searchInput.current?.focus();
  };

  const paletteActions = useMemo<PaletteAction[]>(
    () => [
      { id: "upload", label: "Upload files", hint: "encrypt and store", run: () => fileInput.current?.click() },
      { id: "new-note", label: "New note", hint: "write, encrypted", run: () => setNewNoteOpen(true) },
      { id: "new-folder", label: "New folder", run: () => setNewFolderOpen(true) },
      { id: "go-files", label: "Go to All files", run: () => setView({ kind: "folder", id: null }) },
      { id: "go-recent", label: "Go to Recent", run: () => setView({ kind: "recent" }) },
      { id: "go-favorites", label: "Go to Favorites", run: () => setView({ kind: "favorites" }) },
      { id: "go-trash", label: "Go to Trash", run: () => setView({ kind: "trash" }) },
      { id: "lock", label: "Lock vault and sign out", run: lock },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const usagePercent = store.usage
    ? Math.min(100, Math.round((store.usage.usedBytes / store.usage.quotaBytes) * 100))
    : 0;

  const libraryCategories = CATEGORY_ORDER.filter((c) => (categoryCounts.get(c) ?? 0) > 0);

  const openFile = (id: string) => {
    setPreviewId(id);
    setQuery("");
  };

  const fileCardProps = (file: FileEntry, index: number) => ({
    key: file.id,
    file,
    index,
    onOpen: () => setPreviewId(file.id),
    onDownload: () => download(file),
    onShare: () => setShareId(file.id),
    onToggleFavorite: () => void store.toggleFavorite(file.id),
    onTagClick: searchTag,
    onTrash: () => void store.trashFile(file.id),
  });

  return (
    <div
      className={`frame${dragging ? " dropzone-active" : ""}`}
      onDragEnter={(e) => {
        e.preventDefault();
        dragDepth.current += 1;
        setDragging(true);
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) {
          setDragging(false);
        }
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
    >
      <aside className="sidebar">
        <div className="brand">
          <Keyhole size={19} />
          Engramer Store
        </div>
        <button
          className={`nav-item${view.kind === "folder" && !searching ? " active" : ""}`}
          onClick={() => {
            setQuery("");
            setView({ kind: "folder", id: null });
          }}
        >
          <FolderGlyph /> Files
        </button>
        <button
          className={`nav-item${view.kind === "recent" && !searching ? " active" : ""}`}
          onClick={() => {
            setQuery("");
            setView({ kind: "recent" });
          }}
        >
          <ClockGlyph /> Recent
        </button>
        <button
          className={`nav-item${view.kind === "favorites" && !searching ? " active" : ""}`}
          onClick={() => {
            setQuery("");
            setView({ kind: "favorites" });
          }}
        >
          <StarGlyph /> Favorites
          {favoriteFiles.length > 0 && <span className="nav-count">{favoriteFiles.length}</span>}
        </button>
        <button
          className={`nav-item${view.kind === "trash" && !searching ? " active" : ""}`}
          onClick={() => {
            setQuery("");
            setView({ kind: "trash" });
          }}
        >
          <TrashGlyph /> Trash
        </button>

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
              placeholder="Search names, contents, tags   /"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <button className="btn btn-ghost palette-trigger" onClick={() => setPaletteOpen(true)}>
            <SparkGlyph size={14} /> <kbd className="mono">⌘K</kbd>
          </button>
          <div className="grow" />
          <button className="btn" onClick={() => setNewFolderOpen(true)}>
            <PlusGlyph /> New folder
          </button>
          <button className="btn btn-brass" onClick={() => fileInput.current?.click()}>
            <UploadGlyph /> Upload
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

        <div className="content">
          {searching ? (
            <SearchResults
              hits={hits}
              query={query}
              onOpen={openFile}
              onClear={() => setQuery("")}
            />
          ) : view.kind === "trash" ? (
            <TrashList
              files={trashedFiles}
              onRestore={(id) => void store.restoreFile(id)}
              onDeleteForever={(id) => setDeleteForeverId(id)}
            />
          ) : view.kind === "recent" ? (
            <SimpleList title="Recent" files={recentFiles} onOpen={openFile} />
          ) : view.kind === "favorites" ? (
            <SimpleList
              title="Favorites"
              files={favoriteFiles}
              onOpen={openFile}
              emptyMark="☆"
              emptyTitle="No favorites yet"
              emptyHint="Tap the star on any file to keep it one click away."
            />
          ) : view.kind === "category" ? (
            <>
              <div className="crumbs">
                <span className="current">{view.name}</span>
                <span className="crumb-note">
                  auto-categorized on this device · {categoryFiles.length} item
                  {categoryFiles.length === 1 ? "" : "s"}
                </span>
              </div>
              <div className="grid">
                {categoryFiles.map((file, i) => (
                  <FileCard {...fileCardProps(file, i)} />
                ))}
              </div>
            </>
          ) : (
            <>
              <div className="crumbs">
                <button onClick={() => setView({ kind: "folder", id: null })}>All files</button>
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
              </div>

              {childFolders.length === 0 && childFiles.length === 0 ? (
                <div className="empty">
                  <span className="empty-mark">⌘</span>
                  <h3>{store.synced ? "An empty shelf" : "Decrypting your library"}</h3>
                  <p>
                    {store.synced
                      ? "Drop files anywhere, paste from the clipboard, or press ⌘K. Everything is encrypted and sorted on this device."
                      : "One moment."}
                  </p>
                </div>
              ) : (
                <div className="grid">
                  {childFolders.map((folder, i) => (
                    <FolderCard
                      key={folder.id}
                      name={folder.name}
                      count={folderCounts.get(folder.id) ?? 0}
                      index={i}
                      onOpen={() => setView({ kind: "folder", id: folder.id })}
                      onRename={() => setRenameFolderId(folder.id)}
                      onDelete={() => setDeleteFolderId(folder.id)}
                    />
                  ))}
                  {childFiles.map((file, i) => (
                    <FileCard {...fileCardProps(file, childFolders.length + i)} />
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </main>

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

      {paletteOpen && (
        <CommandPalette
          actions={paletteActions}
          onOpenFile={openFile}
          onClose={() => setPaletteOpen(false)}
        />
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
          onEditTags={() => setTagsId(previewFile.id)}
          onEdit={
            fileKind(previewFile.mime, previewFile.name) === "text"
              ? () => {
                  setEditorId(previewFile.id);
                  setPreviewId(null);
                }
              : undefined
          }
        />
      )}
      {editorFile && (
        <Editor
          file={editorFile}
          onSave={(content) => store.saveFileContent(editorFile.id, content)}
          onClose={() => setEditorId(null)}
        />
      )}
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
      {shareFile && (
        <ShareDialog file={shareFile} onClose={() => setShareId(null)} onToast={showToast} />
      )}
      {tagsFile && (
        <TagEditor
          file={tagsFile}
          suggestions={allTags}
          onSave={(tags) => store.setTags(tagsFile.id, tags)}
          onClose={() => setTagsId(null)}
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
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

/** The payoff moment: what was filed where, and what it was tagged. */
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
  const tags = first.tags.slice(0, 4);

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
          {tags.map((tag) => (
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

function SearchResults(props: {
  hits: ReturnType<typeof searchFiles>;
  query: string;
  onOpen: (id: string) => void;
  onClear: () => void;
}) {
  return (
    <>
      <div className="crumbs">
        <span className="current">
          {props.hits.length} result{props.hits.length === 1 ? "" : "s"} for “{props.query}”
        </span>
        <button onClick={props.onClear} title="Clear search">
          <XGlyph size={13} />
        </button>
      </div>
      {props.hits.length === 0 ? (
        <div className="empty">
          <span className="empty-mark">∅</span>
          <h3>No matches</h3>
          <p>
            Search covers names, tags, and text inside documents, decrypted only on this device.
            Try <code>tag:receipts</code>, <code>type:image</code>, or <code>is:favorite</code>.
          </p>
        </div>
      ) : (
        <div className="rows">
          {props.hits.map((hit, i) => (
            <div
              key={hit.file.id}
              className="row"
              style={{ "--i": Math.min(i, 20) } as CSSProperties}
              onClick={() => props.onOpen(hit.file.id)}
            >
              <span className="row-glyph">{extension(hit.file.name) || "FILE"}</span>
              <div className="row-main">
                <div className="name">{hit.file.name}</div>
                {hit.matchedText && <div className="snippet">{hit.matchedText}</div>}
              </div>
              {hit.file.category && <span className="row-tag">{hit.file.category}</span>}
              <span className="row-meta">{formatBytes(hit.file.size)}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function SimpleList(props: {
  title: string;
  files: FileEntry[];
  onOpen: (id: string) => void;
  emptyMark?: string;
  emptyTitle?: string;
  emptyHint?: string;
}) {
  return (
    <>
      <div className="crumbs">
        <span className="current">{props.title}</span>
      </div>
      {props.files.length === 0 ? (
        <div className="empty">
          <span className="empty-mark">{props.emptyMark ?? "◷"}</span>
          <h3>{props.emptyTitle ?? "Nothing yet"}</h3>
          {props.emptyHint && <p>{props.emptyHint}</p>}
        </div>
      ) : (
        <div className="rows">
          {props.files.map((file, i) => (
            <div
              key={file.id}
              className="row"
              style={{ "--i": Math.min(i, 20) } as CSSProperties}
              onClick={() => props.onOpen(file.id)}
            >
              <span className="row-glyph">{extension(file.name) || "FILE"}</span>
              <div className="row-main">
                <div className="name">{file.name}</div>
              </div>
              {file.category && <span className="row-tag">{file.category}</span>}
              <span className="row-meta">
                {formatBytes(file.size)} · {formatDate(file.updatedAt)}
              </span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function TrashList(props: {
  files: FileEntry[];
  onRestore: (id: string) => void;
  onDeleteForever: (id: string) => void;
}) {
  return (
    <>
      <div className="crumbs">
        <span className="current">Trash</span>
      </div>
      {props.files.length === 0 ? (
        <div className="empty">
          <span className="empty-mark">◌</span>
          <h3>Trash is empty</h3>
        </div>
      ) : (
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
                <button
                  className="icon-btn"
                  title="Delete forever"
                  onClick={() => props.onDeleteForever(file.id)}
                >
                  <XGlyph />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
