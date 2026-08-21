import { useEffect, useRef, useState } from "react";
import { useLocation, useParams } from "react-router";
import {
  ready,
  contentDigest,
  encryptBytes,
  utf8Encode,
  encryptFileMetadata,
  generateKey,
  sealToPublicKey,
} from "@engramer/crypto";
import { api, ApiError, uploadRequestBlob } from "../api";
import { parseRequestFragment } from "../requestlink";
import { analyzeFile } from "../transfer";
import { formatBytes } from "../format";
import { BrandMark } from "./FileArt";
import { UploadGlyph } from "./Icon";

interface Sending {
  id: string;
  name: string;
  size: number;
  progress: number;
  status: "encrypting" | "uploading" | "done" | "error";
  error?: string;
}

/**
 * The public receiving page for a file request. Every file is analyzed and
 * encrypted on this device with a fresh key, and the key is sealed to the
 * recipient's public key; the server relays ciphertext it cannot read.
 */
export function RequestView() {
  const { token } = useParams<{ token: string }>();
  const location = useLocation();
  const [label, setLabel] = useState<string | null>(null);
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [maxBytes, setMaxBytes] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<Sending[]>([]);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void (async () => {
      try {
        await ready();
        const link = parseRequestFragment(location.hash);
        if (link.label) {
          setLabel(link.label);
        }
        const info = await api.publicRequestInfo(token!);
        // The link carries the key the owner minted it with; the server's
        // answer has to be that key. Anything else means the files would
        // be sealed to someone other than the person who asked for them.
        if (link.publicKey && link.publicKey !== info.publicKey) {
          setError(
            "This link does not match the vault it points to, so nothing can be sent through it. Ask for a fresh link.",
          );
          return;
        }
        setPublicKey(info.publicKey);
        setMaxBytes(info.maxBytes);
      } catch (err) {
        setError(
          err instanceof ApiError ? err.message : "This request is no longer accepting files.",
        );
      }
    })();
  }, [token, location.hash]);

  const send = async (files: File[]) => {
    if (!publicKey || files.length === 0) {
      return;
    }
    for (const file of files) {
      const itemId = crypto.randomUUID();
      setItems((prev) => [
        ...prev,
        { id: itemId, name: file.name, size: file.size, progress: 0, status: "encrypting" },
      ]);
      const update = (patch: Partial<Sending>) =>
        setItems((prev) => prev.map((s) => (s.id === itemId ? { ...s, ...patch } : s)));
      try {
        if (maxBytes > 0 && file.size > maxBytes) {
          throw new ApiError(413, "too large for the recipient's remaining space");
        }
        const prepared = await analyzeFile(file);
        const fileKey = generateKey();
        // The digest is taken here, on the sender's device, before any
        // encryption: the recipient can never prove what the sender's file
        // held, only that storage returned what it was given. Without this
        // line every received file stayed unverifiable forever.
        const plaintext = new Uint8Array(await file.arrayBuffer());
        if (plaintext.length !== file.size) {
          throw new ApiError(400, "the browser returned the wrong number of bytes");
        }
        const { id } = await api.publicRequestCreateFile(
          token!,
          sealToPublicKey(fileKey, publicKey),
          encryptFileMetadata({ ...prepared.meta, digest: contentDigest(plaintext) }, fileKey),
        );
        await uploadRequestBlob(token!, id, "data", encryptBytes(plaintext, fileKey), (fraction) =>
          update({ status: "uploading", progress: fraction }),
        );
        if (prepared.thumbnail) {
          await uploadRequestBlob(
            token!,
            id,
            "thumbnail",
            encryptBytes(prepared.thumbnail.bytes, fileKey),
          );
        }
        if (prepared.text !== undefined) {
          await uploadRequestBlob(
            token!,
            id,
            "index",
            encryptBytes(utf8Encode(prepared.text), fileKey),
          );
        }
        update({ status: "done", progress: 1 });
      } catch (err) {
        update({
          status: "error",
          error: err instanceof Error ? err.message : "upload failed",
        });
      }
    }
  };

  const doneCount = items.filter((s) => s.status === "done").length;

  return (
    <div
      className="share-shell"
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        void send([...e.dataTransfer.files]);
      }}
    >
      <div className={`share-card request-card${dragging ? " dropzone-active" : ""}`}>
        <BrandMark size={40} />
        {error ? (
          <>
            <h1>Nothing here</h1>
            <p className="sub">{error}</p>
          </>
        ) : !publicKey ? (
          <div className="spinner" style={{ margin: "20px auto" }} />
        ) : (
          <>
            <h1>{label ? label : "Send files"}</h1>
            <p className="sub">
              Files are encrypted in your browser before upload; only the person who made this
              request can open them. Not even the server can look inside.
            </p>
            <button className="btn btn-primary" onClick={() => fileInput.current?.click()}>
              <UploadGlyph /> Choose files
            </button>
            <p className="sub small">or drop them anywhere on this page</p>
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                void send([...(e.target.files ?? [])]);
                e.target.value = "";
              }}
            />
            {items.length > 0 && (
              <div className="request-items">
                {items.map((item) => (
                  <div key={item.id} className="request-item">
                    <div className="request-item-main">
                      <span className="name">{item.name}</span>
                      <span className="meta">
                        {item.status === "error"
                          ? (item.error ?? "failed")
                          : item.status === "done"
                            ? "sent, encrypted"
                            : item.status === "uploading"
                              ? `${Math.round(item.progress * 100)}%`
                              : "encrypting…"}
                      </span>
                    </div>
                    <div className={`request-bar${item.status === "error" ? " failed" : ""}`}>
                      <div
                        style={{
                          width: `${Math.round((item.status === "done" ? 1 : item.progress) * 100)}%`,
                        }}
                      />
                    </div>
                  </div>
                ))}
                {doneCount === items.length && (
                  <p className="sub">
                    {doneCount} file{doneCount === 1 ? "" : "s"} delivered. You can close this page.
                  </p>
                )}
              </div>
            )}
            <p className="sub small">
              {formatBytes(maxBytes)} available · end-to-end encrypted
            </p>
          </>
        )}
      </div>
    </div>
  );
}
