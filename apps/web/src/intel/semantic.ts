/**
 * On-device semantic understanding of photos: a small CLIP-family model
 * (MobileCLIP-S0, served from this origin) turns images and queries into
 * vectors whose similarity is meaning, not spelling. Opt-in, lazily
 * loaded, and shut down when idle; embeddings live only inside encrypted
 * index blobs and this device's memory.
 */

const PREF_KEY = "engram-semantic";
const IDLE_SHUTDOWN_MS = 90_000;
const QUERY_CACHE_LIMIT = 32;

export const EMBEDDING_DIM = 512;

export function semanticEnabled(): boolean {
  try {
    return localStorage.getItem(PREF_KEY) === "1";
  } catch {
    return false;
  }
}

export function setSemanticEnabled(on: boolean): void {
  try {
    localStorage.setItem(PREF_KEY, on ? "1" : "0");
  } catch {
    // Preference persistence is best-effort.
  }
}

let worker: Worker | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (v: Float32Array) => void; reject: (e: Error) => void }>();
const queryCache = new Map<string, Float32Array>();

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL("./semantic.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent<{ id: number; embedding?: Float32Array; error?: string }>) => {
      const { id, embedding, error } = event.data;
      const waiter = pending.get(id);
      pending.delete(id);
      if (!waiter) {
        return;
      }
      if (embedding) {
        waiter.resolve(new Float32Array(embedding));
      } else {
        waiter.reject(new Error(error ?? "embedding failed"));
      }
    };
  }
  return worker;
}

function scheduleShutdown(): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
  }
  idleTimer = setTimeout(() => {
    if (pending.size === 0) {
      worker?.terminate();
      worker = null;
    }
  }, IDLE_SHUTDOWN_MS);
}

function request(message: Record<string, unknown>, transfer: Transferable[] = []): Promise<Float32Array> {
  const id = nextId++;
  const result = new Promise<Float32Array>((resolve, reject) => {
    pending.set(id, { resolve, reject });
  });
  getWorker().postMessage({ id, ...message }, transfer);
  return result.finally(scheduleShutdown);
}

/** Embeds one image; undefined when the model cannot make sense of it. */
export async function embedImage(image: Blob): Promise<Float32Array | undefined> {
  try {
    const buffer = await image.arrayBuffer();
    return await request({ kind: "image", image: buffer, mime: image.type }, [buffer]);
  } catch {
    return undefined;
  }
}

/** Embeds a search query; cached, since users type the same things often. */
export async function embedQuery(text: string): Promise<Float32Array | undefined> {
  const key = text.trim().toLowerCase();
  const cached = queryCache.get(key);
  if (cached) {
    return cached;
  }
  try {
    const embedding = await request({ kind: "text", text: key });
    queryCache.set(key, embedding);
    if (queryCache.size > QUERY_CACHE_LIMIT) {
      const oldest = queryCache.keys().next().value;
      if (oldest !== undefined) {
        queryCache.delete(oldest);
      }
    }
    return embedding;
  } catch {
    return undefined;
  }
}

/** Similarity of unit vectors: a plain dot product. */
export function cosine(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    sum += a[i]! * b[i]!;
  }
  return sum;
}
