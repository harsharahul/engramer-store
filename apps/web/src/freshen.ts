import { IntegrityError } from "./transfer";

/**
 * Opens content verified against a cached entry, retrying once with a
 * fresh entry when the cache is the thing that is wrong.
 *
 * A shared file's entry can be older than its blob: a co-editor's save
 * moves the content and its digest while this client's poll is still
 * pending, and every retry against the cached expectation refuses good
 * bytes. One refresh and one retry separates "my copy of the row is
 * old" from real corruption, which still fails exactly as before. Only
 * shared files take the retry: nobody else can move an unshared file's
 * digest, so there a mismatch means the data, not the cache.
 */
export async function openWithFreshEntry<E extends { shared?: boolean }, T>(
  entry: E,
  open: (entry: E) => Promise<T>,
  freshen: () => Promise<E | null>,
): Promise<T> {
  try {
    return await open(entry);
  } catch (error) {
    if (!(error instanceof IntegrityError) || !entry.shared) {
      throw error;
    }
    const fresh = await freshen();
    if (!fresh) {
      throw error;
    }
    return await open(fresh);
  }
}
