/// <reference lib="webworker" />
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";
import { clientsClaim } from "workbox-core";
import {
  ready,
  isChunkedFormat,
  readChunkedHeader,
  chunkSpanForRange,
  decryptChunkRange,
  CHUNKED_CHUNK_SIZE,
  StreamDecryptor,
  streamHeaderBytes,
  streamOverheadBytes,
  type ChunkedHeader,
} from "@engramer/crypto";
import { ContinuationPool } from "./swpool";

declare let self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Parameters<typeof precacheAndRoute>[0];
};

/**
 * App-shell precache (unchanged policy: ciphertext and API responses are
 * never cached) plus the media bridge: /media/<fileId> serves DECRYPTED
 * video and audio straight to the media element. Chunked blobs answer real
 * byte-range requests by decrypting only the chunks touched, so playback
 * starts instantly and seeks anywhere; legacy stream blobs decrypt
 * progressively from the start. Keys arrive from the page by message, live
 * only in this worker's memory, and die with it.
 */

void self.skipWaiting();
clientsClaim();
cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);
registerRoute(
  new NavigationRoute(createHandlerBoundToURL("index.html"), {
    denylist: [/^\/api\//, /^\/media\//],
  }),
);

interface MediaEntry {
  key: Uint8Array;
  token: string;
  mime: string;
  /** Plaintext length, from the file's decrypted metadata. */
  plainSize: number;
}

const media = new Map<string, MediaEntry>();
const keyWaiters = new Map<string, Array<(entry: MediaEntry | null) => void>>();

self.addEventListener("message", (event) => {
  const data = event.data as
    | { type: "media-key"; fileId: string; key: ArrayBuffer; token: string; mime: string; size: number }
    | undefined;
  if (!data || data.type !== "media-key") {
    return;
  }
  const entry: MediaEntry = {
    key: new Uint8Array(data.key),
    token: data.token,
    mime: data.mime,
    plainSize: data.size,
  };
  media.set(data.fileId, entry);
  for (const resolve of keyWaiters.get(data.fileId) ?? []) {
    resolve(entry);
  }
  keyWaiters.delete(data.fileId);
});

/** After a worker restart the map is empty; ask the open pages for the key. */
async function requestEntry(fileId: string): Promise<MediaEntry | null> {
  const existing = media.get(fileId);
  if (existing) {
    return existing;
  }
  const clients = await self.clients.matchAll({ type: "window" });
  if (clients.length === 0) {
    return null;
  }
  const waited = new Promise<MediaEntry | null>((resolve) => {
    const waiters = keyWaiters.get(fileId) ?? [];
    waiters.push(resolve);
    keyWaiters.set(fileId, waiters);
    setTimeout(() => resolve(media.get(fileId) ?? null), 3000);
  });
  for (const client of clients) {
    client.postMessage({ type: "media-key-request", fileId });
  }
  return waited;
}

function parseRangeHeader(header: string | null, size: number): { start: number; end: number } | null {
  if (!header) {
    return null;
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === "" && match[2] === "")) {
    return null;
  }
  if (match[1] === "") {
    const suffix = Math.min(Number(match[2]), size);
    return suffix === 0 ? null : { start: size - suffix, end: size - 1 };
  }
  const start = Number(match[1]);
  const end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
  return start >= size || start > end ? null : { start, end };
}

async function fetchCiphertext(
  fileId: string,
  entry: MediaEntry,
  range?: { start: number; end: number },
) {
  const response = await fetch(`/api/files/${fileId}/data`, {
    headers: {
      authorization: `Bearer ${entry.token}`,
      ...(range ? { range: `bytes=${range.start}-${range.end}` } : {}),
    },
  });
  if (!(response.status === 206 || response.status === 200) || !response.body) {
    throw new Error(`ciphertext fetch failed (${response.status})`);
  }
  return response.body;
}

/** One decrypted piece at a time, produced only when the player pulls. */
interface PlainSource {
  next(): Promise<Uint8Array | null>;
  cancel(): void;
}

