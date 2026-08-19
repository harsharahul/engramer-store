/**
 * Runtime-typed entity extraction: the travel slice's bridging tier.
 *
 * A small zero-shot extractor takes entity type names at call time and
 * returns spans from the text. A span is a pointer into the document, so
 * this model cannot invent a value; it can only point at words that exist,
 * which is the whole safety architecture in model form. Even so it ranks
 * below the exact tiers: spans are used only to connect documents that
 * share no reference, they are transient, and nothing here is ever stored
 * as a fact.
 *
 * Opt-in like character recognition and meaning search, and quarantined in
 * a worker for dependency reasons the worker explains. The worker is
 * spawned lazily and put away after a quiet minute, because a model this
 * size should not sit in memory on the chance of a second question.
 */

import { diag } from "../diag";
import { settingChanged } from "../settingsbus";

const PREF_KEY = "engram-entities";
const IDLE_SHUTDOWN_MS = 60_000;

export const ENTITY_THRESHOLD = 0.55;
/** What travel bridging asks for; few and focused on purpose. */
export const TRAVEL_LABELS = ["airport", "city", "hotel name", "airline"];

export function entitiesEnabled(): boolean {
  try {
    return localStorage.getItem(PREF_KEY) === "1";
  } catch {
    return false;
  }
}

export function setEntitiesEnabled(on: boolean): void {
  try {
    localStorage.setItem(PREF_KEY, on ? "1" : "0");
    settingChanged();
  } catch {
    // Preference persistence is best-effort.
  }
}

export interface Span {
  label: string;
  text: string;
  start: number;
  end: number;
  score: number;
}

interface Wait {
  resolve: (spans: Span[]) => void;
  reject: (error: Error) => void;
}

let worker: Worker | null = null;
let seq = 0;
const waiting = new Map<number, Wait>();
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let announcedInit = false;

function shutdown(): void {
  worker?.terminate();
  worker = null;
  for (const wait of waiting.values()) {
    wait.reject(new Error("entity worker shut down"));
  }
  waiting.clear();
}

function touchIdleTimer(): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
  }
  idleTimer = setTimeout(shutdown, IDLE_SHUTDOWN_MS);
}

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL("../workers/gliner.worker.ts", import.meta.url), {
      type: "module",
    });
    worker.onmessage = (event: MessageEvent) => {
      const { id, spans, error, initMs } = event.data as {
        id: number;
        spans?: Span[];
        error?: string;
        initMs?: number | null;
      };
      if (typeof initMs === "number" && !announcedInit) {
        announcedInit = true;
        // The number that decides whether this ever runs unprompted; it
        // lands in the activity log so it can be read off any device.
        diag("entities", `extractor ready in ${(initMs / 1000).toFixed(1)}s`);
      }
      const wait = waiting.get(id);
      if (!wait) {
        return;
      }
      waiting.delete(id);
      if (error !== undefined) {
        wait.reject(new Error(error));
      } else {
        wait.resolve(spans ?? []);
      }
    };
    worker.onerror = () => {
      shutdown();
    };
  }
  touchIdleTimer();
  return worker;
}

/** Spans for the given entity labels, or a rejection; never a guess. */
export function extractEntities(
  text: string,
  labels: string[] = TRAVEL_LABELS,
  threshold: number = ENTITY_THRESHOLD,
): Promise<Span[]> {
  const id = ++seq;
  return new Promise<Span[]>((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    getWorker().postMessage({ id, text, labels, threshold });
  });
}
