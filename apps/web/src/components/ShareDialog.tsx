import { useEffect, useState } from "react";
import { toB64, protectShareKey } from "@engramer/crypto";
import { api, type CollabInviteInfo, type CollaboratorInfo, type ShareInfo, type ShareOptions } from "../api";
import { useStore, type FileEntry } from "../store";
import { inviteLink } from "../collab";
import { formatDate } from "../format";
import { CopyGlyph, KeyGlyph, PeopleGlyph, TrashGlyph, XGlyph } from "./Icon";

const EXPIRY_CHOICES = [
  { label: "Never expires", ms: null },
  { label: "1 hour", ms: 3_600_000 },
  { label: "24 hours", ms: 86_400_000 },
  { label: "7 days", ms: 7 * 86_400_000 },
  { label: "30 days", ms: 30 * 86_400_000 },
] as const;

const DOWNLOAD_CHOICES = [
  { label: "Unlimited downloads", value: null },
  { label: "1 download", value: 1 },
  { label: "5 downloads", value: 5 },
  { label: "25 downloads", value: 25 },
  { label: "100 downloads", value: 100 },
] as const;

export function shareLink(share: ShareInfo, fileKey: Uint8Array): string {
  // Open links carry the key in the fragment; protected links carry nothing:
  // their key is wrapped under the password and unwrapped on the visitor's device.
  return share.protected
    ? `${location.origin}/s/${share.token}`
    : `${location.origin}/s/${share.token}#${toB64(fileKey)}`;
}

export function describeShare(share: ShareInfo): string {
  const parts: string[] = [];
  if (share.expiresAt) {
    parts.push(share.expiresAt <= Date.now() ? "expired" : `until ${formatDate(share.expiresAt)}`);
  }
  parts.push(
    share.maxDownloads
      ? `${share.downloadCount}/${share.maxDownloads} downloads`
      : `${share.downloadCount} download${share.downloadCount === 1 ? "" : "s"}`,
  );
  return parts.join(" · ");
}