/**
 * Backpressured bridge stream: nothing is fetched or decrypted until the
 * media element drains its queue and pulls again, so memory holds a couple
 * of chunks no matter how large the file. A cancelled response (a seek, a
 * closed player) releases the underlying ciphertext fetch immediately.
 */
function pulledBody(open: () => Promise<PlainSource>): ReadableStream<Uint8Array> {
  let source: PlainSource | null = null;
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          source = source ?? (await open());
          const piece = await source.next();
          if (piece === null) {
            controller.close();
            return;
          }
          controller.enqueue(piece);
        } catch (err) {
          source?.cancel();
          controller.error(err);
        }
      },
      cancel() {
        source?.cancel();
      },
    },
    // Measured in enqueued pieces: keep at most ~2 chunks ready.
    new CountQueuingStrategy({ highWaterMark: 2 }),
  );
}

/** Reads exact-length frames from a byte stream, one call at a time. */
function frameReader(reader: ReadableStreamDefaultReader<Uint8Array>) {
  let buffer = new Uint8Array(0);
  let ended = false;
  return {
    async take(length: number): Promise<Uint8Array | null> {
      while (buffer.length < length && !ended) {
        const { done, value } = await reader.read();
        if (done) {
          ended = true;
          break;
        }
        const merged = new Uint8Array(buffer.length + value.length);
        merged.set(buffer, 0);
        merged.set(value, buffer.length);
        buffer = merged;
      }
      if (buffer.length === 0) {
        return null;
      }
      const take = Math.min(length, buffer.length);
      const frame = buffer.slice(0, take);
      buffer = buffer.slice(take);
      return frame;
    },
  };
}

/**
 * Upstream continuation pool. Media engines consume a stream in many
 * short-lived range requests; opening a fresh ciphertext fetch for each
 * one pays a full round trip per cycle, and against a rate-limited object
 * store the flood itself becomes the stall. A finished or cancelled
 * request parks its upstream reader; a later request resumes the best
 * positional match: exactly where a reader stopped, inside one of the few
 * chunks it decrypted last (WebKit's ranges are rarely chunk-aligned and
 * land a little behind a reader that ran ahead of the engine's commit
 * point), or a few chunks ahead, discarding the gap from the wire.
 *
 * The wire itself travels in bounded windows that renew inside the same
 * session, the shape the native desktop player uses. WebKit's network
 * layer drains a response ahead of consumption without regard for stream
 * backpressure, so an abandoned open-ended fetch would slurp until the
 * blob ends; an abandoned window costs at most the window.
 */
interface UpstreamSession {
  frames: ReturnType<typeof frameReader> | null;
  cancelUpstream: () => void;
  /** The next chunk index this reader will yield. */
  nextChunk: number;
  /** First chunk past the current wire window; reads renew from there. */
  windowEnd: number;
  /** Recently decrypted chunks, newest last, consecutive up to nextChunk. */
  ring: Array<{ index: number; plain: Uint8Array }>;
  /** Serializes takers so a reader is never consumed twice. */
  queue: Promise<unknown>;
}

const PARK_TTL_MS = 20_000;
const PARK_MAX_SESSIONS = 3;
const SKIP_AHEAD_CHUNKS = 4;
const RING_CHUNKS = 3;
// The native desktop player's read-ahead shape: 8 chunks (32 MiB) per
// request keeps a full play at a few dozen upstream requests while an
// abandoned connection wastes at most one window of transfer.
const WINDOW_CHUNKS = 8;
// Ranged answers stop at a chunk boundary after this many chunks (16 MiB,
// the native player's bounded-answer size); one upstream window feeds two.
const ANSWER_CHUNKS = 4;

const upstreamPool = new ContinuationPool<UpstreamSession>(
  PARK_MAX_SESSIONS,
  PARK_TTL_MS,
  SKIP_AHEAD_CHUNKS,
  (session) => session.cancelUpstream(),
);

