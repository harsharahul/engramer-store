import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { chunkedDecrypt, generateKey, ready } from "@engramer/crypto";
import type { FileDto } from "./api";
import type { PreparedFile } from "./transfer";

/**
 * Resuming an interrupted upload is only safe if the parts it sends are
 * byte-identical to the ones the killed run would have sent: the server
 * concatenates parts by number and decrypts as one blob. These tests
 * assemble that blob the way the server does and decrypt it.
 */

const rig = vi.hoisted(() => ({
  // Bodies by part number, as the server would hold them.
  parts: new Map<number, Uint8Array>(),
  sessions: 0,
  sentParts: [] as number[],
}));

vi.mock("./api", async (importOriginal) => {
  const original = await importOriginal<typeof import("./api")>();
  const dto = (over: Partial<FileDto>): FileDto => ({
    id: "f-resume",
    folderId: null,
    encryptedKey: { nonce: "", ciphertext: "" },
    encryptedMeta: { nonce: "", ciphertext: "" },
    size: 0,
    thumbSize: 0,
    indexSize: 0,
    uploaded: true,
    trashed: false,
    deleted: false,
    updateSeq: 1,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  });
  return {
    ...original,
    api: {
      ...original.api,
      createFile: async () => dto({}),
      patchFile: async (id: string) => dto({ id }),
      trashFile: async () => {},
      deleteForever: async () => {},
    },
    uploadBlob: async (_id: string, _kind: string, bytes: Uint8Array) => bytes.length,
    beginPartUpload: async () => {
      rig.sessions++;
      return { session: `s-${rig.sessions}` };
    },
    uploadPart: async (_id: string, _s: string, no: number, body: Uint8Array) => {
      rig.sentParts.push(no);
      rig.parts.set(no, body.slice());
      return body.length;
    },
    completePartUpload: async () => ({ size: 0 }),
    abortPartUpload: async () => {},
  };
});

import { encryptAndUpload, type ResumePart, type UploadSource } from "./transfer";

const MB = 1024 * 1024;

function patternedSource(size: number): UploadSource {
  const byteAt = (i: number) => (i * 31 + 7) % 251;
  return {
    name: "clip.mov",
    type: "video/quicktime",
    size,
    lastModified: 1,
    slice(start = 0, end = size) {
      const from = Math.min(start, size);
      const to = Math.min(end, size);
      return {
        size: to - from,
        arrayBuffer: async () => {
          const bytes = new Uint8Array(to - from);
          for (let i = 0; i < bytes.length; i++) {
            bytes[i] = byteAt(from + i);
          }
          return bytes.buffer as ArrayBuffer;
        },
      };
    },
    arrayBuffer: async () => {
      throw new Error("the resume flow must never read the source whole");
    },
    text: async () => "",
  };
}

function assembled(): Uint8Array {
  const numbers = [...rig.parts.keys()].sort((a, b) => a - b);
  const total = numbers.reduce((n, no) => n + rig.parts.get(no)!.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const no of numbers) {
    out.set(rig.parts.get(no)!, offset);
    offset += rig.parts.get(no)!.length;
  }
  return out;
}

const prepared = (source: UploadSource): PreparedFile => ({
  meta: { name: source.name, mime: source.type, size: source.size, mtime: 1 },
  analysis: { category: "Other", tags: [] },
  thumbnail: null,
});

interface JournalLog {
  fileId?: string;
  session?: string;
  header?: Uint8Array;
  fileKey?: Uint8Array;
  parts: ResumePart[];
  finished: number;
}

function journalInto(log: JournalLog) {
  return {
    begin(info: { fileId: string; session: string; header: Uint8Array; fileKey: Uint8Array }) {
      log.fileId = info.fileId;
      log.session = info.session;
      log.header = info.header.slice();
      log.fileKey = info.fileKey.slice();
    },
    part(part: ResumePart) {
      const existing = log.parts.find((p) => p.no === part.no);
      if (existing) {
        Object.assign(existing, part);
      } else {
        log.parts.push({ ...part });
      }
    },
    finish() {
      log.finished++;
    },
  };
}

beforeAll(async () => {
  await ready();
});

beforeEach(() => {
  rig.parts.clear();
  rig.sessions = 0;
  rig.sentParts.length = 0;
});

describe("upload journal", () => {
  it("records the session, header, key, and every part span of a fresh upload", async () => {
    const source = patternedSource(40 * MB + 5);
    const log: JournalLog = { parts: [], finished: 0 };
    await encryptAndUpload(source, null, generateKey(), prepared(source), () => {}, undefined, {
      journal: journalInto(log),
    });
    expect(log.session).toBe("s-1");
    expect(log.header).toBeDefined();
    expect(log.fileKey).toHaveLength(32);
    expect(log.finished).toBe(1);
    // Parts cover every chunk exactly once, in order, all done.
    const sorted = [...log.parts].sort((a, b) => a.no - b.no);
    let chunk = 0;
    for (const part of sorted) {
      expect(part.firstChunk).toBe(chunk);
      expect(part.done).toBe(true);
      chunk += part.chunks;
    }
    expect(chunk).toBe(Math.ceil((40 * MB + 5) / (4 * MB)));
    // What the server holds decrypts back to the source, byte for byte.
    const plain = chunkedDecrypt(assembled(), log.fileKey!);
    expect(plain.length).toBe(40 * MB + 5);
    expect(plain[12_345_678]).toBe(((12_345_678 * 31 + 7) % 251) as number);
  });
});

describe("resuming after a kill", () => {
  it("re-sends only the missing part and the blob still decrypts whole", async () => {
    const source = patternedSource(40 * MB + 5);
    const log: JournalLog = { parts: [], finished: 0 };
    await encryptAndUpload(source, null, generateKey(), prepared(source), () => {}, undefined, {
      journal: journalInto(log),
    });
    const control = assembled();

    // The kill: one part's bytes never reached the server, and its
    // record still says so.
    const missing = 2;
    rig.parts.delete(missing);
    rig.sentParts.length = 0;
    const parts = log.parts.map((p) => ({ ...p, done: p.no !== missing }));

    await encryptAndUpload(source, null, generateKey(), prepared(source), () => {}, undefined, {
      resume: {
        fileId: "f-resume",
        session: log.session!,
        header: log.header!,
        fileKey: log.fileKey!,
        parts,
      },
    });
    expect(rig.sentParts).toEqual([missing]);
    // No new server session: the recorded one is the resume.
    expect(rig.sessions).toBe(1);
    expect(Buffer.from(assembled()).equals(Buffer.from(control))).toBe(true);
  });

  it("continues past the recorded parts when the kill came mid-file", async () => {
    const source = patternedSource(40 * MB + 5);
    const log: JournalLog = { parts: [], finished: 0 };
    await encryptAndUpload(source, null, generateKey(), prepared(source), () => {}, undefined, {
      journal: journalInto(log),
    });
    const control = assembled();
    const sorted = [...log.parts].sort((a, b) => a.no - b.no);

    // Only the first part had landed when the app died.
    for (const part of sorted.slice(1)) {
      rig.parts.delete(part.no);
    }
    rig.sentParts.length = 0;

    await encryptAndUpload(source, null, generateKey(), prepared(source), () => {}, undefined, {
      resume: {
        fileId: "f-resume",
        session: log.session!,
        header: log.header!,
        fileKey: log.fileKey!,
        parts: [sorted[0]!],
      },
    });
    expect(rig.sentParts).not.toContain(sorted[0]!.no);
    expect(rig.sentParts.length).toBeGreaterThan(0);
    expect(Buffer.from(assembled()).equals(Buffer.from(control))).toBe(true);
  });
});
