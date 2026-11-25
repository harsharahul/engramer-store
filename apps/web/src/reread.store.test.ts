import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { decryptBytes, encryptBytes, generateKey, ready, secretBoxSeal } from "@engramer/crypto";
import type { FileDto } from "./api";

/**
 * A stored file's text read again with the current text step, through the
 * store: what is written, what is kept, what a failed run changes (nothing),
 * and what a second pass does (nothing). The original's bytes and the text
 * reader are stood in for; the index blob, the metadata and the scan are real.
 */

const blobs = vi.hoisted(() => ({ index: new Map<string, Uint8Array>(), reads: 0, writes: 0 }));
const originals = vi.hoisted(() => ({ bytes: new Map<string, Uint8Array>(), reads: 0 }));
const reader = vi.hoisted(() => ({ fail: false, text: undefined as string | undefined, during: undefined as (() => void) | undefined }));
const metadata = vi.hoisted(() => ({ writes: 0 }));

vi.mock("./api", async (importOriginal) => {
  const original = await importOriginal<typeof import("./api")>();
  return {
    ...original,
    api: { ...original.api },
    uploadBlob: async (id: string, kind: string, bytes: Uint8Array) => {
      if (kind === "index") {
        blobs.index.set(id, bytes);
        blobs.writes++;
      }
    },
  };
});

vi.mock("./transfer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./transfer")>()),
  downloadAndDecrypt: async (id: string) => {
    originals.reads++;
    return originals.bytes.get(id)!;
  },
}));

vi.mock("./intel/extract", async (importOriginal) => {
  const original = await importOriginal<typeof import("./intel/extract")>();
  return {
    ...original,
    extractText: async (file: Parameters<typeof original.extractText>[0], opts?: { strict?: boolean }) => {
      if (reader.fail) {
        throw new Error("the reader could not run");
      }
      reader.during?.();
      return reader.text !== undefined ? reader.text : original.extractText(file, opts);
    },
  };
});

vi.mock("./intel/scan", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./intel/scan")>()),
  factsEnabled: () => true,
}));

import { api, ApiError } from "./api";
import { decodeIndexPayload, encodeIndexPayload, type IndexPayload } from "./indexblob";
import type { Fact } from "./intel/facts";
import { useStore, type FileEntry } from "./store";

const EMAIL = "application/vnd.engram.email+json";
const DAY = 86_400_000;
const masterKey = { value: new Uint8Array(32) as Uint8Array };

const HTML =
  "<p>Thank you for booking with Harbour Guest House Example.</p>" +
  "<table><tr><th>Check-in</th><th>Check-out</th><th>Nights</th></tr>" +
  "<tr><td>Fri 12 March 2027, from 15:00</td><td>Mon 15 March 2027, by 11:00</td><td>3</td></tr></table>";
const RECORD = {
  v: 1,
  messageId: "<b1@example.com>",
  date: Date.UTC(2027, 1, 20, 12),
  from: { name: "Harbour Guest House Example", address: "stay@example.com" },
  to: ["alex@example.com"],
  cc: [],
  subject: "Booking confirmed",
  html: HTML,
  headers: "",
  inline: [],
  attachments: [],
  source: { kind: "import", label: "export.mbox" },
};
const RECORD_BYTES = new TextEncoder().encode(JSON.stringify(RECORD));
/** What the older text step stored for that mail: the words of every cell run together. */
const FLAT =
  "Booking confirmed\nFrom: Harbour Guest House Example <stay@example.com>\nTo: alex@example.com\n\n" +
  "Thank you for booking with Harbour Guest House Example.Check-inCheck-outNightsFri 12 March 2027, from 15:00Mon 15 March 2027, by 11:003";

/** A line the rules read from the flat text, which nobody answered. */
const LINE: Fact = { id: "dated:2027-03-12", kind: "dated", document: "other", value: "2027-03-12", label: "Check-inCheck-outNightsFri", source: "label", confidence: 0.4 };
/** A reading the owner said yes to. */
const ANSWERED: Fact = { id: "due:2027-03-01", kind: "due", document: "other", value: "2027-03-01", source: "label", confidence: 0.7, confirmed: true };
/** The model's reading. */
const MODEL: Fact = { id: "amount:429.00", kind: "amount", document: "other", value: "429.00", unit: "GBP", source: "model", reader: "apple", confidence: 0.6 };
const CLIP = new Float32Array([0.25, 0.5, 0.75]);

const stored = (over: Partial<FileEntry> = {}): FileEntry => ({
  id: "m1",
  folderId: null,
  name: "Booking confirmed.email",
  mime: EMAIL,
  size: RECORD_BYTES.length,
  mtime: RECORD.date,
  hasText: true,
  hasClip: false,
  inlineText: false,
  category: "Documents",
  tags: ["mail"],
  facts: [LINE, ANSWERED, MODEL],
  favorite: false,
  digest: "d1",
  key: generateKey(),
  hasThumb: true,
  trashed: false,
  createdAt: Date.now() - 10 * DAY,
  updatedAt: 1,
  ...over,
});

