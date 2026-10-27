import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKey, ready, secretBoxSeal, type FileMetadata } from "@engramer/crypto";
import type { FileDto } from "./api";

/**
 * Readings through the store's own pass, with the model stubbed: what is
 * stamped, how failures count, and what a second pass does. A real model is
 * never called here; what matters is how often the store asks it.
 */

const model = vi.hoisted(() => ({
  summarize: vi.fn(async (_input: unknown): Promise<unknown> => ({ summary: "A synthetic note.", tags: [], kind: null, facts: [] })),
  facts: false,
}));

vi.mock("./intel/summarize", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./intel/summarize")>()),
  summarize: model.summarize,
}));

vi.mock("./intel/assistant", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./intel/assistant")>()),
  assistantEnabled: () => true,
  assistantAvailableNow: () => true,
  lastAssistantState: () => ({ state: "available", contextSize: 4096 }),
}));

// The shipped scores by default; a test may stand in others.
const scoreState = vi.hoisted(() => ({ value: undefined as unknown, shipped: undefined as unknown }));
vi.mock("./intel/eval/scores.json", async (importOriginal) => {
  const actual = (await importOriginal<{ default: unknown }>()).default;
  scoreState.shipped = actual;
  scoreState.value = actual;
  return {
    get default() {
      return scoreState.value;
    },
  };
});

vi.mock("./intel/scan", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./intel/scan")>()),
  factsEnabled: () => model.facts,
}));

const writes = vi.hoisted(() => ({ count: 0, blobs: 0 }));


vi.mock("./api", async (importOriginal) => {
  const original = await importOriginal<typeof import("./api")>();
  return {
    ...original,
    api: { ...original.api },
    uploadBlob: async () => {
      writes.blobs++;
    },
  };
});

import { api, ApiError } from "./api";
import { AssistantError } from "./intel/assistant";
import { useStore, type FileEntry } from "./store";

const masterKey = vi.hoisted(() => ({ value: new Uint8Array(32) as Uint8Array }));

