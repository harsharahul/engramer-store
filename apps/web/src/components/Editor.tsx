import { useCallback, useEffect, useState } from "react";
import type { FileEntry } from "../store";
import { downloadAndDecrypt } from "../transfer";
import { openSharedContent } from "../openshared";
import { formatBytes } from "../format";
import { XGlyph } from "./Icon";
import { Confirm } from "./Dialogs";

/**
 * In-app editor for text and Markdown. The plaintext exists only in this
 * component's state: content decrypts into the textarea and re-encrypts with
 * the file's existing key on save, so editing never weakens the E2EE model.
 */
export function Editor(props: {
  file: FileEntry;
  onSave: (text: string) => Promise<void>;
  onClose: () => void;
}) {
  const { file } = props;
  const [text, setText] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    void openSharedContent(file, (entry) =>
      downloadAndDecrypt(entry.id, entry.key, entry.digest, { preferLocal: true }),
    )
      .then((bytes) => {
        if (!cancelled) {
          const decoded = new TextDecoder().decode(bytes);
          setText(decoded);
          setSaved(decoded);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setError("could not decrypt this file");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [file.id, file.key]);

  const dirty = text !== null && text !== saved;

  const save = useCallback(async () => {
    if (text === null || busy || !dirty) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await props.onSave(text);
      setSaved(text);
      setSavedAt(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : "save failed");
    } finally {
      setBusy(false);
    }
  }, [text, busy, dirty, props]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void save();
      } else if (event.key === "Escape" && !dirty) {
        props.onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save, dirty, props]);

  // The question is asked with an in-app dialog: the iOS shell never
  // renders window.confirm, which silently discarded the close instead.
  const [pendingClose, setPendingClose] = useState(false);
  const close = () => {
    if (dirty) {
      setPendingClose(true);
      return;
    }
    props.onClose();
  };

  return (
    <div className="preview-shell">
      {pendingClose && (
        <Confirm
          title="Discard unsaved changes?"
          confirmLabel="Discard"
          danger
          onConfirm={props.onClose}
          onClose={() => setPendingClose(false)}
        />
      )}
      <div className="preview-top">
        <span className="name">
          {file.name}
          {dirty && <span className="dirty-dot" title="Unsaved changes" />}
        </span>
        <span className="meta">
          {text !== null ? formatBytes(new TextEncoder().encode(text).length) : ""}
          {savedAt && !dirty ? " · saved, encrypted" : ""}
        </span>
        <div className="grow" />
        {error && <span className="error-text">{error}</span>}
        <button className="btn btn-primary" onClick={save} disabled={!dirty || busy}>
          {busy ? <span className="spinner" /> : null}
          {busy ? "Encrypting" : "Save"}
          {!busy && <kbd className="mono save-kbd">⌘S</kbd>}
        </button>
        <button className="icon-btn" title="Close" onClick={close}>
          <XGlyph />
        </button>
      </div>
      <div className="editor-body">
        {error && text === null ? (
          <div className="preview-fallback">{error}</div>
        ) : text === null ? (
          <div className="spinner" style={{ margin: "40px auto" }} />
        ) : (
          <textarea
            className="editor-textarea"
            value={text}
            autoFocus
            spellCheck={file.mime.startsWith("text/") && !/\.(json|ya?ml|csv)$/i.test(file.name)}
            onChange={(e) => setText(e.target.value)}
            placeholder="Write something. It is encrypted before it leaves this tab."
          />
        )}
      </div>
    </div>
  );
}