function chunkCount(header: ChunkedHeader): number {
  return header.plainSize === 0 ? 1 : Math.ceil(header.plainSize / CHUNKED_CHUNK_SIZE);
}

function chunkPlainLength(header: ChunkedHeader, index: number): number {
  const total = chunkCount(header);
  return index < total - 1 ? CHUNKED_CHUNK_SIZE : header.plainSize - (total - 1) * CHUNKED_CHUNK_SIZE;
}

/** Tells the open pages when an upstream fetch opens or resumes, for the
 * activity log; a healthy playback opens sparsely and resumes quietly. */
async function notifyUpstream(
  fileId: string,
  chunk: number,
  kind: "opened" | "renewed" | "resumed",
): Promise<void> {
  for (const client of await self.clients.matchAll({ type: "window" })) {
    client.postMessage({ type: "media-upstream", fileId, chunk, kind });
  }
}

async function openWindow(
  fileId: string,
  entry: MediaEntry,
  header: ChunkedHeader,
  firstChunk: number,
  kind: "opened" | "renewed",
): Promise<{ frames: ReturnType<typeof frameReader>; cancel: () => void; windowEnd: number }> {
  const plainEnd = Math.min(
    Math.max(0, header.plainSize - 1),
    (firstChunk + WINDOW_CHUNKS) * CHUNKED_CHUNK_SIZE - 1,
  );
  const span = chunkSpanForRange(header, firstChunk * CHUNKED_CHUNK_SIZE, plainEnd);
  const body = await fetchCiphertext(fileId, entry, {
    start: span.ciphertextStart,
    end: span.ciphertextEnd,
  });
  void notifyUpstream(fileId, firstChunk, kind);
  const reader = body.getReader();
  return {
    frames: frameReader(reader),
    cancel: () => void reader.cancel().catch(() => {}),
    windowEnd: span.lastChunk + 1,
  };
}

/** The next sealed chunk from the session's wire, renewing the window. */
async function takeSealed(
  fileId: string,
  entry: MediaEntry,
  header: ChunkedHeader,
  session: UpstreamSession,
): Promise<Uint8Array | null> {
  if (session.nextChunk >= chunkCount(header)) {
    return null;
  }
  if (session.frames === null || session.nextChunk >= session.windowEnd) {
    session.cancelUpstream();
    const window = await openWindow(fileId, entry, header, session.nextChunk, "renewed");
    session.frames = window.frames;
    session.cancelUpstream = window.cancel;
    session.windowEnd = window.windowEnd;
  }
  return session.frames.take(chunkPlainLength(header, session.nextChunk) + 16);
}

async function acquireSession(
  fileId: string,
  entry: MediaEntry,
  header: ChunkedHeader,
  firstChunk: number,
): Promise<UpstreamSession> {
  const claimed = upstreamPool.claim(fileId, firstChunk);
  if (claimed) {
    if (claimed.nextChunk >= firstChunk) {
      // Exact continuation, or re-entry into a ring-held chunk.
      void notifyUpstream(fileId, firstChunk, "resumed");
      return claimed;
    }
    // A reader a few chunks short discards the gap from bytes already in
    // flight; cheaper than a round trip, but only within its own window.
    while (claimed.nextChunk < firstChunk && claimed.frames !== null && claimed.nextChunk < claimed.windowEnd) {
      const sealedLen = chunkPlainLength(header, claimed.nextChunk) + 16;
      const skipped = await claimed.frames.take(sealedLen);
      if (skipped === null || skipped.length < sealedLen) {
        break;
      }
      claimed.nextChunk += 1;
      claimed.ring = [];
    }
    if (claimed.nextChunk === firstChunk) {
      void notifyUpstream(fileId, firstChunk, "resumed");
      return claimed;
    }
    claimed.cancelUpstream(); // the gap outran the window; fetch fresh
  }
  const window = await openWindow(fileId, entry, header, firstChunk, "opened");
  return {
    frames: window.frames,
    cancelUpstream: window.cancel,
    nextChunk: firstChunk,
    windowEnd: window.windowEnd,
    ring: [],
    queue: Promise.resolve(),
  };
}

