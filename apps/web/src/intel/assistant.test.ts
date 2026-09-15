import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  AssistantError,
  assistantEnabled,
  assistantState,
  describeAssistantState,
  generate,
  parseAssistantState,
  resetAssistantCache,
  setAssistantEnabled,
  type AssistantTransport,
} from "./assistant";

// Prefs live in localStorage; give the node test env one.
beforeAll(() => {
  const backing = new Map<string, string>();
  (globalThis as { localStorage?: Storage }).localStorage = {
    getItem: (k: string) => backing.get(k) ?? null,
    setItem: (k: string, v: string) => void backing.set(k, String(v)),
    removeItem: (k: string) => void backing.delete(k),
    clear: () => backing.clear(),
    key: (i: number) => [...backing.keys()][i] ?? null,
    get length() {
      return backing.size;
    },
  } as Storage;
});

beforeEach(() => {
  localStorage.clear();
  resetAssistantCache();
});

/** A transport whose every answer is scripted, so the policy around it
 * (retries, cancellation, chunk routing) is what the tests exercise. */
function scripted(script: {
  available?: unknown;
  answers?: Array<unknown | AssistantError>;
  chunks?: Array<{ job: string; text: string }>;
}): AssistantTransport & { calls: string[]; cancelled: string[]; requests: Record<string, unknown>[] } {
  const answers = [...(script.answers ?? [])];
  const transport = {
    calls: [] as string[],
    cancelled: [] as string[],
    requests: [] as Record<string, unknown>[],
    async available() {
      transport.calls.push("available");
      return script.available ?? null;
    },
    async generate(request: Record<string, unknown>) {
      transport.calls.push("generate");
      transport.requests.push(request);
      const next = answers.shift();
      if (next instanceof AssistantError) {
        throw next;
      }
      return next;
    },
    async cancel(job: string) {
      transport.cancelled.push(job);
    },
    async listen(handler: (payload: { job: string; text: string }) => void) {
      for (const chunk of script.chunks ?? []) {
        handler(chunk);
      }
      return () => {
        transport.calls.push("unlisten");
      };
    },
  };
  return transport;
}

describe("parseAssistantState", () => {
  it("reads the shell's availability answer", () => {
    expect(parseAssistantState({ state: "available", contextSize: 4096 })).toEqual({
      state: "available",
      contextSize: 4096,
    });
    expect(parseAssistantState({ state: "unavailable", reason: "intelligence-off" })).toEqual({
      state: "unavailable",
      reason: "intelligence-off",
    });
  });

  it("treats no shell, garbage, and a reason it does not know as absence", () => {
    expect(parseAssistantState(null)).toEqual({ state: "unavailable", reason: "not-native" });
    expect(parseAssistantState("nonsense")).toEqual({ state: "unavailable", reason: "not-native" });
    expect(parseAssistantState({ state: "unavailable", reason: "from-the-future" })).toEqual({
      state: "unavailable",
      reason: "unknown",
    });
    expect(parseAssistantState({ state: "available" })).toEqual({ state: "available", contextSize: 4096 });
  });
});

describe("describeAssistantState", () => {
  it("says the reason and the one next step, in one sentence each", () => {
    expect(describeAssistantState({ state: "available", contextSize: 4096 })).toBe(
      "Available on this device. Nothing it reads leaves it.",
    );
    expect(describeAssistantState({ state: "unavailable", reason: "intelligence-off" })).toBe(
      "Needs Apple Intelligence turned on in System Settings.",
    );
    expect(describeAssistantState({ state: "unavailable", reason: "os-too-old" })).toBe(
      "Needs macOS 26 or iOS 26.",
    );
    expect(describeAssistantState({ state: "unavailable", reason: "model-not-ready" })).toBe(
      "The model is still downloading; try again in a while.",
    );
    expect(describeAssistantState({ state: "unavailable", reason: "not-native" })).toBe(
      "Available in the Mac and iPhone apps on macOS 26 and iOS 26.",
    );
  });
});

describe("the switch", () => {
  it("is on until turned off, and remembers", () => {
    expect(assistantEnabled()).toBe(true);
    setAssistantEnabled(false);
    expect(assistantEnabled()).toBe(false);
    setAssistantEnabled(true);
    expect(assistantEnabled()).toBe(true);
  });
});

describe("assistantState", () => {
  it("probes once and answers from memory until asked to look again", async () => {
    const transport = scripted({ available: { state: "available", contextSize: 4096 } });
    expect(await assistantState({}, transport)).toEqual({ state: "available", contextSize: 4096 });
    expect(await assistantState({}, transport)).toEqual({ state: "available", contextSize: 4096 });
    expect(transport.calls.filter((c) => c === "available")).toHaveLength(1);
    await assistantState({ refresh: true }, transport);
    expect(transport.calls.filter((c) => c === "available")).toHaveLength(2);
  });

  it("reports absence outside the shell", async () => {
    expect(await assistantState({}, scripted({}))).toEqual({ state: "unavailable", reason: "not-native" });
  });
});

