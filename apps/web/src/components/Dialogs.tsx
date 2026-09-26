import { useState, type FormEvent } from "react";
import { Button } from "./ui/button";

export function TextPrompt(props: {
  title: string;
  sub?: string;
  initial?: string;
  submitLabel: string;
  onSubmit: (value: string) => Promise<void> | void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(props.initial ?? "");
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) {
      return;
    }
    setBusy(true);
    try {
      await props.onSubmit(trimmed);
      props.onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="overlay" onClick={props.onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{props.title}</h2>
        {props.sub && <p className="modal-sub">{props.sub}</p>}
        <form onSubmit={submit}>
          <input autoFocus value={value} onChange={(e) => setValue(e.target.value)} />
          <div className="modal-actions">
            <Button type="button" variant="ghost" onClick={props.onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !value.trim()}>
              {props.submitLabel}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

export function Confirm(props: {
  title: string;
  sub?: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => Promise<void> | void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);

  const confirm = async () => {
    setBusy(true);
    try {
      await props.onConfirm();
      props.onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="overlay" onClick={props.onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{props.title}</h2>
        {props.sub && <p className="modal-sub">{props.sub}</p>}
        <div className="modal-actions">
          <Button variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            variant={props.danger ? "destructive" : "default"}
            onClick={confirm}
            disabled={busy}
          >
            {props.confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
