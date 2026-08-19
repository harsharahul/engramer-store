import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { generateKey, ready, secretBoxOpen } from "@engramer/crypto";
import {
  clearResumeRecord,
  loadResumeRecords,
  makeJournal,
  resumeStateOf,
  type ResumeRecordSource,
} from "./resumeupload";

beforeAll(async () => {
  await ready();
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

beforeEach(() => localStorage.clear());

const account = "r@example.com";
const source: ResumeRecordSource = {
  path: "/tmp/engram-picked/clip.mov",
  family: "picked",
  name: "clip.mov",
  type: "video/quicktime",
  size: 40_000_000,
  mtime: 1_754_700_000_000,
  sourceId: "asset-7",
  folderId: "folder-1",
};

/**
 * The journal writes a resume record as the upload happens, so whatever
 * moment the app dies at, the record on disk describes it: session,
 * header, the key wrapped under the master key, and every part's fate.
 * Finishing removes it; an upload that completed needs no memory.
 */
describe("resume records", () => {
  it("is written incrementally and removed when the upload finishes", () => {
    const masterKey = generateKey();
    const fileKey = generateKey();
    const header = new Uint8Array([1, 2, 3, 4]);
    const journal = makeJournal(account, masterKey, source);
    journal.begin({ fileId: "f-1", session: "s-1", header, fileKey });
    journal.part({ no: 1, firstChunk: 0, chunks: 4, done: false });
    journal.part({ no: 1, firstChunk: 0, chunks: 4, done: true });
    journal.part({ no: 2, firstChunk: 4, chunks: 4, done: false });

    const records = loadResumeRecords(account);
    expect(records).toHaveLength(1);
    const record = records[0]!;
    expect(record.fileId).toBe("f-1");
    expect(record.parts).toEqual([
      { no: 1, firstChunk: 0, chunks: 4, done: true },
      { no: 2, firstChunk: 4, chunks: 4, done: false },
    ]);
    // The key at rest is sealed; only the master key opens it.
    expect(JSON.stringify(record.wrappedKey)).not.toContain(
      Buffer.from(fileKey).toString("base64"),
    );
    const state = resumeStateOf(record, masterKey);
    expect(new Uint8Array(state.header)).toEqual(header);
    expect(secretBoxOpen(record.wrappedKey, masterKey)).toEqual(fileKey);
    expect(state.fileKey).toEqual(fileKey);

    journal.finish();
    expect(loadResumeRecords(account)).toEqual([]);
  });

  it("beginning again over an existing record keeps what already landed", () => {
    const masterKey = generateKey();
    const first = makeJournal(account, masterKey, source);
    first.begin({ fileId: "f-1", session: "s-1", header: new Uint8Array([1]), fileKey: generateKey() });
    first.part({ no: 1, firstChunk: 0, chunks: 4, done: true });
    const resumed = makeJournal(account, masterKey, source);
    resumed.begin({
      fileId: "f-1",
      session: "s-1",
      header: new Uint8Array([1]),
      fileKey: generateKey(),
    });
    expect(loadResumeRecords(account)[0]!.parts).toEqual([
      { no: 1, firstChunk: 0, chunks: 4, done: true },
    ]);
  });

  it("keeps accounts apart and survives a corrupt store as empty", () => {
    localStorage.setItem("engram-upload-resume:r@example.com", "{corrupt");
    expect(loadResumeRecords(account)).toEqual([]);
    const journal = makeJournal(account, generateKey(), source);
    journal.begin({
      fileId: "f-2",
      session: "s-2",
      header: new Uint8Array([9]),
      fileKey: generateKey(),
    });
    expect(loadResumeRecords(account)).toHaveLength(1);
    expect(loadResumeRecords("other@example.com")).toEqual([]);
    clearResumeRecord(account, "f-2");
    expect(loadResumeRecords(account)).toEqual([]);
  });
});
