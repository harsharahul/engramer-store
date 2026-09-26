import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { indentWithTab } from "@codemirror/commands";
import type { FileEntry } from "../store";
import { downloadAndDecrypt } from "../transfer";
import { openSharedContent } from "../openshared";
import { formatBytes } from "../format";
import { languageFor, renderMarkdown } from "../textkinds";
import { XGlyph } from "./Icon";
import { Confirm } from "./Dialogs";
import { Button } from "./ui/button";
import { IconButton } from "./ui/icon-button";

/**
 * In-app editor for text, Markdown and code. The plaintext exists only in
 * this component's state: content decrypts into the editor and
 * re-encrypts with the file's existing key on save, so editing never
 * weakens the E2EE model. CodeMirror supplies what a plain text area
 * could not: highlighting by file type, line numbers, search inside the
 * document, bracket matching, and a Markdown preview beside the text
 * rendered through a sanitizer.
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
  const language = useMemo(() => languageFor(file.name, file.mime), [file.name, file.mime]);
  const isMarkdown = language === "markdown";
  const [preview, setPreview] = useState<boolean>(() => isMarkdown);
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);

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

  // Mount CodeMirror once the text is here; the editor owns the document
  // and reports every change back, so the save path is unchanged.
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    if (text === null || !host.current || view.current) {
      return;
    }
    let cancelled = false;
    void (async () => {
      const extensions: Extension[] = [
        basicSetup,
        keymap.of([
          indentWithTab,
          {
            key: "Mod-s",
            run: () => {
              void saveRef.current();
              return true;
            },
          },
        ]),
        EditorView.lineWrapping,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            setText(update.state.doc.toString());
          }
        }),
        EditorView.theme({
          "&": { height: "100%", fontSize: "14px" },
          ".cm-scroller": { fontFamily: "var(--font-mono)" },
        }),
      ];
      const support = await languageSupport(language);
      if (support) {
        extensions.push(support);
      }
      if (cancelled || !host.current) {
        return;
      }
      view.current = new EditorView({
        state: EditorState.create({ doc: text, extensions }),
        parent: host.current,
      });
      view.current.focus();
    })();
    return () => {
      cancelled = true;
    };
    // The document is seeded once; later edits flow the other way.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text === null, language]);

  useEffect(
    () => () => {
      view.current?.destroy();
      view.current = null;
    },
    [],
  );

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

  const rendered = useMemo(() => (isMarkdown && preview && text !== null ? renderMarkdown(text) : ""), [isMarkdown, preview, text]);

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
          {language !== "plain" ? ` · ${language}` : ""}
        </span>
        <div className="grow" />
        {error && <span className="error-text">{error}</span>}
        {isMarkdown && (
          <Button variant="ghost" aria-pressed={preview} onClick={() => setPreview((p) => !p)}>
            {preview ? "Hide preview" : "Preview"}
          </Button>
        )}
        <Button onClick={save} disabled={!dirty || busy}>
          {busy ? <span className="spinner" /> : null}
          {busy ? "Encrypting" : "Save"}
          {!busy && <kbd className="mono save-kbd">⌘S</kbd>}
        </Button>
        <IconButton label="Close" onClick={close}>
          <XGlyph />
        </IconButton>
      </div>
      <div className={`editor-body${isMarkdown && preview ? " split" : ""}`}>
        {error && text === null ? (
          <div className="preview-fallback">{error}</div>
        ) : text === null ? (
          <div className="spinner" style={{ margin: "40px auto" }} />
        ) : (
          <>
            <div className="editor-code" ref={host} />
            {isMarkdown && preview && (
              <div className="editor-preview markdown" dangerouslySetInnerHTML={{ __html: rendered }} />
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** The CodeMirror language package for a kind, loaded on demand. */
async function languageSupport(language: string): Promise<Extension | null> {
  switch (language) {
    case "markdown":
      return (await import("@codemirror/lang-markdown")).markdown();
    case "json":
      return (await import("@codemirror/lang-json")).json();
    case "javascript":
      return (await import("@codemirror/lang-javascript")).javascript({ typescript: true, jsx: true });
    case "yaml":
      return (await import("@codemirror/lang-yaml")).yaml();
    case "html":
      return (await import("@codemirror/lang-html")).html();
    case "css":
      return (await import("@codemirror/lang-css")).css();
    default:
      return null;
  }
}
