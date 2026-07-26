import { useCallback, useEffect, useState } from "react";
import { decryptJson, toB64, utf8Encode } from "@engramer/crypto";
import { api, type FileRequestInfo, type ShareInfo } from "../api";
import { useStore } from "../store";
import { formatDate } from "../format";
import { describeShare, shareLink } from "./ShareDialog";
import { CopyGlyph, InboxGlyph, KeyGlyph, LinkGlyph, PlusGlyph, TrashGlyph } from "./Icon";

const EXPIRY_CHOICES = [
  { label: "Never expires", ms: null },
  { label: "1 hour", ms: 3_600_000 },
  { label: "24 hours", ms: 86_400_000 },
  { label: "7 days", ms: 7 * 86_400_000 },
  { label: "30 days", ms: 30 * 86_400_000 },
] as const;

interface RequestEntry extends FileRequestInfo {
  label: string;
}

function requestLink(entry: RequestEntry): string {
  // The label rides in the fragment so the upload page can greet the sender
  // without the server ever storing it in the clear.
  return `${location.origin}/r/${entry.token}#${toB64(utf8Encode(entry.label))}`;
}

/** Everything this account is sharing: outgoing links and incoming requests. */
export function SharedView(props: { onToast: (message: string) => void }) {
  const store = useStore();
  const [shares, setShares] = useState<ShareInfo[] | null>(null);
  const [requests, setRequests] = useState<RequestEntry[] | null>(null);
  const [newRequestOpen, setNewRequestOpen] = useState(false);

  const load = useCallback(async () => {
    const masterKey = store.session?.masterKey;
    const [shareList, requestList] = await Promise.all([
      api.listShares(),
      api.listFileRequests(),
    ]);
    setShares(shareList.shares);
    setRequests(
      requestList.requests.map((r) => {
        let label = "File request";
        try {
          label = (decryptJson<{ label: string }>(r.encryptedMeta, masterKey!)).label;
        } catch {
          // An undecryptable label never hides the request itself.
        }
        return { ...r, label };
      }),
    );
  }, [store.session]);

  useEffect(() => {
    void load().catch(() => props.onToast("Could not load shares."));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  const copyShare = async (share: ShareInfo) => {
    const file = store.files.get(share.fileId);
    if (!file && !share.protected) {
      props.onToast("The file behind this link is gone. Revoke the link.");
      return;
    }
    await navigator.clipboard.writeText(shareLink(share, file?.key ?? new Uint8Array()));
    props.onToast("Link copied.");
  };

  const revokeShare = async (token: string) => {
    await api.revokeShare(token);
    await load();
    props.onToast("Link revoked.");
  };

  const copyRequest = async (entry: RequestEntry) => {
    await navigator.clipboard.writeText(requestLink(entry));
    props.onToast("Request link copied. Anyone with it can send you files, encrypted.");
  };

  const revokeRequest = async (token: string) => {
    await api.revokeFileRequest(token);
    await load();
    props.onToast("Request closed.");
  };

  const checkNow = async () => {
    const count = await store.ingestRequestUploads();
    await load();
    props.onToast(count > 0 ? `Filed ${count} arrival${count === 1 ? "" : "s"}.` : "Nothing new.");
  };

  if (shares === null || requests === null) {
    return (
      <div className="empty">
        <div className="spinner" />
      </div>
    );
  }

  const activeRequests = requests.filter((r) => !r.revoked);

  return (
    <div className="shared-view">
      <section>
        <div className="shared-head">
          <h3>
            <LinkGlyph size={15} /> Links you shared
          </h3>
        </div>
        {shares.length === 0 ? (
          <p className="shared-empty">
            No active links. Share any file from its context menu or the preview.
          </p>
        ) : (
          <div className="rows">
            {shares.map((share) => {
              const file = store.files.get(share.fileId);
              return (
                <div key={share.token} className="row static">
                  <span className="row-glyph">
                    {share.protected ? <KeyGlyph size={14} /> : <LinkGlyph size={14} />}
                  </span>
                  <div className="row-main">
                    <div className="name">{file?.name ?? "(file removed)"}</div>
                    <div className="snippet">
                      {describeShare(share)} · created {formatDate(share.createdAt)}
                    </div>
                  </div>
                  {share.protected && <span className="row-tag">password</span>}
                  <div className="row-actions" style={{ opacity: 1 }}>
                    <button className="icon-btn" title="Copy link" onClick={() => void copyShare(share)}>
                      <CopyGlyph size={14} />
                    </button>
                    <button
                      className="icon-btn"
                      title="Revoke link"
                      onClick={() => void revokeShare(share.token)}
                    >
                      <TrashGlyph size={14} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section>
        <div className="shared-head">
          <h3>
            <InboxGlyph size={15} /> File requests
          </h3>
          <div className="grow" />
          <button className="btn btn-ghost" onClick={() => void checkNow()}>
            Check for arrivals
          </button>
          <button className="btn" onClick={() => setNewRequestOpen(true)}>
            <PlusGlyph size={14} /> New request
          </button>
        </div>
        {activeRequests.length === 0 ? (
          <p className="shared-empty">
            A file request is a link anyone can use to send files straight into your vault,
            encrypted to your key before they leave the sender's device.
          </p>
        ) : (
          <div className="rows">
            {activeRequests.map((entry) => (
              <div key={entry.token} className="row static">
                <span className="row-glyph">
                  <InboxGlyph size={14} />
                </span>
                <div className="row-main">
                  <div className="name">{entry.label}</div>
                  <div className="snippet">
                    {entry.received} received
                    {entry.pending > 0 ? ` · ${entry.pending} arriving` : ""}
                    {entry.folderId
                      ? ` · into ${store.folders.get(entry.folderId)?.name ?? "a folder"}`
                      : " · into All files"}
                    {entry.expiresAt
                      ? entry.expiresAt <= Date.now()
                        ? " · expired"
                        : ` · until ${formatDate(entry.expiresAt)}`
                      : ""}
                  </div>
                </div>
                <div className="row-actions" style={{ opacity: 1 }}>
                  <button className="icon-btn" title="Copy link" onClick={() => void copyRequest(entry)}>
                    <CopyGlyph size={14} />
                  </button>
                  <button
                    className="icon-btn"
                    title="Close request"
                    onClick={() => void revokeRequest(entry.token)}
                  >
                    <TrashGlyph size={14} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {newRequestOpen && (
        <NewRequestDialog
          onCreated={async () => {
            await load();
            props.onToast("Request link copied. Send it to anyone.");
          }}
          onClose={() => setNewRequestOpen(false)}
        />
      )}
    </div>
  );
}

export function NewRequestDialog(props: {
  folderId?: string | null;
  onCreated: (entry: RequestEntry) => Promise<void> | void;
  onClose: () => void;
}) {
  const store = useStore();
  const [label, setLabel] = useState("");
  const [folderId, setFolderId] = useState<string | null>(props.folderId ?? null);
  const [expiry, setExpiry] = useState(0);
  const [busy, setBusy] = useState(false);

  const rootFolders = [...store.folders.values()]
    .filter((f) => f.parentId === null)
    .sort((a, b) => a.name.localeCompare(b.name));

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = label.trim();
    if (!trimmed) {
      return;
    }
    setBusy(true);
    try {
      const expiresAt = EXPIRY_CHOICES[expiry]!.ms
        ? Date.now() + EXPIRY_CHOICES[expiry]!.ms!
        : null;
      const token = await store.createFileRequest(trimmed, folderId, expiresAt);
      const entry: RequestEntry = {
        token,
        folderId,
        encryptedMeta: { ciphertext: "", nonce: "" },
        expiresAt,
        revoked: false,
        createdAt: Date.now(),
        received: 0,
        pending: 0,
        label: trimmed,
      };
      await navigator.clipboard.writeText(requestLink(entry));
      await props.onCreated(entry);
      props.onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="overlay" onClick={props.onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Request files</h2>
        <p className="modal-sub">
          Share the link with anyone; what they send is encrypted to your key on their device and
          filed here automatically.
        </p>
        <form onSubmit={create}>
          <input
            autoFocus
            placeholder="What are you asking for? e.g. Tax documents"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
          <div className="share-option-row" style={{ marginTop: 10 }}>
            <select
              value={folderId ?? ""}
              onChange={(e) => setFolderId(e.target.value || null)}
            >
              <option value="">Into All files</option>
              {rootFolders.map((folder) => (
                <option key={folder.id} value={folder.id}>
                  Into {folder.name}
                </option>
              ))}
            </select>
            <select value={expiry} onChange={(e) => setExpiry(Number(e.target.value))}>
              {EXPIRY_CHOICES.map((choice, i) => (
                <option key={choice.label} value={i}>
                  {choice.label}
                </option>
              ))}
            </select>
          </div>
          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" onClick={props.onClose}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={busy || !label.trim()}>
              Create and copy link
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
