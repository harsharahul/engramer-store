import { useEffect, useState, useSyncExternalStore } from "react";
import { formatBytes } from "../format";
import { activeSaves, SAVE_QUIET_MS, subscribeSaves, visibleSaves } from "../saveprogress";

/**
 * The one narration for bytes leaving or filling the vault: exports,
 * browser downloads, and offline pins all report into the shared save
 * record, and this card tells whatever story is running. Quick saves
 * never appear; anything still working past the quiet window shows its
 * name, phase, and bytes, the way a drive app narrates a download.
 */
export function SaveOverlay() {
  const saves = useSyncExternalStore(subscribeSaves, activeSaves);
  // A save with sparse progress events would otherwise stay hidden past
  // its quiet window until the next event happened to re-render us.
  const [, setTick] = useState(0);
  const shown = visibleSaves(saves, Date.now());

  useEffect(() => {
    if (saves.length === shown.length) {
      return;
    }
    const timer = setTimeout(() => setTick((t) => t + 1), SAVE_QUIET_MS);
    return () => clearTimeout(timer);
  }, [saves, shown.length]);

  if (shown.length === 0) {
    return null;
  }
  return (
    <div className="save-overlay">
      {shown.map((save) => (
        <div key={save.fileId} className="save-row">
          <span className="spinner" />
          <div className="save-words">
            <span className="save-name">{save.name}</span>
            <span className="save-state">
              {save.phase === "decrypt" ? "Decrypting" : "Downloading"}
              {save.total !== null
                ? ` · ${formatBytes(save.done)} of ${formatBytes(save.total)}`
                : "…"}
            </span>
          </div>
          {save.total !== null && (
            <div className="save-bar">
              <div style={{ width: `${Math.min(100, (save.done / save.total) * 100)}%` }} />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
