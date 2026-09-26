import { useEffect, useRef, useState } from "react";
import { decryptContent, decryptFileMetadata } from "@engramer/crypto";
import { api, type FileVersionInfo } from "../api";
import { FileFacts } from "./FactsPanel";
import { useStore, type FileEntry } from "../store";
import { albumTitle, isAlbumTag, isReservedTag } from "../albums";
import { useSheetDrag } from "../sheetdrag";
import { MOBILE_QUERY, useMediaQuery } from "../media";
import { thumbnailUrl } from "../thumbs";
import { extension, fileKind, formatBytes, formatDate } from "../format";
import { triggerDownload } from "../download";
import { SheetArt } from "./FileArt";
import { Confirm } from "./Dialogs";
import { Button } from "./ui/button";
import { IconButton } from "./ui/icon-button";
import {
  ClockGlyph,
  DownloadGlyph,
  PencilGlyph,
  RestoreGlyph,
  ShareGlyph,
  SparkGlyph,
  StarGlyph,
  TrashGlyph,
  XGlyph,
} from "./Icon";

/**
 * The right-hand inspector: everything about the selected file in one place,
 * with tags editable inline. Multi-selection shows a summary instead.
 */
export function DetailsPanel(props: {
  file: FileEntry | null;
  selectionCount: number;
  /** Bytes across the selection, for the summary shown when several are picked. */
  selectionBytes?: number;
  onOpen: (id: string) => void;
  onEdit: (id: string) => void;
  onDownload: (file: FileEntry) => void;
  onShare: (id: string) => void;
  onRename: (id: string) => void;
  onTrash: (id: string) => void;
  onTagClick: (tag: string) => void;
  onOpenAlbum: (tag: string) => void;
  onAddToAlbum: (id: string) => void;
  onToast: (message: string) => void;
  onClose: () => void;
}) {
  const { file } = props;
  const folders = useStore((s) => s.folders);
  const offline = useStore((s) =>
    file ? s.offline.find((entry) => entry.fileId === file.id) : undefined,
  );
  const setTags = useStore((s) => s.setTags);
  const removeSummary = useStore((s) => s.removeSummary);
  const removeFromAlbum = useStore((s) => s.removeFromAlbum);
  const panelRef = useRef<HTMLElement>(null);
  const isSheet = useMediaQuery(MOBILE_QUERY);
  const drag = useSheetDrag(panelRef, props.onClose);
  // The wide layout's side pane is not a sheet; only the phone gets the
  // grip and the drag physics.
  const handleProps = isSheet ? drag.handleProps : {};
  const sheetStyle = isSheet ? drag.sheetStyle : undefined;
  const toggleFavorite = useStore((s) => s.toggleFavorite);
  const restoreVersion = useStore((s) => s.restoreVersion);
  const [thumb, setThumb] = useState<string | null>(null);
  const [tagDraft, setTagDraft] = useState("");
  const [versions, setVersions] = useState<Array<FileVersionInfo & { contentSize: number }>>([]);
  const [restoring, setRestoring] = useState(false);
  // Which version generation is waiting on the restore question. An
  // in-app dialog, because the iOS shell never renders window.confirm.
  const [pendingRestore, setPendingRestore] = useState<number | null>(null);

  useEffect(() => {
    setThumb(null);
    setTagDraft("");
    setVersions([]);
    let cancelled = false;
    if (file?.hasThumb) {
      void thumbnailUrl(file.id, file.key).then((url) => {
        if (!cancelled) {
          setThumb(url);
        }
      });
    }
    if (file && !file.trashed) {
      void api
        .listVersions(file.id)
        .then(({ versions: list }) => {
          if (!cancelled) {
            // Show the content's size, not the ciphertext's: each version
            // carries its metadata snapshot, decryptable with the file key.
            setVersions(
              list.map((v) => {
                let contentSize = v.size;
                try {
                  contentSize = decryptFileMetadata(v.encryptedMeta, file.key).size;
                } catch {
                  // Ciphertext size is an acceptable fallback.
                }
                return { ...v, contentSize };
              }),
            );
          }
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
    // Refetch when the file advances (a save bumps updatedAt).
  }, [file?.id, file?.hasThumb, file?.key, file?.updatedAt, file?.trashed]);

  if (!file) {
    return (
      <aside className="details">
        <header>
          <span className="details-title">
            {props.selectionCount > 1 ? `${props.selectionCount} selected` : "Details"}
          </span>
          <IconButton label="Close" onClick={props.onClose}>
            <XGlyph size={14} />
          </IconButton>
        </header>
        <div className="details-empty">
          {props.selectionCount > 1 ? (
            <>
              {props.selectionBytes !== undefined && (
                <div className="details-selection-size">{formatBytes(props.selectionBytes)} together</div>
              )}
              Use the bar below to favorite, move, save, or trash them all at once.
            </>
          ) : (
            // This pane is about one thing. What needs attention across the
            // library lives in the bell, where the phone can reach it too.
            <p className="panel-quiet">Select a file to inspect it.</p>
          )}
        </div>
      </aside>
    );
  }

  const kind = fileKind(file.mime, file.name);
  const folderName = file.folderId ? (folders.get(file.folderId)?.name ?? "…") : "All files";

  const addTag = async () => {
    const tag = tagDraft.trim().toLowerCase();
    if (tag && !file.tags.includes(tag)) {
      await setTags(file.id, [...file.tags, tag]);
    }
    setTagDraft("");
  };

  return (
    <aside className="details" ref={panelRef} style={sheetStyle}>
      {/* Phone-only grip (hidden by CSS on wide layouts); the drag reads
          from the header area so the scrollable body keeps scrolling. */}
      <div className="sheet-grip details-grip" aria-hidden="true" {...handleProps} />
      <header {...handleProps}>
        <span className="details-title">Details</span>
        <IconButton label="Close" onClick={props.onClose}>
          <XGlyph size={14} />
        </IconButton>
      </header>

      <div className="details-art" onDoubleClick={() => props.onOpen(file.id)}>
        {thumb ? <img src={thumb} alt="" /> : <SheetArt kind={kind} ext={extension(file.name)} />}
      </div>

      <div className="details-name" title={file.name}>
        {file.name}
        {(!file.shared || file.role === "editor") && (
          <IconButton
            className="star-inline"
            tone={file.favorite ? "accent" : "default"}
            label={file.favorite ? "Unfavorite" : "Favorite"}
            onClick={() => void toggleFavorite(file.id)}
          >
            <StarGlyph filled={file.favorite} size={15} />
          </IconButton>
        )}
      </div>

      {file.summary && (
        <div className="details-summary">
          <span className="details-label">
            <SparkGlyph size={12} /> Summary
          </span>
          <p>{file.summary}</p>
          <div className="details-provenance">
            Read by the on-device assistant from the opening pages.
            <button className="linky quiet" title="Remove this summary" onClick={() => void removeSummary(file.id)}>
              Remove
            </button>
          </div>
        </div>
      )}

      <div className="details-actions">
        <Button variant="secondary" onClick={() => props.onOpen(file.id)}>
          Open
        </Button>
        {kind === "text" && (
          <Button variant="secondary" onClick={() => props.onEdit(file.id)}>
            <PencilGlyph size={13} /> Edit
          </Button>
        )}
        <IconButton label="Download" onClick={() => props.onDownload(file)}>
          <DownloadGlyph />
        </IconButton>
        {!file.shared && (
          <IconButton label="Share" onClick={() => props.onShare(file.id)}>
            <ShareGlyph />
          </IconButton>
        )}
        {!file.shared && (
          <IconButton label="Move to trash" onClick={() => props.onTrash(file.id)}>
            <TrashGlyph />
          </IconButton>
        )}
      </div>

      <dl className="details-meta">
        {file.shared && (
          <>
            <dt>Shared by</dt>
            <dd>
              {file.ownerEmail ?? "another account"}
              {` · you can ${file.role === "editor" ? "edit" : "view"}`}
            </dd>
          </>
        )}
        <dt>Where</dt>
        <dd>{file.shared ? "Shared with me" : folderName}</dd>
        <dt>Category</dt>
        <dd>{file.category ?? "Other"}</dd>
        <dt>Type</dt>
        <dd>{file.mime || extension(file.name) || "unknown"}</dd>
        <dt>Size</dt>
        <dd>{formatBytes(file.size)}</dd>
        <dt>Modified</dt>
        <dd>{formatDate(file.mtime)}</dd>
        <dt>Added</dt>
        <dd>{formatDate(file.createdAt)}</dd>
        <dt>Integrity</dt>
        <dd className={file.corrupt ? "integrity-bad" : undefined}>
          {file.corrupt
            ? "Does not match its checksum"
            : file.verified
              ? "Checked, matches its checksum"
              : file.digest
                ? "Checksum recorded, not read yet"
                : "No checksum; stored before this existed"}
        </dd>
        {offline && (
          <>
            <dt>Offline</dt>
            <dd>
              {offline.pinned
                ? offline.complete
                  ? "Kept on this device"
                  : "Downloading for offline access"
                : `Cached (${formatBytes(offline.bytes)})`}
            </dd>
          </>
        )}
      </dl>

      <FileFacts file={file} />

      {file.tags.some((t) => isAlbumTag(t)) && (
        <div className="details-tags">
          <span className="details-label">Albums</span>
          <div className="tag-input compact">
            {file.tags.filter(isAlbumTag).map((tag) => (
              <span key={tag} className="tag editable">
                <button className="tag-link" title={albumTitle(tag)} onClick={() => props.onOpenAlbum(tag)}>
                  {albumTitle(tag)}
                </button>
                <button
                  title="Remove from album"
                  onClick={() => void removeFromAlbum([file.id], tag)}
                >
                  <XGlyph size={10} />
                </button>
              </span>
            ))}
            <button className="tag-add-album" title="Add to album" onClick={() => props.onAddToAlbum(file.id)}>
              +
            </button>
          </div>
        </div>
      )}

      <div className="details-tags">
        <span className="details-label">Tags</span>
        <div className="tag-input compact">
          {file.tags
            .filter((tag) => !isReservedTag(tag) || tag.startsWith("trip:"))
            .map((tag) => (
            <span key={tag} className="tag editable">
              <button className="tag-link" title={`Search tag:${tag}`} onClick={() => props.onTagClick(tag)}>
                {tag}
              </button>
              <button
                title="Remove"
                onClick={() =>
                  // setTags protects reserved namespaces, so a trip chip's
                  // remove goes through the direct membership path instead.
                  void (isReservedTag(tag)
                    ? removeFromAlbum([file.id], tag)
                    : setTags(file.id, file.tags.filter((t) => t !== tag)))
                }
              >
                <XGlyph size={10} />
              </button>
            </span>
          ))}
          <input
            value={tagDraft}
            placeholder={file.tags.length === 0 ? "Add tag" : "+"}
            onChange={(e) => setTagDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === ",") {
                e.preventDefault();
                void addTag();
              }
            }}
            onBlur={() => void addTag()}
          />
        </div>
      </div>

      {versions.length > 0 && (
        <div className="details-history">
          <span className="details-label">
            <ClockGlyph size={12} /> History
          </span>
          {versions.map((version) => (
            <div key={version.generation} className="history-row">
              <div className="history-main">
                <span className="history-when">{formatDate(version.createdAt)}</span>
                <span className="history-size">{formatBytes(version.contentSize)}</span>
              </div>
              <IconButton
                label="Download version"
                title="Download a copy of this version"
                onClick={() => {
                  void api
                    .downloadVersionBlob(file.id, version.generation)
                    .then((bytes) => {
                      const plain = decryptContent(bytes, file.key);
                      triggerDownload(
                        new Blob([plain.slice().buffer as ArrayBuffer], { type: file.mime }),
                        versionCopyName(file.name, version.createdAt),
                      );
                    })
                    .catch(() => props.onToast("Could not download this version."));
                }}
              >
                <DownloadGlyph size={13} />
              </IconButton>
              {!file.shared && (
                <IconButton
                  label="Restore version"
                  title="Restore this version"
                  disabled={restoring}
                  onClick={() => setPendingRestore(version.generation)}
                >
                  <RestoreGlyph size={13} />
                </IconButton>
              )}
            </div>
          ))}
        </div>
      )}

      {(!file.shared || file.role === "editor") && (
        <Button variant="ghost" className="details-rename" onClick={() => props.onRename(file.id)}>
          <PencilGlyph size={13} /> Rename
        </Button>
      )}

      {pendingRestore !== null && (
        <Confirm
          title="Restore this version?"
          sub="The current content stays in history, so this can be undone."
          confirmLabel="Restore"
          onConfirm={async () => {
            const generation = pendingRestore;
            setRestoring(true);
            try {
              await restoreVersion(file.id, generation);
              props.onToast("Version restored. The replaced content is in history.");
            } catch {
              props.onToast("Could not restore this version.");
            } finally {
              setRestoring(false);
            }
          }}
          onClose={() => setPendingRestore(null)}
        />
      )}
    </aside>
  );
}

/** "report.pdf" -> "report (version Jul 27, 2026).pdf" */
function versionCopyName(name: string, createdAt: number): string {
  const dot = name.lastIndexOf(".");
  const stamp = ` (version ${formatDate(createdAt)})`;
  return dot > 0 ? `${name.slice(0, dot)}${stamp}${name.slice(dot)}` : `${name}${stamp}`;
}
