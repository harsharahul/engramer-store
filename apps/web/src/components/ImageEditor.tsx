import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FileEntry } from "../store";
import { downloadAndDecrypt } from "../transfer";
import { openSharedContent } from "../openshared";
import { displayableImage } from "../intel/heic";
import {
  NO_EDITS,
  aspectCrop,
  clampCrop,
  isUntouched,
  nextTurn,
  outputMime,
  outputName,
  renderEdits,
  turnedSize,
  type ImageEdits,
  type Mark,
  type Rect,
} from "../imageedit";
import { XGlyph } from "./Icon";
import { Confirm } from "./Dialogs";

/**
 * Rotate, flip, crop and mark up a picture. Edits are kept as data and
 * drawn as a preview; Save renders them once onto the original pixels
 * and writes the result back as a new version (a HEIC becomes a JPEG
 * beside the original). The original bytes never change until Save.
 */

type Tool = "none" | "crop" | "box" | "arrow" | "text" | "blur";
const COLORS = ["#ff3b30", "#ffcc00", "#34c759", "#0a84ff", "#ffffff", "#000000"];

export function ImageEditor(props: {
  file: FileEntry;
  onSave: (bytes: Uint8Array, mime: "image/png" | "image/jpeg", name: string) => Promise<void>;
  onClose: () => void;
}) {
  const { file } = props;
  const [source, setSource] = useState<HTMLImageElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [edits, setEdits] = useState<ImageEdits>(NO_EDITS);
  const [tool, setTool] = useState<Tool>("none");
  const [color, setColor] = useState(COLORS[0]!);
  const [busy, setBusy] = useState(false);
  const [pendingClose, setPendingClose] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ x: number; y: number } | null>(null);
  const [dragRect, setDragRect] = useState<Rect | null>(null);

  useEffect(() => {
    let cancelled = false;
    let url: string | null = null;
    void openSharedContent(file, (entry) => downloadAndDecrypt(entry.id, entry.key, entry.digest, { preferLocal: true }))
      .then((bytes) => displayableImage(new Blob([bytes.slice().buffer as ArrayBuffer], { type: file.mime }), file.name))
      .then(
        (blob) =>
          new Promise<HTMLImageElement>((resolve, reject) => {
            url = URL.createObjectURL(blob);
            const image = new Image();
            image.onload = () => resolve(image);
            image.onerror = () => reject(new Error("could not decode this image"));
            image.src = url;
          }),
      )
      .then((image) => {
        if (!cancelled) setSource(image);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "could not open this image");
      });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [file.id, file.key, file.mime, file.name]);

  const size = useMemo(
    () => (source ? turnedSize(source.naturalWidth, source.naturalHeight, edits.turn) : null),
    [source, edits.turn],
  );

  // The preview is the edits without the crop applied (the crop shows as
  // a frame), so what the user drew stays visible while they adjust it.
  useEffect(() => {
    if (!source || !canvas.current) return;
    renderEdits(source, source.naturalWidth, source.naturalHeight, { ...edits, crop: null }, canvas.current);
  }, [source, edits]);

  const dirty = !isUntouched(edits);

  const pointOf = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const target = event.currentTarget;
    const box = target.getBoundingClientRect();
    const scaleX = target.width / box.width;
    const scaleY = target.height / box.height;
    return { x: (event.clientX - box.left) * scaleX, y: (event.clientY - box.top) * scaleY };
  };

  const onDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (tool === "none") return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = pointOf(event);
    setDragRect(null);
  };

  const onMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drag.current || !size) return;
    const now = pointOf(event);
    const rect = clampCrop(
      {
        x: Math.min(drag.current.x, now.x),
        y: Math.min(drag.current.y, now.y),
        width: Math.abs(now.x - drag.current.x),
        height: Math.abs(now.y - drag.current.y),
      },
      size.width,
      size.height,
    );
    setDragRect(rect);
  };

  const onUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drag.current || !size) return;
    const start = drag.current;
    const end = pointOf(event);
    drag.current = null;
    const rect = dragRect;
    setDragRect(null);
    if (tool === "crop") {
      if (rect && rect.width > 8 && rect.height > 8) {
        setEdits((e) => ({ ...e, crop: rect }));
      }
      return;
    }
    if (tool === "text") {
      const text = window.prompt("Text to add");
      if (text && text.trim()) {
        const fontSize = Math.max(16, Math.round(Math.max(size.width, size.height) / 40));
        addMark({ kind: "text", at: { x: end.x, y: end.y }, text: text.trim(), color, size: fontSize });
      }
      return;
    }
    if (!rect || rect.width < 4 || rect.height < 4) {
      return;
    }
    if (tool === "box") addMark({ kind: "box", rect, color });
    if (tool === "blur") addMark({ kind: "blur", rect });
    if (tool === "arrow") addMark({ kind: "arrow", from: start, to: end, color });
  };

  const addMark = (mark: Mark) => setEdits((e) => ({ ...e, marks: [...e.marks, mark] }));

  const save = useCallback(async () => {
    if (!source || busy || !dirty) return;
    setBusy(true);
    setError(null);
    try {
      const out = document.createElement("canvas");
      renderEdits(source, source.naturalWidth, source.naturalHeight, edits, out);
      const mime = outputMime(file.mime, file.name);
      const blob = await new Promise<Blob | null>((resolve) => out.toBlob(resolve, mime, 0.92));
      if (!blob) throw new Error("could not encode the image");
      const bytes = new Uint8Array(await blob.arrayBuffer());
      await props.onSave(bytes, mime, outputName(file.name, mime));
      setEdits(NO_EDITS);
    } catch (err) {
      setError(err instanceof Error ? err.message : "save failed");
    } finally {
      setBusy(false);
    }
  }, [source, busy, dirty, edits, file.mime, file.name, props]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void save();
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        setEdits((e) => ({ ...e, marks: e.marks.slice(0, -1) }));
      } else if (event.key === "Escape" && !dirty) {
        props.onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save, dirty, props]);

  const frame = dragRect ?? (tool === "crop" ? edits.crop : null);
  const frameStyle = (rect: Rect): React.CSSProperties | undefined => {
    if (!size || !canvas.current) return undefined;
    const box = canvas.current.getBoundingClientRect();
    const sx = box.width / size.width;
    const sy = box.height / size.height;
    return { left: rect.x * sx, top: rect.y * sy, width: rect.width * sx, height: rect.height * sy };
  };

  return (
    <div className="preview-shell">
      {pendingClose && (
        <Confirm
          title="Discard unsaved edits?"
          confirmLabel="Discard"
          danger
          onConfirm={props.onClose}
          onClose={() => setPendingClose(false)}
        />
      )}
      <div className="preview-top">
        <span className="name">
          {file.name}
          {dirty && <span className="dirty-dot" title="Unsaved edits" />}
        </span>
        {size && (
          <span className="meta">
            {edits.crop ? `${edits.crop.width} × ${edits.crop.height}` : `${size.width} × ${size.height}`}
          </span>
        )}
        <div className="grow" />
        {error && <span className="error-text">{error}</span>}
        <button className="btn btn-primary" onClick={() => void save()} disabled={!dirty || busy}>
          {busy ? "Encrypting" : "Save"}
        </button>
        <button className="icon-btn" title="Close" onClick={() => (dirty ? setPendingClose(true) : props.onClose())}>
          <XGlyph />
        </button>
      </div>
      <div className="imgedit-tools" role="toolbar" aria-label="Image tools">
        <button className="btn btn-ghost" onClick={() => setEdits((e) => ({ ...e, turn: nextTurn(e.turn, -90), crop: null }))}>
          Rotate left
        </button>
        <button className="btn btn-ghost" onClick={() => setEdits((e) => ({ ...e, turn: nextTurn(e.turn, 90), crop: null }))}>
          Rotate right
        </button>
        <button className="btn btn-ghost" onClick={() => setEdits((e) => ({ ...e, flipH: !e.flipH }))}>
          Flip
        </button>
        <span className="imgedit-sep" />
        {(
          [
            ["crop", "Crop"],
            ["box", "Box"],
            ["arrow", "Arrow"],
            ["text", "Text"],
            ["blur", "Blur"],
          ] as Array<[Tool, string]>
        ).map(([id, label]) => (
          <button key={id} className={`btn btn-ghost${tool === id ? " active" : ""}`} onClick={() => setTool(tool === id ? "none" : id)}>
            {label}
          </button>
        ))}
        {tool === "crop" && size && (
          <>
            {(
              [
                ["Free", 0],
                ["1:1", 1],
                ["4:3", 4 / 3],
                ["16:9", 16 / 9],
                ["3:4", 3 / 4],
              ] as Array<[string, number]>
            ).map(([label, aspect]) => (
              <button
                key={label}
                className="btn btn-ghost small"
                onClick={() =>
                  setEdits((e) => ({ ...e, crop: aspect ? aspectCrop(size.width, size.height, aspect) : null }))
                }
              >
                {label}
              </button>
            ))}
          </>
        )}
        {(tool === "box" || tool === "arrow" || tool === "text") && (
          <span className="imgedit-colors">
            {COLORS.map((c) => (
              <button
                key={c}
                className={`imgedit-color${color === c ? " on" : ""}`}
                style={{ background: c }}
                aria-label={`Colour ${c}`}
                onClick={() => setColor(c)}
              />
            ))}
          </span>
        )}
        {edits.marks.length > 0 && (
          <button className="btn btn-ghost" onClick={() => setEdits((e) => ({ ...e, marks: e.marks.slice(0, -1) }))}>
            Undo mark
          </button>
        )}
        {dirty && (
          <button className="btn btn-ghost" onClick={() => setEdits(NO_EDITS)}>
            Reset
          </button>
        )}
        <span className="pdfv-hint">
          {tool === "none"
            ? "Choose a tool, or rotate and flip. Saving writes a new version."
            : tool === "crop"
              ? "Drag a frame, or pick a shape."
              : tool === "text"
                ? "Click where the text goes."
                : "Drag over the picture."}
        </span>
      </div>
      <div className="imgedit-body">
        {error && !source ? (
          <div className="preview-fallback">{error}</div>
        ) : !source ? (
          <div className="spinner" style={{ margin: "40px auto" }} />
        ) : (
          <div className="imgedit-stage">
            <canvas
              ref={canvas}
              className={`imgedit-canvas${tool !== "none" ? " drawing" : ""}`}
              onPointerDown={onDown}
              onPointerMove={onMove}
              onPointerUp={onUp}
            />
            {frame && <div className="imgedit-frame" style={frameStyle(frame)} />}
          </div>
        )}
      </div>
    </div>
  );
}