function library(files: FileEntry[], index: Record<string, IndexPayload>) {
  masterKey.value = generateKey();
  useStore.setState({
    session: { email: "t@example.com", token: "t", masterKey: masterKey.value, privateKey: new Uint8Array(32), publicKey: "" },
    files: new Map(files.map((file) => [file.id, file])),
  });
  for (const file of files) {
    blobs.index.set(file.id, encryptBytes(encodeIndexPayload(index[file.id] ?? {}), file.key));
  }
}

const entry = (id = "m1") => useStore.getState().files.get(id)!;
const blob = (id = "m1") => decodeIndexPayload(decryptBytes(blobs.index.get(id)!, entry(id).key));
const kinds = (id = "m1") => entry(id).facts.map((fact) => `${fact.kind} ${fact.value}${fact.time ? ` ${fact.time}` : ""}`).sort();

beforeAll(async () => {
  await ready();
});

beforeEach(() => {
  blobs.index.clear();
  blobs.reads = 0;
  blobs.writes = 0;
  originals.bytes.clear();
  originals.reads = 0;
  reader.fail = false;
  reader.text = undefined;
  reader.during = undefined;
  metadata.writes = 0;
  const stub = api as unknown as Record<string, unknown>;
  stub["downloadBlob"] = async (id: string) => {
    blobs.reads++;
    return blobs.index.get(id)!;
  };
  // An older server's answer, so bulk writes take the single route stubbed below.
  stub["batchFiles"] = async () => {
    throw new ApiError(404, "not found");
  };
  stub["patchFile"] = async (id: string, patch: { encryptedMeta: FileDto["encryptedMeta"] }): Promise<FileDto> => {
    metadata.writes++;
    const file = entry(id);
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
      createdAt: file.createdAt,
      updatedAt: 2,
    };
  };
});

describe("a stored mail read again when it is opened", () => {
  const evidence = [
    { id: LINE.id, span: "Check-inCheck-outNightsFri 12 March 2027" },
    { id: MODEL.id, span: "Total 429.00" },
  ];

  it("takes its new text once: rows and cells in the blob, its vector and its other evidence kept, the stamp set", async () => {
    library([stored()], { m1: { text: FLAT, clip: CLIP, evidence } });
    expect(await useStore.getState().rereadText("m1", RECORD_BYTES)).toBe(true);

    const written = blob();
    expect(written.text).toContain("Check-in | Check-out | Nights\nFri 12 March 2027, from 15:00 | Mon 15 March 2027, by 11:00 | 3");
    expect(written.text!.startsWith("Booking confirmed\nFrom: Harbour Guest House Example <stay@example.com>")).toBe(true);
    expect([...written.clip!]).toEqual([...CLIP]);
    // The model's evidence stays; the dropped line's goes; what the rules read now brings its own.
    const ids = written.evidence!.map((item) => item.id);
    expect(ids).toContain(MODEL.id);
    expect(ids).not.toContain(LINE.id);
    expect(entry().textEdition).toBe(2);
    expect(entry().text).toBe(written.text);
    expect([blobs.writes, metadata.writes]).toEqual([1, 1]);
  });

  it("the rules' readings are fresh: the line from the flat text goes, the stay is read, an answer and the model's reading stay", async () => {
    library([stored()], { m1: { text: FLAT, evidence } });
    await useStore.getState().rereadText("m1", RECORD_BYTES);
    expect(kinds()).toEqual(["amount 429.00", "due 2027-03-01", "event 2027-03-12 15:00", "event 2027-03-15 11:00"]);
    expect(entry().facts.find((fact) => fact.id === ANSWERED.id)?.confirmed).toBe(true);
    // The model is not asked again: its stamp is for the same bytes.
    expect(entry().reading).toBeUndefined();
  });

  it("a second time reads nothing and writes nothing", async () => {
    library([stored()], { m1: { text: FLAT } });
    await useStore.getState().rereadText("m1", RECORD_BYTES);
    const before = [blobs.reads, blobs.writes, metadata.writes];
    expect(await useStore.getState().rereadText("m1", RECORD_BYTES)).toBe(false);
    expect([blobs.reads, blobs.writes, metadata.writes]).toEqual(before);
  });

  it("a file that reads as less than it holds keeps its text, and is settled: no device reads it again", async () => {
    // Its text came from elsewhere (a scan read by recognition): the reader finds far less.
    const long = "Words a recognizer read from the page. ".repeat(40);
    library([stored()], { m1: { text: long, evidence } });
    reader.text = "Booking confirmed";
    expect(await useStore.getState().rereadText("m1", RECORD_BYTES)).toBe(false);
    expect(blob().text).toBe(long);
    expect(blobs.writes).toBe(0);
    expect(entry().textEdition).toBe(2);
    expect(kinds()).toEqual(["amount 429.00", "dated 2027-03-12", "due 2027-03-01"]);
  });

  it("a reader that could not run changes nothing; the file stays owed, and is not tried again in this session", async () => {
    library([stored({ id: "f1" })], { f1: { text: FLAT } });
    reader.fail = true;
    expect(await useStore.getState().rereadText("f1", RECORD_BYTES)).toBe(false);
    expect([blobs.writes, metadata.writes]).toEqual([0, 0]);
    expect(entry("f1").textEdition).toBeUndefined();
    expect(blob("f1").text).toBe(FLAT);
    // Opened again in the same session: no second try.
    reader.fail = false;
    const reads = blobs.reads;
    expect(await useStore.getState().rereadText("f1", RECORD_BYTES)).toBe(false);
    expect(blobs.reads).toBe(reads);
  });

  it("a file whose contents were replaced while it was being read is left for its new contents", async () => {
    library([stored({ id: "c1" })], { c1: { text: FLAT } });
    // A save lands while the reader is at work: the bytes read are no longer the file's.
    reader.during = () => {
      const files = new Map(useStore.getState().files);
      files.set("c1", { ...files.get("c1")!, digest: "d2" });
      useStore.setState({ files });
    };
    expect(await useStore.getState().rereadText("c1", RECORD_BYTES)).toBe(false);
    expect([blobs.writes, metadata.writes]).toEqual([0, 0]);
    expect(entry("c1").textEdition).toBeUndefined();
    expect(blob("c1").text).toBe(FLAT);
  });

  it("a file that is not stale, or is gone, is left alone", async () => {
    library([stored({ textEdition: 2 }), stored({ id: "t1", trashed: true })], { m1: { text: FLAT }, t1: { text: FLAT } });
    expect(await useStore.getState().rereadText("m1", RECORD_BYTES)).toBe(false);
    expect(await useStore.getState().rereadText("t1", RECORD_BYTES)).toBe(false);
    expect(await useStore.getState().rereadText("nobody", RECORD_BYTES)).toBe(false);
    expect([blobs.reads, blobs.writes, metadata.writes]).toEqual([0, 0, 0]);
  });
});