/** Serves a plaintext range of a chunked blob, decrypting only its chunks. */
function chunkedResponse(
  fileId: string,
  entry: MediaEntry,
  header: ChunkedHeader,
  start: number,
  end: number,
  partial: boolean,
): Response {
  const span = chunkSpanForRange(header, start, end);

  const stream = pulledBody(async () => {
    const session = await acquireSession(fileId, entry, header, span.firstChunk);
    // The response's own position; it trails session.nextChunk by one only
    // while serving out of the retained chunk.
    let cursor = span.firstChunk;
    let finished = false;
    const exclusive = <T>(op: () => Promise<T>): Promise<T> => {
      const run = session.queue.then(op, op);
      session.queue = run.catch(() => {});
      return run;
    };
    return {
      next: () =>
        exclusive(async () => {
          if (cursor > span.lastChunk) {
            finished = true;
            upstreamPool.park(fileId, session);
            return null;
          }
          const index = cursor;
          let plain: Uint8Array;
          const held = session.ring.find((kept) => kept.index === index);
          if (held) {
            plain = held.plain;
          } else if (index === session.nextChunk) {
            const sealed = await takeSealed(fileId, entry, header, session);
            // A short frame is a connection that died mid-chunk, not data.
            if (sealed === null || sealed.length < chunkPlainLength(header, index) + 16) {
              finished = true;
              session.cancelUpstream();
              return null;
            }
            session.nextChunk = index + 1;
            plain = decryptChunkRange(header, entry.key, sealed, {
              firstChunk: index,
              lastChunk: index,
              ciphertextStart: 0,
              ciphertextEnd: sealed.length - 1,
              plainStart: index * CHUNKED_CHUNK_SIZE,
            });
            session.ring.push({ index, plain });
            if (session.ring.length > RING_CHUNKS) {
              session.ring.shift();
            }
          } else {
            // The cursor fell between an evicted ring chunk and the wire
            // position; should not happen, but a defensive close beats
            // serving bytes from the wrong offset.
            finished = true;
            session.cancelUpstream();
            return null;
          }
          cursor = index + 1;
          const chunkStart = index * CHUNKED_CHUNK_SIZE;
          const chunkEnd = chunkStart + plain.length - 1;
          const from = Math.max(start, chunkStart) - chunkStart;
          const to = Math.min(end, chunkEnd) - chunkStart;
          return to >= from ? plain.subarray(from, to + 1) : new Uint8Array(0);
        }),
      cancel() {
        // A cancelled request is usually the engine about to continue from
        // the same spot; keep the upstream alive for it. exclusive() ensures
        // a pending read settles before anyone else touches the reader.
        void exclusive(async () => {
          if (!finished) {
            upstreamPool.park(fileId, session);
          }
        });
      },
    };
  });

  const headers = new Headers({
    "content-type": entry.mime,
    "accept-ranges": "bytes",
    "content-length": String(end - start + 1),
  });
  if (partial) {
    headers.set("content-range", `bytes ${start}-${end}/${header.plainSize}`);
  }
  return new Response(stream, { status: partial ? 206 : 200, headers });
}

/**
 * Legacy sequential blobs decrypt progressively from the start, one chunk
 * per pull; no byte-range answers are possible for this format, which is
 * exactly why media now uploads in the chunked one.
 */
