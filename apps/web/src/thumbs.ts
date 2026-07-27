import { downloadThumbnail } from "./transfer";

/**
 * Decrypted thumbnail object URLs, cached outside React state so a grid
 * re-render never refetches. Cleared wholesale on logout. Fetches funnel
 * through a small concurrency gate: a large folder must trickle its
 * thumbnails politely instead of firing hundreds of requests at once.
 */
const cache = new Map<string, Promise<string | null>>();

const MAX_CONCURRENT = 6;
let active = 0;
const waiters: Array<() => void> = [];

async function acquire(): Promise<void> {
  if (active < MAX_CONCURRENT) {
    active++;
    return;
  }
  await new Promise<void>((resolve) => waiters.push(resolve));
  active++;
}

function release(): void {
  active--;
  waiters.shift()?.();
}

export function thumbnailUrl(fileId: string, fileKey: Uint8Array): Promise<string | null> {
  let entry = cache.get(fileId);
  if (!entry) {
    entry = (async () => {
      await acquire();
      try {
        const bytes = await downloadThumbnail(fileId, fileKey);
        return URL.createObjectURL(new Blob([bytes.slice().buffer as ArrayBuffer]));
      } catch {
        return null;
      } finally {
        release();
      }
    })();
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