describe("generate", () => {
  it("fills the request in and hands back the answer", async () => {
    const transport = scripted({ answers: [{ summary: "x" }] });
    const answer = await generate(
      { instructions: "Read.", prompt: "Summarize.", priority: "interactive" },
      transport,
    );
    expect(answer).toEqual({ summary: "x" });
    const sent = transport.requests[0]!;
    expect(sent.model).toBe("system");
    expect(sent.priority).toBe("interactive");
    expect(sent.deadlineMs).toBe(8000);
    expect(sent.maxTokens).toBe(300);
    expect(sent.temperature).toBe(0.2);
    expect(sent.stream).toBe(false);
    expect(typeof sent.job).toBe("string");
  });

  it("gives background work the longer deadline", async () => {
    const transport = scripted({ answers: ["ok"] });
    await generate({ instructions: "", prompt: "p", priority: "background" }, transport);
    expect(transport.requests[0]!.deadlineMs).toBe(60000);
  });

  it("asks again when a request from the user took the slot, up to three times", async () => {
    const pushedOut = () => new AssistantError("preempted", "a request from the user took the slot");
    const transport = scripted({ answers: [pushedOut(), pushedOut(), "done"] });
    expect(await generate({ instructions: "", prompt: "p", priority: "background" }, transport)).toBe("done");
    expect(transport.calls.filter((c) => c === "generate")).toHaveLength(3);
    const stubborn = scripted({ answers: [pushedOut(), pushedOut(), pushedOut(), pushedOut()] });
    await expect(generate({ instructions: "", prompt: "p", priority: "background" }, stubborn)).rejects.toMatchObject({
      code: "preempted",
    });
    expect(stubborn.calls.filter((c) => c === "generate")).toHaveLength(3);
  });

  it("passes every other refusal through untouched", async () => {
    const transport = scripted({ answers: [new AssistantError("guardrail", "declined")] });
    await expect(generate({ instructions: "", prompt: "p", priority: "background" }, transport)).rejects.toMatchObject({
      code: "guardrail",
      detail: "declined",
    });
    expect(transport.calls.filter((c) => c === "generate")).toHaveLength(1);
  });

  it("cancels the job in the shell when the caller aborts", async () => {
    const controller = new AbortController();
    const transport = scripted({ answers: [] });
    transport.generate = async (request) => {
      transport.requests.push(request);
      controller.abort();
      await new Promise((r) => setTimeout(r, 5));
      throw new AssistantError("cancelled", "");
    };
    await expect(
      generate({ instructions: "", prompt: "p", priority: "interactive", signal: controller.signal }, transport),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(transport.cancelled).toEqual([transport.requests[0]!.job]);
  });

  it("forwards only its own job's chunks and stops listening after", async () => {
    const seen: string[] = [];
    const transport = scripted({ answers: [] });
    let listener: ((payload: { job: string; text: string }) => void) | null = null;
    transport.listen = async (handler) => {
      listener = handler;
      return () => {
        transport.calls.push("unlisten");
      };
    };
    transport.generate = async (request) => {
      transport.requests.push(request);
      const job = String(request.job);
      listener?.({ job: "someone-else", text: "no" });
      listener?.({ job, text: "fin" });
      listener?.({ job, text: "final" });
      return "final";
    };
    await generate(
      { instructions: "", prompt: "p", priority: "interactive", onChunk: (text) => seen.push(text) },
      transport,
    );
    expect(seen).toEqual(["fin", "final"]);
    expect(transport.calls).toContain("unlisten");
  });
});

describe("the shell transport", () => {
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it("reaches the shell's three commands and reads its refusals", async () => {
    const calls: Array<[string, Record<string, unknown> | undefined]> = [];
    (globalThis as { window?: unknown }).window = {
      __TAURI__: {
        core: {
          invoke: async (cmd: string, args?: Record<string, unknown>) => {
            calls.push([cmd, args]);
            if (cmd === "intel_available") return { state: "available", contextSize: 4096 };
            if (cmd === "intel_generate") throw { code: "rate-limited", detail: "background" };
            return undefined;
          },
        },
      },
    };
    expect(await assistantState({ refresh: true })).toEqual({ state: "available", contextSize: 4096 });
    await expect(generate({ instructions: "", prompt: "p", priority: "background" })).rejects.toMatchObject({
      code: "rate-limited",
    });
    expect(calls.map(([cmd]) => cmd)).toEqual(["intel_available", "intel_generate"]);
    expect(calls[1]![1]).toHaveProperty("request");
  });
});
