/**
 * The on-device assistant: Apple's language model, reached through the
 * Mac and iPhone apps, reading and writing only on this device. This is
 * the one client every feature goes through: it knows whether the model
 * is here (and the honest reason when it is not), carries the account's
 * switch, and runs one generation at a time with the shell's policy of
 * interactive work outranking background work.
 *
 * Everything the model returns is data: callers validate it before it
 * reaches a surface. Nothing here stores a prompt or an answer.
 */

import {
  nativeAssistantAvailable,
  nativeAssistantCancel,
  nativeAssistantGenerate,
  nativeListen,
} from "../native";
import { settingChanged } from "../settingsbus";

const PREF_KEY = "engram-assistant";
const DEFAULT_CONTEXT_SIZE = 4096;
const INTERACTIVE_DEADLINE_MS = 8_000;
const BACKGROUND_DEADLINE_MS = 60_000;
const DEFAULT_MAX_TOKENS = 300;
const DEFAULT_TEMPERATURE = 0.2;
/** How many times a background job is asked again after a request from
 * the user pushed it out of the slot. */
const PREEMPT_RETRIES = 2;

/** Why the assistant is absent, in the shell's vocabulary. */
export type AssistantAbsence =
  | "not-native"
  | "os-too-old"
  | "device-ineligible"
  | "intelligence-off"
  | "model-not-ready"
  | "build-without-sdk"
  | "unknown";

const ABSENCES: ReadonlySet<string> = new Set([
  "not-native",
  "os-too-old",
  "device-ineligible",
  "intelligence-off",
  "model-not-ready",
  "build-without-sdk",
]);

export type AssistantState =
  | { state: "available"; contextSize: number }
  | { state: "unavailable"; reason: AssistantAbsence };

const NOT_NATIVE: AssistantState = { state: "unavailable", reason: "not-native" };

export function parseAssistantState(raw: unknown): AssistantState {
  if (!raw || typeof raw !== "object") {
    return NOT_NATIVE;
  }
  const answer = raw as { state?: unknown; contextSize?: unknown; reason?: unknown };
  if (answer.state === "available") {
    const size = typeof answer.contextSize === "number" && answer.contextSize > 0 ? answer.contextSize : DEFAULT_CONTEXT_SIZE;
    return { state: "available", contextSize: size };
  }
  if (answer.state === "unavailable") {
    const reason = typeof answer.reason === "string" && ABSENCES.has(answer.reason) ? (answer.reason as AssistantAbsence) : "unknown";
    return { state: "unavailable", reason };
  }
  return NOT_NATIVE;
}

/** The one sentence every surface uses to say where the assistant stands:
 * the reason, and the single next step when there is one. */
export function describeAssistantState(state: AssistantState): string {
  if (state.state === "available") {
    return "Available on this device. Nothing it reads leaves it.";
  }
  switch (state.reason) {
    case "not-native":
      return "Available in the Mac and iPhone apps on macOS 26 and iOS 26.";
    case "os-too-old":
      return "Needs macOS 26 or iOS 26.";
    case "device-ineligible":
      return "This device cannot run Apple's on-device model.";
    case "intelligence-off":
      return "Needs Apple Intelligence turned on in System Settings.";
    case "model-not-ready":
      return "The model is still downloading; try again in a while.";
    case "build-without-sdk":
      return "This build of the app was made without the assistant.";
    default:
      return "The assistant is not available on this device.";
  }
}

// ----- the switch (follows the account; see settingsync) -----

export function assistantEnabled(): boolean {
  try {
    return localStorage.getItem(PREF_KEY) !== "0";
  } catch {
    return true;
  }
}

export function setAssistantEnabled(on: boolean): void {
  try {
    localStorage.setItem(PREF_KEY, on ? "1" : "0");
    settingChanged();
  } catch {
    // Preference persistence is best-effort.
  }
}

// ----- transport -----

/** What the shell offers, behind an interface so the policy is testable. */
export interface AssistantTransport {
  available(): Promise<unknown>;
  generate(request: Record<string, unknown>): Promise<unknown>;
  cancel(job: string): Promise<void>;
  listen(handler: (payload: { job: string; text: string }) => void): Promise<() => void>;
}

const nativeTransport: AssistantTransport = {
  available: nativeAssistantAvailable,
  generate: nativeAssistantGenerate,
  cancel: nativeAssistantCancel,
  listen: (handler) => nativeListen<{ job: string; text: string }>("intel-chunk", handler),
};

