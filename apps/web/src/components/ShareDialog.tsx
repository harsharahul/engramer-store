import { useEffect, useState } from "react";
import { toB64 } from "@engramer/crypto";
import { api } from "../api";
import type { FileEntry } from "../store";
import { CopyGlyph, XGlyph } from "./Icon";

export function ShareDialog(props: {
  file: FileEntry;
  onClose: () => void;
  onToast: (message: string) => void;
}) {
  const { file } = props;
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [existing, setExisting] = useState<Array<{ token: string; createdAt: number }>>([]);

  const linkFor = (token: string) => `${location.origin}/s/${token}#${toB64(file.key)}`;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { shares } = await api.listShares();
        const mine = shares.filter((s) => s.fileId === file.id);
        if (cancelled) {
          return;
        }
        if (mine.length > 0) {
          setExisting(mine);
          setLink(linkFor(mine[0]!.token));
        } else {
          const { token } = await api.createShare(file.id);
          if (!cancelled) {
            setExisting([{ token, createdAt: Date.now() }]);
            setLink(linkFor(token));
          }
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "could not create the link");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.id]);

  const copy = async () => {
    if (link) {
      await navigator.clipboard.writeText(link);
      props.onToast("Link copied. The decryption key travels in the link itself.");
    }
  };

  const revoke = async () => {
    for (const share of existing) {
      await api.revokeShare(share.token);
    }
    props.onToast("Link revoked.");
    props.onClose();
  };

  return (
    <div className="overlay" onClick={props.onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "start" }}>
          <h2>Share “{file.name}”</h2>
          <button className="icon-btn" onClick={props.onClose}>
            <XGlyph />
          </button>
        </div>
        <p className="modal-sub">
          Anyone with this link can decrypt the file. The key lives in the fragment after “#”,
          which the browser never sends to the server.
        </p>
        {error ? (
          <div className="error-text">{error}</div>
        ) : !link ? (
          <div className="spinner" />
        ) : (
          <div className="share-link-box">
            <input readOnly value={link} onFocus={(e) => e.target.select()} />
            <button className="btn btn-primary" onClick={copy} title="Copy link">
              <CopyGlyph />
            </button>
          </div>
        )}
        <div className="modal-actions">
          <button className="btn btn-danger" onClick={revoke} disabled={existing.length === 0}>
            Revoke link
          </button>
          <button className="btn" onClick={props.onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
