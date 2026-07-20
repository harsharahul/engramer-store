import { downloadThumbnail } from "./transfer";

/**
 * Decrypted thumbnail object URLs, cached outside React state so a grid
 * re-render never refetches. Cleared wholesale on logout.
 */
const cache = new Map<string, Promise<string | null>>();

export function thumbnailUrl(fileId: string, fileKey: Uint8Array): Promise<string | null> {
  let entry = cache.get(fileId);
  if (!entry) {
    entry = downloadThumbnail(fileId, fileKey)
      .then((bytes) => URL.createObjectURL(new Blob([bytes.slice().buffer as ArrayBuffer])))
      .catch(() => null);
    cache.set(fileId, entry);
  }
  return entry;
}

export function clearThumbnailCache(): void {
  for (const entry of cache.values()) {
    void entry.then((url) => url && URL.revokeObjectURL(url));
  }
  cache.clear();
}
