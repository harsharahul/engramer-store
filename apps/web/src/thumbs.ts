import { diag } from "./diag";
import { downloadThumbnail, retryDelay, whenOnline } from "./transfer";

/**
 * Decrypted thumbnail object URLs, cached outside React state so a grid
 * re-render never refetches. Cleared wholesale on logout. Fetches funnel
 * through a small concurrency gate: a large folder must trickle its
 * thumbnails politely instead of firing hundreds of requests at once.
 *
 * Failures are never pinned: a fetch retries with backoff while the tab
 * is online, and if it still comes up empty the cache entry is dropped so
 * the next look starts over. A long-lived page (the desktop shell keeps
 * one alive for days) must survive a deploy blip or a dropped wifi beat
 * without cards stuck on their placeholders for the whole session.
 */
const cache = new Map<string, Promise<string | null>>();

const MAX_CONCURRENT = 6;
const MAX_ATTEMPTS = 4;
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

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function fetchThumbnail(fileId: string, fileKey: Uint8Array): Promise<string | null> {
  for (let attempt = 1; ; attempt++) {
    await whenOnline();
    await acquire();
    try {
      const bytes = await downloadThumbnail(fileId, fileKey);
      return URL.createObjectURL(new Blob([bytes.slice().buffer as ArrayBuffer]));
    } catch (err) {
      if (attempt >= MAX_ATTEMPTS) {
        diag("thumb", `${fileId.slice(0, 8)} giving up after ${attempt} attempts: ${describe(err)}`);
        return null;
      }
      diag("thumb", `${fileId.slice(0, 8)} attempt ${attempt} failed; retrying: ${describe(err)}`);
    } finally {
      release();
    }
    await new Promise((resolve) => setTimeout(resolve, retryDelay(attempt)));
  }
}

export function thumbnailUrl(fileId: string, fileKey: Uint8Array): Promise<string | null> {
  let entry = cache.get(fileId);
  if (!entry) {
    entry = fetchThumbnail(fileId, fileKey).then((url) => {
      if (url === null) {
        cache.delete(fileId);
      }
      return url;
    });
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