describe("a stored file read again by the background pass", () => {
  const pdf = (over: Partial<FileEntry> = {}) => stored({ id: "p1", name: "bill.pdf", mime: "application/pdf", facts: [], ...over });
  const PAGE = "Northline Energy Example Statement date: 2 November 2026 Payment due date: 23 November 2026 Total amount due: 86.35 GBP";
  const LINES = "Northline Energy Example\n\nStatement date: 2 November 2026\nPayment due date: 23 November 2026\nTotal amount due: 86.35 GBP";

  it("fetches the original once, writes the new text and the stamp, and owes nothing after", async () => {
    library([pdf()], { p1: { text: PAGE } });
    originals.bytes.set("p1", new Uint8Array([37, 80, 68, 70]));
    reader.text = LINES;
    const outcome = await useStore.getState().processFile("p1");
    expect(outcome?.text).toBe(1);
    expect(blob("p1").text).toBe(LINES);
    expect(entry("p1").textEdition).toBe(2);
    expect(kinds("p1")).toContain("due 2026-11-23");
    expect(originals.reads).toBe(1);
    // Run twice: the second pass has nothing to do.
    expect(await useStore.getState().processFile("p1")).toBeNull();
    expect(originals.reads).toBe(1);
  });

  it("a PDF whose text is read for the first time is stamped then, and is not fetched a second time", async () => {
    library([pdf({ id: "p2", hasText: false })], { p2: {} });
    originals.bytes.set("p2", new Uint8Array([37, 80, 68, 70]));
    reader.text = LINES;
    expect(await useStore.getState().recognizeFile("p2")).toBe(true);
    expect(entry("p2").textEdition).toBe(2);
    expect(await useStore.getState().processFile("p2")).toBeNull();
    expect(originals.reads).toBe(1);
  });

  it("a run that fails is a failed try for the pass, with nothing written", async () => {
    library([pdf()], { p1: { text: PAGE } });
    originals.bytes.set("p1", new Uint8Array([37, 80, 68, 70]));
    reader.fail = true;
    await expect(useStore.getState().processFile("p1")).rejects.toThrow("could not run");
    expect([blobs.writes, metadata.writes]).toEqual([0, 0]);
    expect(entry("p1").textEdition).toBeUndefined();
  });

  it("a file stored long ago is not the pass's: it is read again when it is opened", async () => {
    library([pdf({ createdAt: Date.now() - 200 * DAY })], { p1: { text: PAGE } });
    reader.text = LINES;
    expect(await useStore.getState().processFile("p1")).toBeNull();
    expect(originals.reads).toBe(0);
    expect(await useStore.getState().rereadText("p1", new Uint8Array([37, 80, 68, 70]))).toBe(true);
    expect(entry("p1").textEdition).toBe(2);
  });
});
