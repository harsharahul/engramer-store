/**
 * Offline access, the way a drive app keeps promises: pin a file and the
 * shell downloads whatever it does not already hold, verifies the whole
 * thing decrypts, and never evicts it; everything unpinned is cache,
 * kept while space allows. This module holds the decisions; the store
 * calls them and keeps the state.
 */

import {
  nativeListen,
  nativeOfflinePin,
  nativeOfflineRemove,
  type NativeOfflineEntry,
} from "./native";
import { beginSave, endSave, updateSave } from "./saveprogress";

/** What the shell's pin-progress events carry: ciphertext bytes landed. */
interface PinEvent {
  fileId: string;
  done: number;
  total: number | null;
}

/**
 * Pins one file, narrating the shell's fill through the shared save
 * record so the same overlay that tells export stories tells this one.
 * False when the shell cannot (old build, no space, offline); the
 * caller reports it and nothing breaks.
 */
export async function pinFileOffline(
  file: { id: string; name: string; key: Uint8Array; digest?: string },
  token: string,
): Promise<boolean> {
  beginSave(file.id, file.name);
  const stop = await nativeListen<PinEvent>("pin-progress", (event) => {
    if (event.fileId === file.id) {
      updateSave(file.id, "download", event.done, event.total ?? null);
    }
  });
  try {
    return await nativeOfflinePin(
      { id: file.id, key: file.key, ...(file.digest ? { digest: file.digest } : {}) },
      token,
    );
  } finally {
    stop();
    endSave(file.id);
  }
}

/**
 * Whether a just-synced row made the shell's copy stale: the row
 * replaced one this client already had, and its content digest moved.
 * A first appearance has nothing local to go stale.
 */
export function offlineStale(
  before: { digest?: string } | undefined,
  after: { digest?: string },
): boolean {
  return before !== undefined && before.digest !== after.digest;
}

/**
 * Drops the stale copies the shell actually holds and re-pins the ones
 * that carried a promise: a pin means "keep this file", and the file is
 * now its newer self. Cached-only copies just go; the next open warms
 * them again.
 */
export async function invalidateStaleOffline(
  staleIds: string[],
  entries: NativeOfflineEntry[],
  repin: (fileId: string) => Promise<void>,
): Promise<void> {
  const held = new Map(entries.map((entry) => [entry.fileId, entry]));
  for (const fileId of staleIds) {
    const entry = held.get(fileId);
    if (!entry) {
      continue;
    }
    await nativeOfflineRemove(fileId);
    if (entry.pinned) {
      await repin(fileId);
    }
  }
}
