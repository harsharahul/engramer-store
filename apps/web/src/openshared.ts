import { diag } from "./diag";
import { openWithFreshEntry } from "./freshen";
import { useStore, type FileEntry } from "./store";

let inFlight: Promise<void> | null = null;

/**
 * One library refresh at a time, shared by every caller that only needs
 * "a refresh completed after I asked". Several surfaces can trip over
 * the same moved digest in the same instant (a preview, the editor, a
 * background sweep); each deserves fresh rows, none deserves its own
 * /api/sync. Never rejects: a failed sync leaves the library as it was,
 * and the caller's own failure is the one that should surface.
 */
export function refreshLibraryOnce(): Promise<void> {
  if (!inFlight) {
    inFlight = useStore
      .getState()
      .refresh()
      .catch(() => undefined)
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}

/**
 * Opens a file's verified content with the stale-shared-entry healing
 * every open path needs: on an integrity refusal for a shared file,
 * refresh the library and retry against the updated entry (paced, twice;
 * semantics in openWithFreshEntry). Unshared files and real corruption
 * fail exactly as before.
 */
export function openSharedContent<T>(
  entry: FileEntry,
  open: (entry: FileEntry) => Promise<T>,
): Promise<T> {
  return openWithFreshEntry(entry, open, async () => {
    diag("integrity", "shared entry may be stale; refreshing the library");
    await refreshLibraryOnce();
    return useStore.getState().files.get(entry.id) ?? null;
  });
}
