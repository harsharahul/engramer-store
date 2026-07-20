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
import { extension, formatBytes, formatDate } from "../format";
import { saveDecryptedFile } from "../download";
import { clearThumbnailCache } from "../thumbs";
import { FileCard, FolderCard } from "./FileCard";
import { Preview } from "./Preview";
import { ShareDialog } from "./ShareDialog";
import { UploadTray } from "./UploadTray";
import { Confirm, TextPrompt } from "./Dialogs";
import {
  ClockGlyph,
  FolderGlyph,
  Keyhole,
  LockGlyph,
  PlusGlyph,
  RestoreGlyph,
  SearchGlyph,
  TrashGlyph,
  UploadGlyph,
  XGlyph,
} from "./Icon";

type View = { kind: "folder"; id: string | null } | { kind: "recent" } | { kind: "trash" };

export function Vault() {
  const store = useStore();
  const [view, setView] = useState<View>({ kind: "folder", id: null });
  const [query, setQuery] = useState("");
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [shareId, setShareId] = useState<string | null>(null);
  const [renameFileId, setRenameFileId] = useState<string | null>(null);
  const [renameFolderId, setRenameFolderId] = useState<string | null>(null);
  const [deleteFolderId, setDeleteFolderId] = useState<string | null>(null);
  const [deleteForeverId, setDeleteForeverId] = useState<string | null>(null);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const dragDepth = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current) {
      clearTimeout(toastTimer.current);
    }
    toastTimer.current = setTimeout(() => setToast(null), 3200);
  }, []);

  const currentFolderId = view.kind === "folder" ? view.id : null;

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

  const childFolders = useMemo(
    () =>
      [...store.folders.values()]
        .filter((f) => f.parentId === currentFolderId)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [store.folders, currentFolderId],
  );

  const childFiles = useMemo(
    () =>
      [...store.files.values()]
        .filter((f) => !f.trashed && f.folderId === currentFolderId)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [store.files, currentFolderId],
  );

  const recentFiles = useMemo(
    () =>
      [...store.files.values()]
        .filter((f) => !f.trashed)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 40),
    [store.files],
  );

  const trashedFiles = useMemo(
    () =>
      [...store.files.values()]
        .filter((f) => f.trashed)
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [store.files],
  );

  const hits = useMemo(
    () => (query.trim() ? searchFiles(store.files.values(), query) : []),
    [store.files, query],
  );

  const previewFile = previewId ? store.files.get(previewId) : undefined;
  const shareFile = shareId ? store.files.get(shareId) : undefined;
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

  const usagePercent = store.usage
    ? Math.min(100, Math.round((store.usage.usedBytes / store.usage.quotaBytes) * 100))
    : 0;

  const searching = query.trim().length > 0;

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
          className={`nav-item${view.kind === "trash" && !searching ? " active" : ""}`}
          onClick={() => {
            setQuery("");
            setView({ kind: "trash" });
          }}
        >
          <TrashGlyph /> Trash
        </button>
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
              placeholder="Search names and contents (decrypted locally)"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
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
              onOpen={(id) => setPreviewId(id)}
              onClear={() => setQuery("")}
            />
          ) : view.kind === "trash" ? (
            <TrashList
              files={trashedFiles}
              onRestore={(id) => void store.restoreFile(id)}
              onDeleteForever={(id) => setDeleteForeverId(id)}
            />
          ) : view.kind === "recent" ? (
            <RecentList files={recentFiles} onOpen={(id) => setPreviewId(id)} />
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
                      ? "Drop files anywhere, or use Upload. Everything is encrypted before it leaves this device."
                      : "One moment."}
                  </p>
                </div>
              ) : (
                <div className="grid">
                  {childFolders.map((folder, i) => (
                    <FolderCard
                      key={folder.id}
                      name={folder.name}
                      index={i}
                      onOpen={() => setView({ kind: "folder", id: folder.id })}
                      onRename={() => setRenameFolderId(folder.id)}
                      onDelete={() => setDeleteFolderId(folder.id)}
                    />
                  ))}
                  {childFiles.map((file, i) => (
                    <FileCard
                      key={file.id}
                      file={file}
                      index={childFolders.length + i}
                      onOpen={() => setPreviewId(file.id)}
                      onDownload={() => download(file)}
                      onShare={() => setShareId(file.id)}
                      onRename={() => setRenameFileId(file.id)}
                      onTrash={() => void store.trashFile(file.id)}
                    />
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </main>

      <UploadTray />

      {previewFile && (
        <Preview
          file={previewFile}
          onClose={() => setPreviewId(null)}
          onShare={() => {
            setShareId(previewFile.id);
            setPreviewId(null);
          }}
        />
      )}
      {shareFile && (
        <ShareDialog file={shareFile} onClose={() => setShareId(null)} onToast={showToast} />
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
          <p>Search covers file names and extracted text, decrypted only on this device.</p>
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
              <span className="row-meta">{formatBytes(hit.file.size)}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function RecentList(props: { files: FileEntry[]; onOpen: (id: string) => void }) {
  return (
    <>
      <div className="crumbs">
        <span className="current">Recent</span>
      </div>
      {props.files.length === 0 ? (
        <div className="empty">
          <span className="empty-mark">◷</span>
          <h3>Nothing yet</h3>
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
            <div
              key={file.id}
              className="row"
              style={{ "--i": Math.min(i, 20) } as CSSProperties}
            >
              <span className="row-glyph">{extension(file.name) || "FILE"}</span>
              <div className="row-main">
                <div className="name">{file.name}</div>
              </div>
              <span className="row-meta">{formatBytes(file.size)}</span>
              <div className="row-actions" style={{ opacity: 1 }}>
                <button
                  className="icon-btn"
                  title="Restore"
                  onClick={() => props.onRestore(file.id)}
                >
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
