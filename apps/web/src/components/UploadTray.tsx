import { useStore } from "../store";
import { XGlyph } from "./Icon";

export function UploadTray() {
  const uploads = useStore((s) => s.uploads);
  const clear = useStore((s) => s.clearFinishedUploads);

  if (uploads.length === 0) {
    return null;
  }
  const active = uploads.filter((u) => u.status === "encrypting" || u.status === "uploading");

  return (
    <div className="upload-tray">
      <header>
        <span>
          {active.length > 0
            ? `Encrypting and uploading ${active.length} file${active.length > 1 ? "s" : ""}`
            : "Uploads finished"}
        </span>
        <button className="icon-btn" title="Clear" onClick={clear}>
          <XGlyph size={14} />
        </button>
      </header>
      <ul>
        {uploads.map((upload) => (
          <li key={upload.id}>
            <div className="upload-name">
              <span>{upload.name}</span>
              <span
                className={`upload-state ${
                  upload.status === "done" ? "ok" : upload.status === "error" ? "err" : ""
                }`}
              >
                {upload.status === "encrypting"
                  ? "encrypting"
                  : upload.status === "uploading"
                    ? `${Math.round(upload.progress * 100)}%`
                    : upload.status === "done"
                      ? "done"
                      : (upload.error ?? "failed")}
              </span>
            </div>
            {(upload.status === "uploading" || upload.status === "encrypting") && (
              <div className="progress">
                <div style={{ width: `${Math.round(upload.progress * 100)}%` }} />
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
