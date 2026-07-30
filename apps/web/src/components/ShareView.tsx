import { useEffect, useState, type FormEvent } from "react";
import { useLocation, useParams } from "react-router";
import {
  ready,
  decryptContent,
  decryptFileMetadata,
  deriveShareAccess,
  openShareKey,
  fromB64,
  type FileMetadata,
  type KdfParams,
} from "@engramer/crypto";
import { api, ApiError } from "../api";
import { fileKind, formatBytes } from "../format";
import { triggerDownload } from "../download";
import { DownloadGlyph, KeyGlyph } from "./Icon";
import { BrandMark } from "./FileArt";

export function ShareView() {
  const { token } = useParams<{ token: string }>();
  const location = useLocation();
  const [meta, setMeta] = useState<FileMetadata | null>(null);
  const [key, setKey] = useState<Uint8Array | null>(null);
  const [accessKey, setAccessKey] = useState<string | undefined>(undefined);
  const [kdf, setKdf] = useState<KdfParams | null>(null);
  const [password, setPassword] = useState("");
  const [unlocking, setUnlocking] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewText, setPreviewText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        await ready();
        if (!token) {
          setError("This link is missing its token.");
          return;
        }
        const response = await api.publicMeta(token);
        if (response.protected && !response.encryptedMeta) {
          // Password required; the KDF parameters tell this device how to derive it.
          setKdf(response.kdf!);
          return;
        }
        const fragment = location.hash.replace(/^#/, "");
        if (!fragment) {
          setError("This link is missing its decryption key.");
          return;
        }
        const fileKey = fromB64(fragment);
        setMeta(decryptFileMetadata(response.encryptedMeta!, fileKey));
        setKey(fileKey);
      } catch (err) {
        setError(
          err instanceof ApiError
            ? err.message
            : "This link is no longer available or the key is invalid.",
        );
      }
    })();
  }, [token, location.hash]);

  const unlock = async (event: FormEvent) => {
    event.preventDefault();
    if (!kdf || !password) {
      return;
    }
    setUnlocking(true);
    setPasswordError(null);
    try {
      // Argon2id runs locally; the password itself never leaves this device.
      const access = deriveShareAccess(password, kdf);
      const response = await api.publicMeta(token!, access.accessKey);
      const fileKey = openShareKey(response.wrappedKey!, access);
      setMeta(decryptFileMetadata(response.encryptedMeta!, fileKey));
      setKey(fileKey);
      setAccessKey(access.accessKey);
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setPasswordError("Wrong password. Try again.");
      } else if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setPasswordError("Could not unlock this link.");
      }
    } finally {
      setUnlocking(false);
    }
  };

  const fetchDecrypted = async (): Promise<Uint8Array> => {
    const ciphertext = await api.publicData(token!, accessKey);
    return decryptContent(ciphertext, key!);
  };

  const download = async () => {
    setBusy(true);
    try {
      const bytes = await fetchDecrypted();
      triggerDownload(
        new Blob([bytes.slice().buffer as ArrayBuffer], { type: meta!.mime }),
        meta!.name,
      );
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : "Decryption failed. The link key does not match this file.",
      );
    } finally {
      setBusy(false);
    }
  };

  const preview = async () => {
    setBusy(true);
    try {
      const bytes = await fetchDecrypted();
      const kind = fileKind(meta!.mime, meta!.name);
      if (kind === "text") {
        setPreviewText(new TextDecoder().decode(bytes));
      } else {
        const mime = kind === "pdf" ? "application/pdf" : meta!.mime;
        setPreviewUrl(
          URL.createObjectURL(new Blob([bytes.slice().buffer as ArrayBuffer], { type: mime })),
        );
      }
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : "Decryption failed. The link key does not match this file.",
      );
    } finally {
      setBusy(false);
    }
  };

  const kind = meta ? fileKind(meta.mime, meta.name) : "other";
  const canPreview = kind === "image" || kind === "video" || kind === "audio" || kind === "text";
  const needsPassword = kdf !== null && meta === null && !error;

  return (
    <div className="share-shell">
      <div className="share-card">
        <BrandMark size={40} />
        {error ? (
          <>
            <h1>Nothing here</h1>
            <p className="sub">{error}</p>
          </>
        ) : needsPassword ? (
          <>
            <h1>
              <KeyGlyph size={18} /> Password protected
            </h1>
            <p className="sub">
              The sender set a password on this link. It is checked and used to unwrap the file key
              on your device.
            </p>
            <form onSubmit={unlock} className="share-unlock">
              <input
                type="password"
                autoFocus
                placeholder="Link password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <button className="btn btn-primary" type="submit" disabled={unlocking || !password}>
                {unlocking ? "Unlocking…" : "Unlock"}
              </button>
            </form>
            {passwordError && <p className="error-text">{passwordError}</p>}
          </>
        ) : !meta ? (
          <div className="spinner" style={{ margin: "20px auto" }} />
        ) : (
          <>
            <h1>{meta.name}</h1>
            <p className="sub">
              {formatBytes(meta.size)} · shared end-to-end encrypted · decrypted in your browser
            </p>
            <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
              <button className="btn btn-primary" onClick={download} disabled={busy}>
                <DownloadGlyph /> Download
              </button>
              {canPreview && !previewUrl && previewText === null && (
                <button className="btn" onClick={preview} disabled={busy}>
                  Preview
                </button>
              )}
            </div>
            {(previewUrl || previewText !== null) && (
              <div className="share-preview">
                {kind === "image" && previewUrl && <img src={previewUrl} alt={meta.name} />}
                {kind === "video" && previewUrl && <video src={previewUrl} controls />}
                {kind === "audio" && previewUrl && <audio src={previewUrl} controls />}
                {previewText !== null && <pre>{previewText}</pre>}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
