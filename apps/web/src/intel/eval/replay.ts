/**
 * Replaying kept model answers, so a change to the code around the model
 * can be scored again in seconds and without the model.
 *
 * An answer is kept under the name of the request it answered. On replay a
 * request gets its answer back only when it is the same request, to the
 * character: an answer to another question says nothing about this one, so
 * a changed request is stale and has to go to the model again.
 */

import { AssistantError, type GenerateRequest } from "../assistant";

/** No kept answer belongs to this request: it has to go to the model. */
export class StaleAnswer extends Error {
  readonly code = "stale";

  constructor() {
    super("the request is not the one a kept answer was for");
    this.name = "StaleAnswer";
  }
}

/** One call to the model as it was kept: the request's name, and its answer or the error it gave. */
export interface SavedAnswer {
  request: string;
  answer?: unknown;
  error?: string;
}

/**
 * A short name for a request: everything the model sees (instructions,
 * prompt, schema, answer budget, temperature, model) and nothing it does
 * not (who waits for the answer, a deadline, a signal).
 */
export function hashRequest(request: GenerateRequest): string {
  const seen = [request.instructions, request.prompt, request.schema ?? null, request.maxTokens ?? null, request.temperature ?? null, request.model ?? null];
  let hash = 0x811c9dc5;
  for (const char of JSON.stringify(seen)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * A runner that answers from what was kept for one document, in the order
 * it was asked. A request that is not the next one kept rejects as stale; a
 * kept error is given again under its own code.
 */
export function replayRunner(saved: readonly SavedAnswer[]): (request: GenerateRequest) => Promise<unknown> {
  let next = 0;
  return async (request) => {
    const kept = saved[next];
    if (!kept || kept.request !== hashRequest(request)) {
      throw new StaleAnswer();
    }
    next += 1;
    if (kept.error !== undefined) {
      // The error the model gave then, as the reading code knows it.
      throw new AssistantError(kept.error, "");
    }
    return kept.answer;
  };
}
