import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FileEntry } from "../store";
import { downloadAndDecrypt } from "../transfer";
import { Converter } from "../office/x2t";
import { EditorSession, editorFrameUrl } from "../office/session";
import { diag } from "../diag";
import { XGlyph } from "./Icon";

/**
 * Word and Excel editing.
 *
 * The document is decrypted here, converted on this origin by a worker, and
 * handed to an editor running in a sandboxed frame that cannot reach this
 * page, its storage or its keys. Saving reverses the path: the editor
 * returns the document in its internal format, the worker converts it back,
 * and the caller re-encrypts it under the file's existing key.
 *
 * The frame is deliberately given nothing but bytes. It is a single document
 * with an opaque origin, which is what denies it storage entirely; the
 * protocol that would otherwise be spoken by a wrapper script creating a
 * second frame lives in ../office/session.ts instead.
 */

type Stage = "decrypting" | "converting" | "loading" | "ready" | "failed";

const STAGE_LABEL: Record<Stage, string> = {
  ready: "",
  failed: "",
  decrypting: "Decrypting",
  converting: "Reading the document",
  loading: "Starting the editor",
};

export function OfficeEditor(props: {
  file: FileEntry;
  fileType: "docx" | "xlsx";
  onSave: (bytes: Uint8Array) => Promise<void>;
  onClose: () => void;
}) {
  const { file, fileType } = props;
  const frameRef = useRef<HTMLIFrameElement>(null);
  const converterRef = useRef<Converter | null>(null);
  const sessionRef = useRef<EditorSession | null>(null);
  // The editor's own save shortcut arrives as a message, which the session
  // hands on; it needs whatever save() currently is, not the one that existed
  // when the session was built.
  const saveRef = useRef<() => void>(() => {});
  const [stage, setStage] = useState<Stage>("decrypting");
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // The frame's address depends only on the kind of document, so the editor
  // begins loading its several megabytes immediately, while this file is
  // still being downloaded, decrypted and converted.
  const frameUrl = useMemo(() => editorFrameUrl(fileType), [fileType]);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) {
      return;
    }
    const converter = new Converter();
    converterRef.current = converter;
    let cancelled = false;

    const session = new EditorSession(frame, fileType, file.name, {
      onLoading: () => diag("office", "the editor is up and waiting for its document"),
      onReady: () => {
        setStage("ready");
        session.focus();
      },
      onChanged: (modified) => {
        // Only ever set. The editor clears its own modified flag as soon as
        // the stand-in collaboration server acknowledges a change, about a
        // second after typing; treating that as "saved" would grey out Save
        // and let the document close with the edit only in the editor.
        if (modified) {
          setDirty(true);
        }
      },
      onShortcut: (name) => {
        if (name === "save") {
          saveRef.current();
        }
      },
      onFailed: (message) => {
        setStage("failed");
        setError(message);
      },
    });
    sessionRef.current = session;

    void (async () => {
      try {
        setStage("decrypting");
        const plaintext = await downloadAndDecrypt(file.id, file.key);
        if (cancelled) {
          return;
        }
        setStage("converting");
        const imported = await converter.importDocument(`document.${fileType}`, plaintext);
        if (cancelled) {
          return;
        }
        session.deliver(imported.bin, imported.media);
        setStage("loading");
      } catch (err) {
        if (!cancelled) {
          setStage("failed");
          setError(err instanceof Error ? err.message : "could not open this document");
        }
      }
    })();

    return () => {
      cancelled = true;
      session.close();
      sessionRef.current = null;
      converter.close();
      converterRef.current = null;
    };
  }, [file.id, file.key, file.name, fileType]);

  const save = useCallback(async () => {
    const converter = converterRef.current;
    const session = sessionRef.current;
    if (!converter || !session || busy || stage !== "ready") {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const bin = await session.save();
      if (!bin) {
        throw new Error("the editor returned nothing to save");
      }
      const out = await converter.exportDocument(`document.${fileType}`, bin);
      await props.onSave(out);
      setDirty(false);
      setSavedAt(Date.now());
      diag("office", `saved ${file.name} (${out.length} bytes)`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "save failed");
    } finally {
      setBusy(false);
    }
  }, [busy, stage, fileType, props, file.name]);

  useEffect(() => {
    saveRef.current = () => void save();
  }, [save]);

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

  const close = useCallback(() => {
    if (dirty && !window.confirm("Close without saving your changes?")) {
      return;
    }
    props.onClose();
  }, [dirty, props]);

  return (
    <div className="preview-shell">
      <div className="preview-top">
        <span className="name">
          {file.name}
          {dirty && <span className="dirty-dot" title="Unsaved changes" />}
        </span>
        <span className="meta">
          {stage === "ready" ? (savedAt && !dirty ? "saved, encrypted" : "") : STAGE_LABEL[stage]}
        </span>
        <div className="grow" />
        {error && <span className="error-text">{error}</span>}
        <button
          className="btn btn-primary"
          onClick={() => void save()}
          disabled={stage !== "ready" || busy}
        >
          {busy ? <span className="spinner" /> : null}
          {busy ? "Encrypting" : "Save"}
          {!busy && <kbd className="mono save-kbd">⌘S</kbd>}
        </button>
        <button className="icon-btn" title="Close" onClick={close}>
          <XGlyph />
        </button>
      </div>
      <div className="office-body">
        {stage === "failed" ? (
          <div className="preview-fallback">{error ?? "this document could not be opened"}</div>
        ) : null}
        {stage !== "ready" && stage !== "failed" && (
          <div className="office-loading">
            <span className="spinner" />
            {STAGE_LABEL[stage]}
          </div>
        )}
        <iframe
          ref={frameRef}
          className="office-frame"
          title={file.name}
          src={frameUrl}
          // No allow-same-origin: the frame runs in an opaque origin and so
          // cannot reach this page, its storage, its cookies or its session,
          // and has no storage of its own. Adding it would hand vendored
          // third-party code the run of the origin that holds the master key.
          sandbox="allow-scripts"
          style={{ visibility: stage === "ready" ? "visible" : "hidden" }}
        />
      </div>
    </div>
  );
}
