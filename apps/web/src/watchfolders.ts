/**
 * Watch-folder sync: the desktop shell reports files appearing in folders
 * the user chose, and this module turns them into ordinary encrypted
 * uploads through the existing pipeline. One-way by design: nothing here
 * ever deletes or modifies anything, locally or in the vault. A file whose
 * name and size already exist anywhere in the library is considered
 * uploaded and skipped, so re-scans and app restarts stay idempotent.
 */
import { useStore } from "./store";
import {
  nativeListen,
  nativeShell,
  watchedFileRead,
  watchedScan,
  type WatchedFile,
} from "./native";
import type { TreeFile } from "./uploader";

/** v1 reads whole files through the shell bridge; keep that bounded. */
const MAX_WATCH_FILE_BYTES = 1_536 * 1024 * 1024;

let started = false;
const pending = new Map<string, WatchedFile>();
const inFlight = new Set<string>();
let drainTimer: ReturnType<typeof setTimeout> | null = null;

function alreadyInLibrary(file: WatchedFile): boolean {
  for (const entry of useStore.getState().files.values()) {
    if (!entry.trashed && entry.name === file.name && entry.size === file.size) {
      return true;
    }
  }
  return false;
}

async function drain(): Promise<void> {
  const batch = [...pending.values()];
  pending.clear();
  const fresh = batch.filter(
    (file) =>
      !inFlight.has(file.path) &&
      !alreadyInLibrary(file) &&
      file.size > 0 &&
      file.size <= MAX_WATCH_FILE_BYTES,
  );
  if (fresh.length === 0) {
    return;
  }
  fresh.forEach((file) => inFlight.add(file.path));
  try {
    const items: TreeFile[] = [];
    for (const file of fresh) {
      try {
        const bytes = await watchedFileRead(file.path);
        items.push({
          file: new File([bytes], file.name, { lastModified: file.mtime }),
          path: file.rel_dirs,
        });
      } catch {
        // Unreadable now (moved, permissions); a later event retries it.
        inFlight.delete(file.path);
      }
    }
    if (items.length > 0) {
      await useStore.getState().uploadTree(items, null);
    }
  } finally {
    fresh.forEach((file) => inFlight.delete(file.path));
  }
}

function enqueue(files: WatchedFile[]): void {
  for (const file of files) {
    pending.set(file.path, file);
  }
  if (pending.size > 0 && drainTimer === null) {
    // A short quiet period batches a burst of files into one upload wave.
    drainTimer = setTimeout(() => {
      drainTimer = null;
      void drain();
    }, 2_000);
  }
}

/**
 * Starts watch-folder sync once per session inside the desktop shell:
 * reconciles what accumulated while the app was closed, then follows
 * live watcher events.
 */
export async function startWatchSync(): Promise<void> {
  if (started || !nativeShell()) {
    return;
  }
  started = true;
  await nativeListen<WatchedFile>("watch-file", (file) => enqueue([file]));
  enqueue(await watchedScan());
}

/** Rescans every watched folder now; used right after adding one. */
export async function syncWatchedNow(): Promise<void> {
  if (!nativeShell()) {
    return;
  }
  enqueue(await watchedScan());
}
