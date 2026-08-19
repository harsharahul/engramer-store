/**
 * The shared narration for bytes leaving the vault: an iOS export, a
 * browser download, a pin filling in the background. Every path reports
 * begin, progress, and end here, and one overlay renders whatever is
 * active, so each surface speaks the same visual language. Kept apart
 * from the app store on purpose: this is transient ceremony, not state
 * anyone persists or syncs.
 */

export type SavePhase = "download" | "decrypt";

export interface SaveProgress {
  fileId: string;
  name: string;
  phase: SavePhase;
  done: number;
  total: number | null;
  /** When the save began; the overlay uses it to keep quick saves quiet. */
  startedAt: number;
}

const active = new Map<string, SaveProgress>();
const listeners = new Set<() => void>();

/** Cached so an unchanged store answers the same array identity, which
 * is what useSyncExternalStore needs to not re-render forever. */
let snapshot: SaveProgress[] = [];
let snapshotStale = false;

function changed(): void {
  snapshotStale = true;
  for (const listener of listeners) {
    listener();
  }
}

export function beginSave(fileId: string, name: string): void {
  active.set(fileId, {
    fileId,
    name,
    phase: "download",
    done: 0,
    total: null,
    startedAt: Date.now(),
  });
  changed();
}

/** Progress for a save nobody began is someone else's event; ignored. */
export function updateSave(
  fileId: string,
  phase: SavePhase,
  done: number,
  total: number | null,
): void {
  const save = active.get(fileId);
  if (!save) {
    return;
  }
  active.set(fileId, { ...save, phase, done, total });
  changed();
}

export function endSave(fileId: string): void {
  if (active.delete(fileId)) {
    changed();
  }
}

export function activeSaves(): SaveProgress[] {
  if (snapshotStale) {
    snapshot = [...active.values()];
    snapshotStale = false;
  }
  return snapshot;
}

export function subscribeSaves(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** How long a save may run before the overlay appears. A quick save
 * finishes inside the window and shows no ceremony at all. */
export const SAVE_QUIET_MS = 400;

/** The saves worth narrating at `now`: the ones still running past the
 * quiet window. Pure so the overlay's one decision stays testable. */
export function visibleSaves(saves: SaveProgress[], now: number): SaveProgress[] {
  return saves.filter((save) => now - save.startedAt > SAVE_QUIET_MS);
}