const note = (over: Partial<FileEntry> = {}): FileEntry => ({
  id: over.id ?? "n1",
  folderId: null,
  name: "note.txt",
  mime: "text/plain",
  size: 400,
  mtime: 1,
  text: "Synthetic words. ".repeat(30),
  hasText: true,
  hasClip: false,
  inlineText: false,
  category: "Notes",
  tags: ["notes"],
  facts: [],
  favorite: false,
  digest: "d1",
  key: generateKey(),
  hasThumb: true,
  trashed: false,
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

function library(files: FileEntry[]) {
  masterKey.value = generateKey();
  useStore.setState({
    session: { email: "t@example.com", token: "t", masterKey: masterKey.value, privateKey: new Uint8Array(32), publicKey: "" },
    files: new Map(files.map((f) => [f.id, f])),
  });
}

beforeAll(async () => {
  await ready();
});

beforeEach(() => {
  scoreState.value = scoreState.shipped;
  model.summarize.mockReset();
  model.summarize.mockResolvedValue({ summary: "A synthetic note.", tags: [], kind: null, facts: [] });
  model.facts = false;
  writes.count = 0;
  writes.blobs = 0;
  // An older server's answer, so bulk writes take the single route stubbed below.
  (api as unknown as Record<string, unknown>).batchFiles = async () => {
    throw new ApiError(404, "not found");
  };
  (api as unknown as Record<string, unknown>).patchFile = async (
    id: string,
    patch: { encryptedMeta: FileDto["encryptedMeta"] },
  ): Promise<FileDto> => {
    writes.count++;
    const file = useStore.getState().files.get(id)!;
    return {
      id,
      folderId: file.folderId,
      encryptedKey: secretBoxSeal(file.key, masterKey.value),
      encryptedMeta: patch.encryptedMeta,
      size: file.size,
      thumbSize: 1,
      indexSize: 1,
      uploaded: true,
      trashed: false,
      deleted: false,
      updateSeq: 2,
      createdAt: 1,
      updatedAt: 2,
    };
  };
});

const stampOf = (id = "n1") => useStore.getState().files.get(id)!.reading;

describe("a reading that keeps failing", () => {
  it("a reader that always times out stops after 3 tries and says why", async () => {
    library([note()]);
    model.summarize.mockRejectedValue(new Error("the reading took too long"));
    await useStore.getState().processFile("n1");
    expect(stampOf()).toMatchObject({ outcome: "retrying", tries: 1 });
    await useStore.getState().processFile("n1");
    expect(stampOf()).toMatchObject({ outcome: "retrying", tries: 2 });
    await useStore.getState().processFile("n1");
    expect(stampOf()).toMatchObject({ outcome: "failed", tries: 3, reason: "the reading took too long" });
    // Final: the pass has nothing left to do with it.
    model.summarize.mockClear();
    expect(await useStore.getState().processFile("n1")).toBeNull();
    expect(model.summarize).not.toHaveBeenCalled();
  });

  it("a model that is off, busy or cancelled on this device spends no tries", async () => {
    library([note()]);
    for (const code of ["unavailable", "preempted", "cancelled", "bad-request"]) {
      model.summarize.mockRejectedValueOnce(new AssistantError(code, ""));
      await useStore.getState().processFile("n1");
      expect(stampOf()).toBeUndefined();
    }
    // The file is still owed to a device whose model works.
    expect(await useStore.getState().processFile("n1")).not.toBeNull();
    expect(stampOf()).toMatchObject({ outcome: "found" });
  });

  it("a timeout from the model counts as a try", async () => {
    library([note()]);
    model.summarize.mockRejectedValueOnce(new AssistantError("timeout", "the reading took too long"));
    await useStore.getState().processFile("n1");
    expect(stampOf()).toMatchObject({ outcome: "retrying", tries: 1 });
  });

  it("a reading that failed on an older build can still be retried", async () => {
    // An older build's write dropped the stamp; only the legacy pair says it failed.
    library([note({ id: "a", assistVersion: 1, noSummary: "failed" })]);
    expect(await useStore.getState().retryFailedReadings()).toBe(1);
    expect(stampOf("a")).toMatchObject({ outcome: "retrying", tries: 0 });
  });

  it("tries count across devices", async () => {
    // Another device already tried twice.
    library([
      note({
        reading: { reader: "apple", rank: 2, version: 1, digest: "d1", tasks: ["summary"], outcome: "retrying", tries: 2, at: 1 },
      }),
    ]);
    model.summarize.mockRejectedValue(new Error("the reading took too long"));
    await useStore.getState().processFile("n1");
    expect(stampOf()).toMatchObject({ outcome: "failed", tries: 3 });
  });

  it("Retry starts the count again for failed files only", async () => {
    const failed = { reader: "apple", rank: 2, version: 1, digest: "d1", tasks: ["summary" as const], outcome: "failed" as const, tries: 3, reason: "x", at: 1 };
    const found = { ...failed, outcome: "found" as const, tries: 1, reason: undefined };
    library([note({ id: "a", reading: failed }), note({ id: "b", reading: found })]);
    expect(await useStore.getState().retryFailedReadings()).toBe(1);
    expect(stampOf("a")).toMatchObject({ outcome: "retrying", tries: 0 });
    expect(stampOf("a")).not.toHaveProperty("reason");
    expect(stampOf("b")).toMatchObject({ outcome: "found" });
  });
});

describe("what a reading proposes", () => {
  it("with today's measured scores a model date is named for its reader and waits for a yes", async () => {
    model.facts = true;
    model.summarize.mockResolvedValue({
      summary: "A synthetic bill.",
      tags: [],
      kind: null,
      facts: [{ id: "due:2027-04-10", kind: "due", document: "invoice", value: "2027-04-10", label: "Payment due", source: "model", confidence: 0.45 }],
    });
    library([note()]);
    await useStore.getState().processFile("n1");
    const due = useStore.getState().files.get("n1")!.facts.find((f) => f.kind === "due")!;
    expect(due).toMatchObject({ reader: "apple", source: "model" });
    expect(due.accepted).toBeUndefined();
  });
});

describe("reading mail", () => {
  const email = (over: Partial<FileEntry> = {}): FileEntry =>
    note({
      name: "Your water bill.email",
      mime: "application/vnd.engram.email+json",
      category: "Mail",
      text: "Your water bill\nFrom: billing@example.com\n\nUSD 64.10, due 15 May 2027.",
      ...over,
    });

  const trustedKinds = () => {
    scoreState.value = {
      reader: "apple",
      version: 1,
      tasks: { mailKind: { accuracy: 0.95, cases: 30 } },
    };
  };

  it("an email's kind is not stored while its measured accuracy is low", async () => {
    model.summarize.mockResolvedValue({ summary: "A water bill.", tags: [], kind: null, facts: [], mailKind: "bill" });
    library([email({ tags: ["mail"] })]);
    await useStore.getState().processFile("n1");
    expect(useStore.getState().files.get("n1")!.tags).toEqual(["mail"]);
  });

  it("a trusted kind is stored as a tag, replacing the older one", async () => {
    trustedKinds();
    model.summarize.mockResolvedValue({ summary: "A water bill.", tags: [], kind: null, facts: [], mailKind: "bill" });
    library([email({ tags: ["mail", "mail:other"] })]);
    await useStore.getState().processFile("n1");
    const tags = useStore.getState().files.get("n1")!.tags;
    expect(tags).toContain("mail:bill");
    expect(tags).not.toContain("mail:other");
  });

  it("a newsletter's dates are set aside only when the kind is trusted", async () => {
    model.facts = true;
    const sale = { summary: "A sale.", tags: [], kind: null, mailKind: "newsletter", facts: [{ id: "due:2027-05-30", kind: "due", document: "other", value: "2027-05-30", label: "Sale ends", source: "model", confidence: 0.45 }] };
    model.summarize.mockResolvedValue(sale);
    library([email({ id: "a" })]);
    await useStore.getState().processFile("a");
    expect(useStore.getState().files.get("a")!.facts.map((f) => f.value)).toEqual(["2027-05-30"]);
    trustedKinds();
    library([email({ id: "b" })]);
    await useStore.getState().processFile("b");
    expect(useStore.getState().files.get("b")!.facts).toEqual([]);
  });

  it("a short email is still read", async () => {
    library([email()]);
    await useStore.getState().processFile("n1");
    expect(model.summarize).toHaveBeenCalledTimes(1);
    expect(model.summarize.mock.calls[0]![0]).toMatchObject({ mail: true });
  });

  it("an email with booking data is summarized but not asked for dates", async () => {
    model.facts = true;
    const booked = {
      id: "event:2027-04-08 check-in",
      kind: "event" as const,
      document: "hotel-booking" as const,
      value: "2027-04-08",
      label: "Check-in",
      source: "jsonld" as const,
      confidence: 1,
      accepted: "exact" as const,
    };
    library([email({ facts: [booked] })]);
    await useStore.getState().processFile("n1");
    expect(model.summarize.mock.calls[0]![0]).toMatchObject({ withFacts: false });
    // The dates were read exactly; the stamp says so, or the file would be read again for them.
    expect(stampOf()?.tasks).toContain("facts");
  });

  it("email records are read newest first", async () => {
    const day = 86_400_000;
    library([
      email({ id: "old", name: "Old.email", mail: { messageId: "<o>", from: "", fromAddress: "", to: [], date: Date.now() - 3 * day, subject: "Old", attachmentIds: [] } }),
      email({ id: "new", name: "New.email", mail: { messageId: "<n>", from: "", fromAddress: "", to: [], date: Date.now() - 1 * day, subject: "New", attachmentIds: [] } }),
      email({ id: "mid", name: "Mid.email", mail: { messageId: "<m>", from: "", fromAddress: "", to: [], date: Date.now() - 2 * day, subject: "Mid", attachmentIds: [] } }),
    ]);
    await useStore.getState().processLibrary();
    expect(model.summarize.mock.calls.map((call) => (call[0] as { name: string }).name)).toEqual([
      "New.email",
      "Mid.email",
      "Old.email",
    ]);
  });
});

describe("what a reading stamps", () => {
  it("a summary written by the pass leaves a stamp older builds also read", async () => {
    library([note()]);
    await useStore.getState().processFile("n1");
    const file = useStore.getState().files.get("n1")!;
    expect(file.reading).toMatchObject({ reader: "apple", rank: 2, digest: "d1", outcome: "found", tasks: ["summary"] });
    expect(file.assistVersion).toBe(1);
    expect(file.summary).toBe("A synthetic note.");
  });
});

/**
 * The standing guards: a second pass of any kind over the same library
 * reads nothing and writes nothing. If one of these fails, a loop is back.
 */
describe("no reading loops", () => {
  it("run twice: a second processing pass reads nothing and writes nothing", async () => {
    library([note({ id: "a" }), note({ id: "b" }), note({ id: "c" })]);
    await useStore.getState().processLibrary();
    expect(model.summarize).toHaveBeenCalledTimes(3);
    const after = writes.count;
    model.summarize.mockClear();
    await useStore.getState().processLibrary();
    expect(model.summarize).not.toHaveBeenCalled();
    expect(writes.count).toBe(after);
  });

  it("run twice: a second date sweep writes nothing", async () => {
    model.facts = true;
    library([note({ text: "Benefit End Date: 19 October 2027" })]);
    expect(await useStore.getState().scanLibraryForFacts()).toBe(1);
    const after = { count: writes.count, blobs: writes.blobs };
    await useStore.getState().scanLibraryForFacts();
    expect(writes.count).toBe(after.count);
    expect(writes.blobs).toBe(after.blobs);
  });

  it("an unstable model causes no re-reads", async () => {
    let n = 0;
    model.summarize.mockImplementation(async () => ({ summary: `Reading number ${++n}.`, tags: [], kind: null, facts: [] }));
    library([note({ id: "a" }), note({ id: "b" })]);
    await useStore.getState().processLibrary();
    await useStore.getState().processLibrary();
    expect(model.summarize).toHaveBeenCalledTimes(2);
  });

  it("same-rank race: a result for contents another device already stamped is dropped", async () => {
    library([note()]);
    // While this device's model reads, another device's stamp for the same
    // contents arrives by sync.
    model.summarize.mockImplementation(async () => {
      const file = useStore.getState().files.get("n1")!;
      useStore.setState({
        files: new Map([
          [
            "n1",
            {
              ...file,
              summary: "Their summary.",
              reading: { reader: "apple", rank: 2, version: 1, digest: "d1", tasks: ["summary"], outcome: "found", tries: 1, at: 2 },
            },
          ],
        ]),
      });
      return { summary: "Our summary.", tags: [], kind: null, facts: [] };
    });
    await useStore.getState().processFile("n1");
    expect(useStore.getState().files.get("n1")!.summary).toBe("Their summary.");
    expect(writes.count).toBe(0);
  });

  it("a success is kept when another device's last failure lands meanwhile", async () => {
    library([note()]);
    model.summarize.mockImplementation(async () => {
      const file = useStore.getState().files.get("n1")!;
      useStore.setState({
        files: new Map([
          [
            "n1",
            {
              ...file,
              reading: { reader: "apple", rank: 2, version: 1, digest: "d1", tasks: ["summary"], outcome: "failed", tries: 3, at: 2 },
            },
          ],
        ]),
      });
      return { summary: "Our summary.", tags: [], kind: null, facts: [] };
    });
    await useStore.getState().processFile("n1");
    expect(useStore.getState().files.get("n1")!.summary).toBe("Our summary.");
    expect(stampOf()).toMatchObject({ outcome: "found" });
  });

  it("our own metadata write leaves nothing owed for the same file", async () => {
    library([note()]);
    await useStore.getState().processFile("n1");
    const { needsProcessing } = await import("./store");
    expect(needsProcessing(useStore.getState().files.get("n1")!)).toBe(false);
  });
});

// Keeps the FileMetadata import honest for readers of this file.
export type { FileMetadata };
