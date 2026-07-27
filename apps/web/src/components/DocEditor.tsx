import { useCallback, useEffect, useRef, useState } from "react";
import { SuperDoc } from "@harbour-enterprises/superdoc";
import "@harbour-enterprises/superdoc/style.css";
import type { FileEntry } from "../store";
import { downloadAndDecrypt } from "../transfer";
import { formatBytes } from "../format";
import { XGlyph } from "./Icon";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/**
 * Word-document editor. SuperDoc (AGPL, like this project) parses and edits
 * OOXML entirely in the browser: the decrypted bytes go straight into the
 * editor, and saving exports a fresh .docx that is re-encrypted with the
 * file's existing key before upload. Telemetry is disabled; no request ever
 * leaves this device with document data on it.
 */
export function DocEditor(props: {
  file: FileEntry;
  onSave: (bytes: Uint8Array) => Promise<void>;
  onClose: () => void;
}) {
  const { file } = props;
  const mountRef = useRef<HTMLDivElement>(null);
  const superdocRef = useRef<SuperDoc | null>(null);
  const readyRef = useRef(false);
  const savingRef = useRef(false);
  const [ready, setReady] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    let instance: SuperDoc | null = null;
    void downloadAndDecrypt(file.id, file.key)
      .then((bytes) => {
        if (cancelled || !mountRef.current) {
          return;
        }
        const doc = new File([bytes.slice().buffer as ArrayBuffer], file.name, {
          type: DOCX_MIME,
        });
        instance = new SuperDoc({
          selector: mountRef.current,
          toolbar: "#superdoc-toolbar",
          document: doc,
          documentMode: "editing",
          telemetry: { enabled: false },
          uiDisplayFallbackFont: '"Geist Variable", -apple-system, sans-serif',
          onReady: () => {
            if (!cancelled) {
              // Imports emit editor updates while loading; only edits made
              // after this point count as unsaved changes.
              setTimeout(() => {
                readyRef.current = true;
              }, 0);
              setReady(true);
            }
          },
          onEditorUpdate: () => {
            // Export itself runs editor transactions; those are not edits.
            if (!cancelled && readyRef.current && !savingRef.current) {
              setDirty(true);
            }
          },
          onContentError: () => {
            if (!cancelled) {
              setError("could not open this document");
            }
          },
          onException: () => {
            // Import failures on unusual OOXML land here; fail visibly
            // rather than leaving a spinner. The stored bytes are untouched.
            if (!cancelled) {
              setError("could not open this document");
            }
          },
        });
        superdocRef.current = instance;
      })
      .catch((err: unknown) => {
        // Decrypt failures and synchronous editor-init failures both land
        // here; either way the stored ciphertext is untouched.
        if (!cancelled) {
          setError(
            err instanceof Error && err.message ? err.message : "could not open this document",
          );
        }
      });
    return () => {
      cancelled = true;
      instance?.destroy();
      superdocRef.current = null;
    };
  }, [file.id, file.key, file.name]);

  const save = useCallback(async () => {
    const superdoc = superdocRef.current;
    if (!superdoc || busy || !dirty) {
      return;
    }
    setBusy(true);
    setError(null);
    savingRef.current = true;
    try {
      const blob = await superdoc.export({ exportType: ["docx"], triggerDownload: false });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      await props.onSave(bytes);
      setDirty(false);
      setSavedAt(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : "save failed");
    } finally {
      // Export-time editor transactions can land a few ticks after the blob
      // is produced; keep suppressing dirty until they have drained.
      setTimeout(() => {
        savingRef.current = false;
      }, 500);
      setBusy(false);
    }
  }, [busy, dirty, props]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save]);

  const close = () => {
    if (dirty && !window.confirm("Discard unsaved changes?")) {
      return;
    }
    props.onClose();
  };

  return (
    <div className="preview-shell">
      <div className="preview-top">
        <span className="name">
          {file.name}
          {dirty && <span className="dirty-dot" title="Unsaved changes" />}
        </span>
        <span className="meta">
          {formatBytes(file.size)}
          {savedAt && !dirty ? " · saved, encrypted" : ""}
        </span>
        <div className="grow" />
        {error && <span className="error-text">{error}</span>}
        <button className="btn btn-primary" onClick={() => void save()} disabled={!dirty || busy}>
          {busy ? <span className="spinner" /> : null}
          {busy ? "Encrypting" : "Save"}
          {!busy && <kbd className="mono save-kbd">⌘S</kbd>}
        </button>
        <button className="icon-btn" title="Close" onClick={close}>
          <XGlyph />
        </button>
      </div>
      <div className="doc-editor-body">
        <div id="superdoc-toolbar" className="doc-toolbar" />
        <div className="doc-canvas">
          {!ready && !error && <div className="spinner" style={{ margin: "40px auto" }} />}
          <div ref={mountRef} className="doc-mount" />
        </div>
      </div>
    </div>
  );
}
