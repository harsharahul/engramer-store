import { IntegrityError } from "./transfer";

/**
 * How a stale-entry retry behaves: how long to wait before each refresh
 * and retry, and how to wait (injectable for tests). One delay per retry.
 */
export interface FreshenOptions {
  delaysMs?: number[];
  wait?: (ms: number) => Promise<void>;
}

const DEFAULT_DELAYS_MS = [250, 750];

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Opens content verified against a cached entry, retrying with a fresh
 * entry when the cache is the thing that is wrong.
 *
 * A shared file's entry can be older than its blob: a co-editor's save
 * moves the content and its digest while this client's poll is still
 * pending, and every retry against the cached expectation refuses good
 * bytes. Refreshing and retrying separates "my copy of the row is old"
 * from real corruption, which still fails exactly as before.
 *
 * Two retries with a short pause before each, because a save writes the
 * bytes and the digest as two requests: a reader landing between them
 * refreshes into an entry that still carries the old digest, and only a
 * moment's patience lets the digest patch land. The pause comes BEFORE
 * the refresh so the refresh fetches the settled row, not the gap.
 *
 * Only shared files take the retry: nobody else can move an unshared
 * file's digest, so there a mismatch means the data, not the cache.
 * When every retry still refuses, the ORIGINAL refusal is what
 * propagates; a non-integrity failure mid-retry propagates as itself.
 */
export async function openWithFreshEntry<E extends { shared?: boolean }, T>(
  entry: E,
  open: (entry: E) => Promise<T>,
  freshen: () => Promise<E | null>,
  options: FreshenOptions = {},
): Promise<T> {
  const delays = options.delaysMs ?? DEFAULT_DELAYS_MS;
  const wait = options.wait ?? sleep;
  try {
    return await open(entry);
  } catch (error) {
    if (!(error instanceof IntegrityError) || !entry.shared) {
      throw error;
    }
    for (const delay of delays) {
      await wait(delay);
      const fresh = await freshen();
      if (!fresh) {
        throw error;
      }
      try {
        return await open(fresh);
      } catch (retryError) {
        if (!(retryError instanceof IntegrityError)) {
          throw retryError;
        }
      }
    }
    throw error;
  }
}
