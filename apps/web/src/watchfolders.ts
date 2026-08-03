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
import { diag } from "./diag";

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
  // Nothing may be judged new until the library it is judged against exists.
  // The shell reloads its window on refresh, and the startup scan runs the
  // moment the vault mounts, well before the first sync returns; an empty
  // library makes every watched file look unseen and uploads it again. The
  // files stay queued rather than being dropped.
  if (!useStore.getState().synced) {
    diag("watch", "waiting for the library before deciding what is new");
    schedule(5_000);
    return;
  }
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
    if (batch.length > 0) {
      diag("watch", `${batch.length} file(s) seen, all already in the vault`);
    }
    return;
  }
  diag("watch", `uploading ${fresh.length} new file(s) from watched folders`);
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
      } catch (err) {
        // Unreadable now (moved, permissions); a later event retries it.
        diag("watch", `could not read ${file.name}: ${err instanceof Error ? err.message : "unknown"}`);
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

function schedule(delay: number): void {
  if (pending.size === 0 || drainTimer !== null) {
    return;
  }
  drainTimer = setTimeout(() => {
    drainTimer = null;
    void drain();
  }, delay);
}

function enqueue(files: WatchedFile[]): void {
  for (const file of files) {
    pending.set(file.path, file);
  }
  // A short quiet period batches a burst of files into one upload wave.
  schedule(2_000);
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
  await nativeListen<WatchedFile>("watch-file", (file) => {
    diag("watch", `settled: ${file.name} (${file.size} bytes)`);
    enqueue([file]);
  });
  const found = await watchedScan();
  diag("watch", `startup scan found ${found.length} file(s) in watched folders`);
  enqueue(found);
}

/** Rescans every watched folder now; used right after adding one. */
export async function syncWatchedNow(): Promise<void> {
  if (!nativeShell()) {
    return;
  }
  const found = await watchedScan();
  diag(
    "watch",
    found.length === 0
      ? "scan found 0 files; if the folder is not empty, macOS may be blocking access (System Settings > Privacy & Security > Files and Folders)"
      : `scan found ${found.length} file(s)`,
  );
  enqueue(found);
}
