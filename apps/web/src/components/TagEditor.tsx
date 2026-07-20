import { useState, type KeyboardEvent } from "react";
import type { FileEntry } from "../store";
import { XGlyph } from "./Icon";

export function TagEditor(props: {
  file: FileEntry;
  suggestions: string[];
  onSave: (tags: string[]) => Promise<void>;
  onClose: () => void;
}) {
  const [tags, setTags] = useState<string[]>(props.file.tags);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  const add = (value: string) => {
    const tag = value.trim().toLowerCase();
    if (tag && !tags.includes(tag)) {
      setTags([...tags, tag]);
    }
    setDraft("");
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      add(draft);
    } else if (event.key === "Backspace" && !draft && tags.length > 0) {
      setTags(tags.slice(0, -1));
    }
  };

  const save = async () => {
    setBusy(true);
    try {
      await props.onSave(draft.trim() ? [...tags, draft.trim().toLowerCase()] : tags);
      props.onClose();
    } finally {
      setBusy(false);
    }
  };

  const unused = props.suggestions.filter((s) => !tags.includes(s)).slice(0, 10);

  return (
    <div className="overlay" onClick={props.onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Tags for “{props.file.name}”</h2>
        <p className="modal-sub">
          Tags are auto-assigned at upload and stored inside the encrypted metadata. Edit them
          freely; the server still sees only ciphertext.
        </p>
        <div className="tag-input">
          {tags.map((tag) => (
            <span key={tag} className="tag editable">
              {tag}
              <button onClick={() => setTags(tags.filter((t) => t !== tag))} title="Remove">
                <XGlyph size={11} />
              </button>
            </span>
          ))}
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={tags.length === 0 ? "Add a tag and press Enter" : ""}
          />
        </div>
        {unused.length > 0 && (
          <div className="tag-suggestions">
            {unused.map((tag) => (
              <button key={tag} className="tag" onClick={() => add(tag)}>
                + {tag}
              </button>
            ))}
          </div>
        )}
        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={props.onClose}>
            Cancel
          </button>
          <button className="btn btn-brass" onClick={save} disabled={busy}>
            Save tags
          </button>
        </div>
      </div>
    </div>
  );
}
