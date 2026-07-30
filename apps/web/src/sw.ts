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

/** Re-frames an arbitrary byte stream into exact sealed-chunk sized pieces. */
function chunkFramer(sealedSizes: number[], onChunk: (bytes: Uint8Array, index: number) => void) {
  let buffer = new Uint8Array(0);
  let chunkIndex = 0;
  return {
    push(incoming: Uint8Array) {
      const merged = new Uint8Array(buffer.length + incoming.length);
      merged.set(buffer, 0);
      merged.set(incoming, buffer.length);
      buffer = merged;
      while (chunkIndex < sealedSizes.length && buffer.length >= sealedSizes[chunkIndex]!) {
        const take = sealedSizes[chunkIndex]!;
        onChunk(buffer.slice(0, take), chunkIndex);
        buffer = buffer.slice(take);
        chunkIndex++;
      }
    },
    done(): boolean {
      return chunkIndex >= sealedSizes.length;
    },
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
  const chunkTotal = header.plainSize === 0 ? 1 : Math.ceil(header.plainSize / CHUNKED_CHUNK_SIZE);
  const sealedSizes: number[] = [];
  for (let i = span.firstChunk; i <= span.lastChunk; i++) {
    const plainLen =
      i < chunkTotal - 1
        ? CHUNKED_CHUNK_SIZE
        : header.plainSize - (chunkTotal - 1) * CHUNKED_CHUNK_SIZE;
    sealedSizes.push((i < chunkTotal - 1 ? CHUNKED_CHUNK_SIZE : plainLen) + 16);
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const body = await fetchCiphertext(fileId, entry, {
          start: span.ciphertextStart,
          end: span.ciphertextEnd,
        });
        const reader = body.getReader();
        let plainOffset = span.plainStart;
        const framer = chunkFramer(sealedSizes, (chunkBytes, i) => {
          const index = span.firstChunk + i;
          let plain = decryptChunkRange(header, entry.key, chunkBytes, {
            firstChunk: index,
            lastChunk: index,
            ciphertextStart: 0,
            ciphertextEnd: chunkBytes.length - 1,
            plainStart: index * CHUNKED_CHUNK_SIZE,
          });
          const chunkStart = plainOffset;
          const chunkEnd = chunkStart + plain.length - 1;
          const from = Math.max(start, chunkStart) - chunkStart;
          const to = Math.min(end, chunkEnd) - chunkStart;
          if (to >= from) {
            plain = plain.subarray(from, to + 1);
            controller.enqueue(plain);
          }
          plainOffset = chunkEnd + 1;
        });
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          framer.push(value);
          if (framer.done()) {
            break;
          }
        }
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
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
 * Legacy sequential blobs decrypt progressively from the start: the whole
 * ciphertext streams in, chunks decrypt as they complete, and plaintext
 * leaves immediately, so playback begins long before the download ends.
 * No byte-range answers are possible for this format, which is exactly why
 * media now uploads in the chunked one.
 */
function legacyResponse(fileId: string, entry: MediaEntry): Response {
  const headerLen = streamHeaderBytes();
  const sealed = CHUNKED_CHUNK_SIZE + streamOverheadBytes();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const body = await fetchCiphertext(fileId, entry);
        const reader = body.getReader();
        let decryptor: StreamDecryptor | null = null;
        let buffer = new Uint8Array(0);
        let served = 0;
        const append = (incoming: Uint8Array) => {
          const merged = new Uint8Array(buffer.length + incoming.length);
          merged.set(buffer, 0);
          merged.set(incoming, buffer.length);
          buffer = merged;
        };
        const emit = (chunk: Uint8Array) => {
          const { message } = decryptor!.pull(chunk);
          controller.enqueue(message);
          served += message.length;
          void notifyProgress(fileId, served, entry.plainSize);
        };
        for (;;) {
          const { done, value } = await reader.read();
          if (value) {
            append(value);
          }
          if (!decryptor && buffer.length >= headerLen) {
            decryptor = new StreamDecryptor(entry.key, buffer.slice(0, headerLen));
            buffer = buffer.slice(headerLen);
          }
          while (decryptor && buffer.length >= sealed) {
            emit(buffer.slice(0, sealed));
            buffer = buffer.slice(sealed);
          }
          if (done) {
            // The tail chunk is whatever remains once the source ends.
            if (decryptor && buffer.length > 0) {
              emit(buffer);
            }
            break;
          }
        }
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
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

async function serveMedia(request: Request, fileId: string): Promise<Response> {
  await ready();
  const entry = await requestEntry(fileId);
  if (!entry) {
    return new Response("media key unavailable", { status: 503 });
  }
  // The first 28 bytes identify the format and, for chunked blobs, the size.
  const probeBody = await fetchCiphertext(fileId, entry, { start: 0, end: 27 });
  const probe = new Uint8Array(await new Response(probeBody).arrayBuffer());
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
    const end = range?.end ?? header.plainSize - 1;
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