export function ShareDialog(props: {
  file: FileEntry;
  onClose: () => void;
  onToast: (message: string) => void;
}) {
  const { file } = props;
  const [links, setLinks] = useState<ShareInfo[] | null>(null);
  const [people, setPeople] = useState<CollaboratorInfo[]>([]);
  const [invites, setInvites] = useState<CollabInviteInfo[]>([]);
  const [claims, setClaims] = useState<CollabInviteInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [expiry, setExpiry] = useState(0);
  const [limit, setLimit] = useState(0);
  const [password, setPassword] = useState("");
  const [creating, setCreating] = useState(false);
  const [inviting, setInviting] = useState(false);

  const load = async () => {
    const { shares } = await api.listShares();
    setLinks(shares.filter((s) => s.fileId === file.id));
    const [{ collaborators }, { invites: allInvites }] = await Promise.all([
      api.listCollaborators(file.id),
      api.listCollabInvites(),
    ]);
    setPeople(collaborators);
    const mine = allInvites.filter((i) => i.fileId === file.id && !i.revoked && !i.granted);
    // Claimed invitations wait here for a decision; nothing is released by
    // being asked, because the claimant is whoever opened the link.
    setClaims(mine.filter((i) => i.claimed && i.claimantEmail));
    setInvites(mine.filter((i) => !i.claimed));
  };

  useEffect(() => {
    void load().catch((err: unknown) =>
      setError(err instanceof Error ? err.message : "could not load links"),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.id]);

  const create = async () => {
    setCreating(true);
    setError(null);
    try {
      const options: ShareOptions = {
        expiresAt: EXPIRY_CHOICES[expiry]!.ms ? Date.now() + EXPIRY_CHOICES[expiry]!.ms! : null,
        maxDownloads: DOWNLOAD_CHOICES[limit]!.value,
      };
      const trimmed = password.trim();
      if (trimmed) {
        // Argon2id runs here; roughly a second of deliberate work.
        const protection = protectShareKey(file.key, trimmed);
        options.password = {
          digest: protection.accessKeyDigest,
          kdf: protection.kdf,
          wrappedKey: protection.wrappedKey,
        };
      }
      const { token } = await api.createShare(file.id, options);
      await load();
      const created: ShareInfo = {
        token,
        fileId: file.id,
        createdAt: Date.now(),
        expiresAt: options.expiresAt ?? null,
        maxDownloads: options.maxDownloads ?? null,
        downloadCount: 0,
        protected: Boolean(options.password),
      };
      await navigator.clipboard.writeText(shareLink(created, file.key));
      props.onToast(
        created.protected
          ? "Link copied. Share the password separately."
          : "Link copied. The decryption key travels in the link itself.",
      );
      setPassword("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not create the link");
    } finally {
      setCreating(false);
    }
  };

  const copy = async (share: ShareInfo) => {
    await navigator.clipboard.writeText(shareLink(share, file.key));
    props.onToast("Link copied.");
  };

  const revoke = async (token: string) => {
    await api.revokeShare(token);
    await load();
    props.onToast("Link revoked.");
  };

  const invitePerson = async (role: "viewer" | "editor") => {
    setInviting(true);
    setError(null);
    try {
      const { token } = await api.createCollabInvite(file.id, role);
      await navigator.clipboard.writeText(inviteLink(token));
      await load();
      props.onToast(
        "Invitation copied. Anyone with it can claim it once; send it the way you would send a password.",
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not create the invitation");
    } finally {
      setInviting(false);
    }
  };

  const approve = async (token: string) => {
    try {
      await useStore.getState().approveClaim(token);
      await load();
      props.onToast("Key released. They can open the document now.");
    } catch {
      props.onToast("Could not release the key. The invitation may have been revoked.");
    }
  };

  const revokeInvite = async (token: string) => {
    await api.revokeCollabInvite(token);
    await load();
    props.onToast("Invitation revoked.");
  };

  const removePerson = async (userId: number) => {
    await api.removeCollaborator(file.id, userId);
    await load();
    // Honest about the limit: revocation stops future access, it cannot
    // unsee what was already read. Rotation is what makes it stick for
    // everything the document becomes from here on.
    if (
      window.confirm(
        "Access removed. Also rotate this document's key? They already have the current contents; rotating stops them reading anything saved from now on.",
      )
    ) {
      try {
        await useStore.getState().rotateFileKey(file.id);
        props.onToast("Key rotated. Remaining people were re-keyed automatically.");
      } catch {
        props.onToast("Could not rotate the key. You can retry from this dialog by removing access again.");
      }
    } else {
      props.onToast("Access removed. They keep what they already read; the file stops updating for them.");
    }
  };

  return (
    <div className="overlay" onClick={props.onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "start" }}>
          <h2>Share “{file.name}”</h2>
          <button className="icon-btn" onClick={props.onClose}>
            <XGlyph />
          </button>
        </div>
        <p className="modal-sub">
          Links serve ciphertext only. Open links keep the key in the fragment after “#”, which
          browsers never send; password links wrap the key under the password on your device.
        </p>

        <div className="sidebar-label">
          <PeopleGlyph size={12} /> People
        </div>
        {people.length > 0 && (
          <div className="share-list">
            {people.map((person) => (
              <div key={person.userId} className="share-row">
                <div className="share-row-main">
                  <span className="share-row-token">{person.email}</span>
                  <span className="badge">{person.role === "editor" ? "can edit" : "can view"}</span>
                </div>
                <button
                  className="icon-btn danger"
                  title="Remove access"
                  onClick={() => void removePerson(person.userId)}
                >
                  <TrashGlyph size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
        {claims.length > 0 && (
          <div className="share-list">
            {claims.map((claim) => (
              <div key={claim.token} className="share-row">
                <div className="share-row-main">
                  <span className="share-row-token">{claim.claimantEmail}</span>
                  <span className="badge">
                    claimed · {claim.role === "editor" ? "edit" : "view"}
                  </span>
                  <span className="share-row-meta">waiting for you to release the key</span>
                </div>
                <button className="btn" onClick={() => void approve(claim.token)}>
                  Release the key
                </button>
                <button
                  className="icon-btn danger"
                  title="Refuse and revoke this invitation"
                  onClick={() => void revokeInvite(claim.token)}
                >
                  <TrashGlyph size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
        {claims.length > 0 && (
          <p className="modal-sub">
            Check the address before releasing: whoever opened the invitation link claimed it,
            and releasing the key gives that account the document.
          </p>
        )}
        {invites.length > 0 && (
          <div className="share-list">
            {invites.map((invite) => (
              <div key={invite.token} className="share-row">
                <div className="share-row-main">
                  <span className="share-row-token mono">/c/{invite.token.slice(0, 8)}…</span>
                  <span className="badge">
                    invitation · {invite.role === "editor" ? "edit" : "view"}
                  </span>
                  <span className="share-row-meta">waiting to be claimed</span>
                </div>
                <button
                  className="icon-btn"
                  title="Copy invitation"
                  onClick={() =>
                    void navigator.clipboard
                      .writeText(inviteLink(invite.token))
                      .then(() => props.onToast("Invitation copied."))
                  }
                >
                  <CopyGlyph size={14} />
                </button>
                <button
                  className="icon-btn danger"
                  title="Revoke invitation"
                  onClick={() => void revokeInvite(invite.token)}
                >
                  <TrashGlyph size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="share-option-row">
          <button className="btn" disabled={inviting} onClick={() => void invitePerson("editor")}>
            Invite to edit
          </button>
          <button className="btn" disabled={inviting} onClick={() => void invitePerson("viewer")}>
            Invite to view
          </button>
        </div>
        <p className="modal-sub">
          An invitation carries no key. The person claims it signed in, you release the key to
          exactly that account, and removing them later stops future access without recalling
          what they already read.
        </p>

        <div className="sidebar-label">
          <KeyGlyph size={12} /> Links
        </div>

        {links && links.length > 0 && (
          <div className="share-list">
            {links.map((share) => (
              <div key={share.token} className="share-row">
                <div className="share-row-main">
                  <span className="share-row-token mono">/s/{share.token.slice(0, 8)}…</span>
                  {share.protected && (
                    <span className="badge">
                      <KeyGlyph size={11} /> password
                    </span>
                  )}
                  <span className="share-row-meta">{describeShare(share)}</span>
                </div>
                <button className="icon-btn" title="Copy link" onClick={() => void copy(share)}>
                  <CopyGlyph size={14} />
                </button>
                <button
                  className="icon-btn danger"
                  title="Revoke link"
                  onClick={() => void revoke(share.token)}
                >
                  <TrashGlyph size={14} />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="share-options">
          <div className="share-option-row">
            <select value={expiry} onChange={(e) => setExpiry(Number(e.target.value))}>
              {EXPIRY_CHOICES.map((choice, i) => (
                <option key={choice.label} value={i}>
                  {choice.label}
                </option>
              ))}
            </select>
            <select value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
              {DOWNLOAD_CHOICES.map((choice, i) => (
                <option key={choice.label} value={i}>
                  {choice.label}
                </option>
              ))}
            </select>
          </div>
          <input
            type="password"
            placeholder="Password (optional). Share it out of band."
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>

        {error && <div className="error-text">{error}</div>}

        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={props.onClose}>
            Done
          </button>
          <button className="btn btn-primary" onClick={() => void create()} disabled={creating}>
            {creating
              ? password.trim()
                ? "Securing…"
                : "Creating…"
              : links && links.length > 0
                ? "New link"
                : "Create link"}
          </button>
        </div>
      </div>
    </div>
  );
}
