import { useEffect, useState } from "react";
import { useLocation, useParams } from "react-router";
import {
  ready,
  decryptBytes,
  decryptFileMetadata,
  fromB64,
  type FileMetadata,
} from "@engramer/crypto";
import { api } from "../api";
import { fileKind, formatBytes } from "../format";
import { triggerDownload } from "../download";
import { DownloadGlyph } from "./Icon";
import { BrandMark } from "./FileArt";

export function ShareView() {
  const { token } = useParams<{ token: string }>();
  const location = useLocation();
  const [meta, setMeta] = useState<FileMetadata | null>(null);
  const [key, setKey] = useState<Uint8Array | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewText, setPreviewText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        await ready();
        const fragment = location.hash.replace(/^#/, "");
        if (!token || !fragment) {
          setError("This link is missing its decryption key.");
          return;
        }
        const fileKey = fromB64(fragment);
        const response = await api.publicMeta(token);
        setMeta(decryptFileMetadata(response.encryptedMeta, fileKey));
        setKey(fileKey);
      } catch {
        setError("This link is no longer available or the key is invalid.");
      }
    })();
  }, [token, location.hash]);

  const fetchDecrypted = async (): Promise<Uint8Array> => {
    const ciphertext = await api.publicData(token!);
    return decryptBytes(ciphertext, key!);
  };

  const download = async () => {
    setBusy(true);
    try {
      const bytes = await fetchDecrypted();
      triggerDownload(
        new Blob([bytes.slice().buffer as ArrayBuffer], { type: meta!.mime }),
        meta!.name,
      );
    } catch {
      setError("Decryption failed. The link key does not match this file.");
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
    } catch {
      setError("Decryption failed. The link key does not match this file.");
    } finally {
      setBusy(false);
    }
  };

  const kind = meta ? fileKind(meta.mime, meta.name) : "other";
  const canPreview = kind === "image" || kind === "video" || kind === "audio" || kind === "text";

  return (
    <div className="share-shell">
      <div className="share-card">
        <BrandMark size={40} />
        {error ? (
          <>
            <h1>Nothing here</h1>
            <p className="sub">{error}</p>
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
