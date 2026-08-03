import { useCallback, useEffect, useRef, useState } from "react";
import type { FileEntry } from "../store";
import { downloadAndDecrypt } from "../transfer";
import { Converter } from "../office/x2t";
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
 * The frame is deliberately given nothing but bytes.
 */

const HOST_URL = "/office/engram-host.html";

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
  const saveWaiters = useRef(new Map<number, (bin: string) => void>());
  const saveSeq = useRef(0);
  const [stage, setStage] = useState<Stage>("decrypting");
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    const converter = new Converter();
    converterRef.current = converter;
    let cancelled = false;

    const onMessage = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) {
        return;
      }
      const data = event.data as { t?: string; [key: string]: unknown };
      if (data?.t === "hello") {
        void start();
        return;
      }
      if (data?.t === "progress" && data.stage === "loading") {
        setStage((current) => (current === "converting" ? "loading" : current));
        return;
      }
      if (data?.t === "ready") {
        setStage("ready");
        return;
      }
      if (data?.t === "changed") {
        setDirty(Boolean(data.modified));
        return;
      }
      if (data?.t === "saved") {
        const waiter = saveWaiters.current.get(Number(data.id));
        if (waiter) {
          saveWaiters.current.delete(Number(data.id));
          waiter(typeof data.bin === "string" ? data.bin : "");
        }
        if (typeof data.error === "string") {
          setError(data.error);
        }
        return;
      }
      if (data?.t === "failed") {
        setStage("failed");
        setError(typeof data.error === "string" ? data.error : "the editor could not open this file");
      }
    };

    async function start() {
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
        const transfer: Transferable[] = [imported.bin.buffer as ArrayBuffer];
        frameRef.current?.contentWindow?.postMessage(
          {
            t: "open",
            fileType,
            title: file.name,
            bin: imported.bin,
            media: imported.media,
          },
          "*",
          transfer,
        );
      } catch (err) {
        if (!cancelled) {
          setStage("failed");
          setError(err instanceof Error ? err.message : "could not open this document");
        }
      }
    }

    window.addEventListener("message", onMessage);
    return () => {
      cancelled = true;
      window.removeEventListener("message", onMessage);
      converter.close();
      converterRef.current = null;
    };
  }, [file.id, file.key, file.name, fileType]);

  const save = useCallback(async () => {
    const converter = converterRef.current;
    if (!converter || busy || stage !== "ready") {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const id = ++saveSeq.current;
      const bin = await new Promise<string>((resolve, reject) => {
        saveWaiters.current.set(id, resolve);
        frameRef.current?.contentWindow?.postMessage({ t: "save", id }, "*");
        setTimeout(() => {
          if (saveWaiters.current.delete(id)) {
            reject(new Error("the editor did not respond"));
          }
        }, 120_000);
      });
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
        <button className="btn btn-primary" onClick={() => void save()} disabled={!dirty || busy}>
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
          src={HOST_URL}
          // No allow-same-origin: the frame runs in an opaque origin and so
          // cannot reach this page, its storage, its cookies or its session.
          // Removing this attribute would hand vendored third-party code the
          // run of the origin that holds the master key.
          sandbox="allow-scripts"
          style={{ visibility: stage === "ready" ? "visible" : "hidden" }}
        />
      </div>
    </div>
  );
}