export class AssistantError extends Error {
  readonly code: string;
  readonly detail: string;

  constructor(code: string, detail: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "AssistantError";
    this.code = code;
    this.detail = detail;
  }

  static from(raw: unknown): AssistantError {
    if (raw instanceof AssistantError) {
      return raw;
    }
    if (raw && typeof raw === "object" && typeof (raw as { code?: unknown }).code === "string") {
      const typed = raw as { code: string; detail?: unknown };
      return new AssistantError(typed.code, typeof typed.detail === "string" ? typed.detail : "");
    }
    return new AssistantError("other", raw instanceof Error ? raw.message : String(raw));
  }
}

// ----- availability -----

let cached: Promise<AssistantState> | null = null;

/** Whether the model is here. Probed once per session; `refresh` asks
 * again (the Profile page does, and so does a return to the foreground,
 * because a downloading model becomes ready without any event). */
export async function assistantState(
  opts: { refresh?: boolean } = {},
  transport: AssistantTransport = nativeTransport,
): Promise<AssistantState> {
  if (!cached || opts.refresh) {
    cached = transport
      .available()
      .then(parseAssistantState)
      .catch(() => NOT_NATIVE);
  }
  return cached;
}

export function resetAssistantCache(): void {
  cached = null;
}

// ----- generation -----

/** The JSON-schema subset the shell turns into guided generation. */
export interface JsonSchemaProperty {
  type: "string" | "number" | "integer" | "boolean" | "array";
  description?: string;
  enum?: string[];
  items?: JsonSchemaProperty;
  minItems?: number;
  maxItems?: number;
}

export interface JsonSchema {
  type: "object";
  title?: string;
  properties: Record<string, JsonSchemaProperty>;
  required?: string[];
  /** The order the model sees the properties in; defaults to sorted. */
  order?: string[];
}

export interface GenerateRequest {
  instructions: string;
  prompt: string;
  priority: "interactive" | "background";
  /** Absent means a plain string answer. */
  schema?: JsonSchema;
  model?: "system" | "tagging";
  maxTokens?: number;
  temperature?: number;
  deadlineMs?: number;
  signal?: AbortSignal;
  /** Cumulative text so far, for plain string answers only. */
  onChunk?: (text: string) => void;
}

let jobCounter = 0;

function nextJobId(): string {
  jobCounter += 1;
  return `${Date.now().toString(36)}-${jobCounter}`;
}

/**
 * One generation. Resolves with the model's answer (an object for a
 * schema, a string otherwise); rejects with an AssistantError whose code
 * is the shell's. A background job pushed out by a request from the user
 * is asked again a bounded number of times before that becomes the
 * caller's problem.
 */
export async function generate(
  request: GenerateRequest,
  transport: AssistantTransport = nativeTransport,
): Promise<unknown> {
  let attempt = 0;
  for (;;) {
    try {
      return await generateOnce(request, transport);
    } catch (raw) {
      const error = AssistantError.from(raw);
      if (error.code === "preempted" && attempt < PREEMPT_RETRIES) {
        attempt += 1;
        continue;
      }
      throw error;
    }
  }
}

async function generateOnce(request: GenerateRequest, transport: AssistantTransport): Promise<unknown> {
  if (request.signal?.aborted) {
    throw new AssistantError("cancelled", "");
  }
  const job = nextJobId();
  const stream = request.onChunk !== undefined && request.schema === undefined;
  const payload: Record<string, unknown> = {
    job,
    model: request.model ?? "system",
    instructions: request.instructions,
    prompt: request.prompt,
    ...(request.schema ? { schema: request.schema } : {}),
    stream,
    maxTokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
    temperature: request.temperature ?? DEFAULT_TEMPERATURE,
    deadlineMs:
      request.deadlineMs ?? (request.priority === "interactive" ? INTERACTIVE_DEADLINE_MS : BACKGROUND_DEADLINE_MS),
    priority: request.priority,
  };
  const onAbort = () => void transport.cancel(job);
  request.signal?.addEventListener("abort", onAbort, { once: true });
  let unlisten: (() => void) | null = null;
  if (stream) {
    const onChunk = request.onChunk!;
    unlisten = await transport.listen((chunk) => {
      if (chunk.job === job) {
        onChunk(chunk.text);
      }
    });
  }
  try {
    return await transport.generate(payload);
  } catch (raw) {
    throw AssistantError.from(raw);
  } finally {
    request.signal?.removeEventListener("abort", onAbort);
    unlisten?.();
  }
}
