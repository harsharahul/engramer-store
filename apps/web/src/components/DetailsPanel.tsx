import { useEffect, useState } from "react";
import { decryptContent, decryptFileMetadata } from "@engramer/crypto";
import { api, type FileVersionInfo } from "../api";
import { FileFacts, LibraryIntel } from "./FactsPanel";
import { useStore, type FileEntry } from "../store";
import { thumbnailUrl } from "../thumbs";
import { extension, fileKind, formatBytes, formatDate } from "../format";
import { triggerDownload } from "../download";
import { SheetArt } from "./FileArt";
import {
  ClockGlyph,
  DownloadGlyph,
  PencilGlyph,
  RestoreGlyph,
  ShareGlyph,
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
  /** Everything live, for the library intelligence shown when nothing is picked. */
  allFiles: FileEntry[];
  selectionCount: number;
  onOpen: (id: string) => void;
  onEdit: (id: string) => void;
  onDownload: (file: FileEntry) => void;
  onShare: (id: string) => void;
  onRename: (id: string) => void;
  onTrash: (id: string) => void;
  onTagClick: (tag: string) => void;
  onToast: (message: string) => void;
  onClose: () => void;
}) {
  const { file } = props;
  const folders = useStore((s) => s.folders);
  const setTags = useStore((s) => s.setTags);
  const toggleFavorite = useStore((s) => s.toggleFavorite);
  const restoreVersion = useStore((s) => s.restoreVersion);
  const [thumb, setThumb] = useState<string | null>(null);
  const [tagDraft, setTagDraft] = useState("");
  const [versions, setVersions] = useState<Array<FileVersionInfo & { contentSize: number }>>([]);
  const [restoring, setRestoring] = useState(false);

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
            {props.selectionCount > 1
              ? `${props.selectionCount} selected`
              : // Nothing is selected, so the panel is not describing a file
                // and should not claim to be.
                "Right now"}
          </span>
          <button className="icon-btn" title="Close" onClick={props.onClose}>
            <XGlyph size={14} />
          </button>
        </header>
        <div className="details-empty">
          {props.selectionCount > 1 ? (
            "Use the bar below for bulk actions."
          ) : (
            // Nothing selected is the panel's usual state, so it is worth
            // more than a sentence telling you to select something.
            <LibraryIntel files={props.allFiles} onOpen={props.onOpen} />
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
    <aside className="details">
      <header>
        <span className="details-title">Details</span>
        <button className="icon-btn" title="Close" onClick={props.onClose}>
          <XGlyph size={14} />
        </button>
      </header>

      <div className="details-art" onDoubleClick={() => props.onOpen(file.id)}>
        {thumb ? <img src={thumb} alt="" /> : <SheetArt kind={kind} ext={extension(file.name)} />}
      </div>

      <div className="details-name" title={file.name}>
        {file.name}
        {(!file.shared || file.role === "editor") && (
          <button
            className={`icon-btn star-inline${file.favorite ? " on" : ""}`}
            title={file.favorite ? "Unfavorite" : "Favorite"}
            onClick={() => void toggleFavorite(file.id)}
          >
            <StarGlyph filled={file.favorite} size={15} />
          </button>
        )}
      </div>

      <div className="details-actions">
        <button className="btn" onClick={() => props.onOpen(file.id)}>
          Open
        </button>
        {kind === "text" && (
          <button className="btn" onClick={() => props.onEdit(file.id)}>
            <PencilGlyph size={13} /> Edit
          </button>
        )}
        <button className="icon-btn" title="Download" onClick={() => props.onDownload(file)}>
          <DownloadGlyph />
        </button>
        {!file.shared && (
          <button className="icon-btn" title="Share" onClick={() => props.onShare(file.id)}>
            <ShareGlyph />
          </button>
        )}
        {!file.shared && (
          <button className="icon-btn" title="Move to trash" onClick={() => props.onTrash(file.id)}>
            <TrashGlyph />
          </button>
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
      </dl>

      <FileFacts file={file} />

      <div className="details-tags">
        <span className="details-label">Tags</span>
        <div className="tag-input compact">
          {file.tags.map((tag) => (
            <span key={tag} className="tag editable">
              <button className="tag-link" title={`Search tag:${tag}`} onClick={() => props.onTagClick(tag)}>
                {tag}
              </button>
              <button
                title="Remove"
                onClick={() => void setTags(file.id, file.tags.filter((t) => t !== tag))}
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
              <button
                className="icon-btn"
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
              </button>
              {!file.shared && (
                <button
                  className="icon-btn"
                  title="Restore this version"
                  disabled={restoring}
                  onClick={() => {
                    if (
                      !window.confirm(
                        "Restore this version? The current content stays in history, so this can be undone.",
                      )
                    ) {
                      return;
                    }
                    setRestoring(true);
                    void restoreVersion(file.id, version.generation)
                      .then(() => props.onToast("Version restored. The replaced content is in history."))
                      .catch(() => props.onToast("Could not restore this version."))
                      .finally(() => setRestoring(false));
                  }}
                >
                  <RestoreGlyph size={13} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {(!file.shared || file.role === "editor") && (
        <button className="btn btn-ghost details-rename" onClick={() => props.onRename(file.id)}>
          <PencilGlyph size={13} /> Rename
        </button>
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