function legacyResponse(fileId: string, entry: MediaEntry): Response {
  const headerLen = streamHeaderBytes();
  const sealed = CHUNKED_CHUNK_SIZE + streamOverheadBytes();

  const stream = pulledBody(async () => {
    const body = await fetchCiphertext(fileId, entry);
    const reader = body.getReader();
    const frames = frameReader(reader);
    let decryptor: StreamDecryptor | null = null;
    let served = 0;
    return {
      async next() {
        if (!decryptor) {
          const head = await frames.take(headerLen);
          if (head === null || head.length < headerLen) {
            return null;
          }
          decryptor = new StreamDecryptor(entry.key, head);
        }
        const chunk = await frames.take(sealed);
        if (chunk === null) {
          return null;
        }
        const { message } = decryptor.pull(chunk);
        served += message.length;
        void notifyProgress(fileId, served, entry.plainSize);
        return message;
      },
      cancel() {
        void reader.cancel().catch(() => {});
      },
    };
  });

  return new Response(stream, {
    status: 200,
    headers: new Headers({
      "content-type": entry.mime,
      "content-length": String(entry.plainSize),
    }),
  });
}

let progressLast = 0;
async function notifyProgress(fileId: string, loaded: number, total: number): Promise<void> {
  const now = Date.now();
  if (now - progressLast < 400 && loaded < total) {
    return;
  }
  progressLast = now;
  for (const client of await self.clients.matchAll({ type: "window" })) {
    client.postMessage({ type: "media-progress", fileId, loaded, total });
  }
}

// WebKit streams video as many short-lived range requests, several per
// second; re-fetching the immutable 28-byte format header for each one
// adds a full round trip per cycle, which reads as playback hiccups on
// high-latency paths. A short TTL keeps a restored version from being
// served with a stale layout for more than a minute.
const probeCache = new Map<string, { probe: Uint8Array; at: number }>();
const PROBE_TTL_MS = 60_000;
const PROBE_CACHE_MAX = 32;

async function fetchProbe(fileId: string, entry: MediaEntry): Promise<Uint8Array> {
  const cached = probeCache.get(fileId);
  if (cached && Date.now() - cached.at < PROBE_TTL_MS) {
    return cached.probe;
  }
  const body = await fetchCiphertext(fileId, entry, { start: 0, end: 27 });
  const probe = new Uint8Array(await new Response(body).arrayBuffer());
  probeCache.set(fileId, { probe, at: Date.now() });
  if (probeCache.size > PROBE_CACHE_MAX) {
    let oldestKey: string | null = null;
    let oldestAt = Infinity;
    for (const [key, value] of probeCache) {
      if (value.at < oldestAt) {
        oldestAt = value.at;
        oldestKey = key;
      }
    }
    if (oldestKey) {
      probeCache.delete(oldestKey);
    }
  }
  return probe;
}

async function serveMedia(request: Request, fileId: string): Promise<Response> {
  await ready();
  const entry = await requestEntry(fileId);
  if (!entry) {
    return new Response("media key unavailable", { status: 503 });
  }
  // The first 28 bytes identify the format and, for chunked blobs, the size.
  const probe = await fetchProbe(fileId, entry);
  if (isChunkedFormat(probe)) {
    const header = readChunkedHeader(probe);
    const range = parseRangeHeader(request.headers.get("range"), header.plainSize);
    if (request.headers.get("range") && !range) {
      return new Response(null, {
        status: 416,
        headers: { "content-range": `bytes */${header.plainSize}` },
      });
    }
    const start = range?.start ?? 0;
    let end = range?.end ?? header.plainSize - 1;
    if (range) {
      // Answer ranges in bounded windows ending on a chunk boundary, the
      // native desktop player's shape. A finite 206 with an honest
      // content-range makes the engine's next request begin exactly where
      // this answer ends, so continuations align instead of the engine
      // slurping an endless response far past what it commits.
      const cap = (Math.floor(start / CHUNKED_CHUNK_SIZE) + ANSWER_CHUNKS) * CHUNKED_CHUNK_SIZE - 1;
      end = Math.min(end, Math.min(header.plainSize - 1, cap));
    }
    return chunkedResponse(fileId, entry, header, start, end, range !== null);
  }
  return legacyResponse(fileId, entry);
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin === self.location.origin && url.pathname.startsWith("/media/")) {
    const fileId = url.pathname.slice("/media/".length);
    event.respondWith(serveMedia(event.request, fileId));
  }
});
