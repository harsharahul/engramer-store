import { useEffect, useRef, useState } from "react";
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

/**
 * The lazy-thumbnail pattern every tile shares: nothing is fetched until
 * the element approaches the viewport, and until then the caller shows its
 * ThumbHash placeholder. Attach the returned ref to the tile's element.
 */
export function usePhotoThumb<E extends HTMLElement>(file: {
  id: string;
  key: Uint8Array;
  hasThumb: boolean;
}): { ref: React.RefObject<E | null>; thumb: string | null } {
  const ref = useRef<E>(null);
  const [thumb, setThumb] = useState<string | null>(null);

  useEffect(() => {
    setThumb(null);
    if (!file.hasThumb || !ref.current) {
      return;
    }
    let cancelled = false;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          observer.disconnect();
          void thumbnailUrl(file.id, file.key).then((url) => {
            if (!cancelled) {
              setThumb(url);
            }
          });
        }
      },
      { rootMargin: "400px" },
    );
    observer.observe(ref.current);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [file.id, file.hasThumb, file.key]);

  return { ref, thumb };
}

export function clearThumbnailCache(): void {
  for (const entry of cache.values()) {
    void entry.then((url) => url && URL.revokeObjectURL(url));
  }
  cache.clear();
}
