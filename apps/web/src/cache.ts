import type { FileDto, FolderDto, SharedFileDto, SyncResponse } from "./api";

/**
 * Persisted library cache: the sync rows exactly as the server sent them,
 * stored verbatim in IndexedDB. Every row is ciphertext plus the structure
 * the server already sees (ids, sizes, timestamps, tree shape), so caching
 * adds no crypto layer and reveals nothing the server does not know. On the
 * next visit the library hydrates from here instantly and a single
 * sync?since=<seq> request brings in only what changed.
 *
 * Every operation is best-effort: the cache is an optimization, and any
 * failure (private browsing, storage pressure, schema change) falls back to
 * a full sync from the server, which remains the source of truth.
 */

export interface CachedLibrary {
  seq: number;
  folders: FolderDto[];
  files: FileDto[];
  shared: SharedFileDto[];
}

const DB_PREFIX = "engramer-cache:";
// v2 added the shared store; the bump wipes and the server refills.
const DB_VERSION = 2;
const STORES = ["folders", "files", "shared", "meta"] as const;

function openDb(account: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("indexeddb unavailable"));
      return;
    }
    const request = indexedDB.open(DB_PREFIX + account, DB_VERSION);
    request.onupgradeneeded = () => {
      // A schema change starts the cache over; the server refills it.
      const db = request.result;
      for (const name of [...db.objectStoreNames]) {
        db.deleteObjectStore(name);
      }
      db.createObjectStore("folders", { keyPath: "id" });
      db.createObjectStore("files", { keyPath: "id" });
      db.createObjectStore("shared", { keyPath: "id" });
      db.createObjectStore("meta");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("indexeddb open failed"));
    request.onblocked = () => reject(new Error("indexeddb blocked"));
  });
}

function settled(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("indexeddb transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("indexeddb transaction aborted"));
  });
}

/** The library as of the last completed sync, or null when nothing usable is cached. */
export async function loadCache(account: string): Promise<CachedLibrary | null> {
  try {
    const db = await openDb(account);
    try {
      const tx = db.transaction(STORES, "readonly");
      const seqRequest = tx.objectStore("meta").get("seq");
      const folderRequest = tx.objectStore("folders").getAll();
      const fileRequest = tx.objectStore("files").getAll();
      const sharedRequest = tx.objectStore("shared").getAll();
      await settled(tx);
      const seq = seqRequest.result as unknown;
      if (typeof seq !== "number" || seq <= 0) {
        return null;
      }
      return {
        seq,
        folders: folderRequest.result as FolderDto[],
        files: fileRequest.result as FileDto[],
        shared: sharedRequest.result as SharedFileDto[],
      };
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/**
 * Folds one sync response into the cache: live rows are upserted, tombstones
 * remove their row for good, and the cursor advances. A row is only replaced
 * by a strictly newer updateSeq, so two tabs syncing at once can never roll a
 * row back no matter how their writes interleave. With rebuild set, the
 * stores are cleared first so a full sync leaves an exact mirror.
 */
export async function storeSyncRows(
  account: string,
  response: SyncResponse,
  rebuild = false,
): Promise<void> {
  try {
    const db = await openDb(account);
    try {
      const tx = db.transaction(STORES, "readwrite");
      if (rebuild) {
        tx.objectStore("folders").clear();
        tx.objectStore("files").clear();
        tx.objectStore("shared").clear();
      }
      upsert(tx.objectStore("folders"), response.folders);
      upsert(tx.objectStore("files"), response.files);
      upsertShared(tx.objectStore("shared"), response.shared ?? []);
      const meta = tx.objectStore("meta");
      const current = meta.get("seq");
      current.onsuccess = () => {
        const prior =
          !rebuild && typeof current.result === "number" ? (current.result as number) : 0;
        meta.put(Math.max(prior, response.seq), "seq");
      };
      await settled(tx);
    } finally {
      db.close();
    }
  } catch {
    // The cache simply stays behind; the next sync covers the gap.
  }
}

function upsert(store: IDBObjectStore, rows: Array<FolderDto | FileDto>): void {
  for (const row of rows) {
    if (row.deleted) {
      store.delete(row.id);
      continue;
    }
    const existing = store.get(row.id);
    existing.onsuccess = () => {
      const prior = existing.result as { updateSeq?: number } | undefined;
      if (!prior || typeof prior.updateSeq !== "number" || prior.updateSeq < row.updateSeq) {
        store.put(row);
      }
    };
  }
}

/** Same newest-wins upsert; a shared row's tombstone flag is `revoked`. */
function upsertShared(store: IDBObjectStore, rows: SharedFileDto[]): void {
  for (const row of rows) {
    if (row.revoked) {
      store.delete(row.id);
      continue;
    }
    const existing = store.get(row.id);
    existing.onsuccess = () => {
      const prior = existing.result as { updateSeq?: number } | undefined;
      if (!prior || typeof prior.updateSeq !== "number" || prior.updateSeq < row.updateSeq) {
        store.put(row);
      }
    };
  }
}

/** Removes the account's cache entirely; used on sign-out. */
export function clearCache(account: string): Promise<void> {
  return new Promise((resolve) => {
    if (typeof indexedDB === "undefined") {
      resolve();
      return;
    }
    const request = indexedDB.deleteDatabase(DB_PREFIX + account);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
}
