/**
 * Parses raw email in a worker, started on first use and shut down when
 * idle. Every parse has a deadline: a message that never finishes parsing
 * fails on its own, and the worker is replaced, so one bad message cannot
 * hold an import forever.
 */

import type { Email } from "postal-mime";

/** A parsed message, as postal-mime returns it. */
export type ParsedMessage = Email;

const IDLE_SHUTDOWN_MS = 30_000;
const PARSE_DEADLINE_MS = 60_000;

let worker: Worker | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let nextId = 1;
const pending = new Map<
  number,
  { resolve: (email: ParsedMessage) => void; reject: (error: Error) => void }
>();

function failAll(reason: string): void {
  for (const waiter of pending.values()) {
    waiter.reject(new Error(reason));
  }
  pending.clear();
}

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL("../workers/mime.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent<{ id: number; email?: ParsedMessage; error?: string }>) => {
      const { id, email, error } = event.data;
      const waiter = pending.get(id);
      pending.delete(id);
      if (!waiter) {
        return;
      }
      if (email) {
        waiter.resolve(email);
      } else {
        waiter.reject(new Error(error ?? "The message could not be read"));
      }
    };
    worker.onerror = () => {
      worker?.terminate();
      worker = null;
      failAll("The message reader stopped");
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

/**
 * Parses one raw message. The bytes are copied to the worker, so the caller
 * keeps its buffer. Where workers do not exist (tests, old engines), the
 * parse runs in place.
 */
export async function parseMessage(raw: Uint8Array): Promise<ParsedMessage> {
  if (typeof Worker === "undefined") {
    const { parseRaw } = await import("../workers/mime.worker");
    return parseRaw(raw);
  }
  const id = nextId++;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = new Promise<ParsedMessage>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    timer = setTimeout(() => {
      // A parse that never ends: replace the worker so the next one starts
      // clean, and fail whatever was waiting on this one.
      worker?.terminate();
      worker = null;
      failAll("Reading the message took too long");
    }, PARSE_DEADLINE_MS);
  });
  getWorker().postMessage({ id, raw });
  return result.finally(() => {
    clearTimeout(timer);
    scheduleShutdown();
  });
}
