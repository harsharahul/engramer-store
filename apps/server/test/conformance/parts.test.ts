import { decryptBytes, encryptBytes, ready } from "@engramer/crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTarget, type Target } from "../helpers/target.js";
import { register } from "./accounts.js";
import {
  abortParts,
  beginParts,
  completeParts,
  getBlob,
  listVersions,
  payload,
  putBlob,
  putPart,
  sameBytes,
  split,
  uploadFile,
} from "./content.js";
import { createFile, syncFor, type Account } from "./storage.js";

/**
 * Large content arrives as numbered parts inside a session, so one lost
 * part costs one part, not the file. The joined bytes are what a single
 * upload would have stored and go through the same commit.
 */
const QUOTA = 2 * 1024 * 1024;

let target: Target;
let alice: Account;
let bob: Account;

beforeAll(async () => {
  await ready();
  target = await startTarget({ quotaBytes: QUOTA, maxVersions: 2 });
  alice = await register(target, "alice@example.com");
  bob = await register(target, "bob@example.com");
});

afterAll(async () => {
  await target?.close();
});

async function begin(id: string, size: unknown, expected = 201, token = alice.token): Promise<string> {
  const response = await beginParts(target, token, id, size);
  expect(response.statusCode).toBe(expected);
  return expected === 201 ? (response.json().session as string) : "";
}

async function download(id: string, key: Uint8Array): Promise<Uint8Array> {
  const response = await getBlob(target, alice.token, id, "data");
  expect(response.statusCode).toBe(200);
  return decryptBytes(new Uint8Array(response.rawPayload), key);
}

describe("part uploads", () => {
  it("join parts into the same bytes a single upload stores and commit the row", async () => {
    const file = await createFile(target, alice, "movie.mp4");
    const content = payload(300 * 1024);
    const ciphertext = encryptBytes(content, file.key);
    const session = await begin(file.id, ciphertext.length);
    expect(session).toMatch(/^[0-9a-f-]{36}$/);
    for (const [i, part] of split(ciphertext, 3).entries()) {
      const put = await putPart(target, alice.token, file.id, session, i + 1, part);
      expect(put.statusCode).toBe(200);
      expect(put.json()).toEqual({ part: i + 1, size: part.length });
    }
    const done = await completeParts(target, alice.token, file.id, session);
    expect(done.statusCode).toBe(200);
    expect(done.json()).toEqual({ size: ciphertext.length, generation: 0 });
    expect(sameBytes(await download(file.id, file.key), content)).toBe(true);
    const row = (await syncFor(target, alice)).files.find((f) => f.id === file.id)!;
    expect(row).toMatchObject({ uploaded: true, size: ciphertext.length });
  });

  it("let a retried part replace itself", async () => {
    const file = await createFile(target, alice, "retry.mp4");
    const content = payload(96 * 1024);
    const ciphertext = encryptBytes(content, file.key);
    const [first, second] = split(ciphertext, 2);
    const session = await begin(file.id, ciphertext.length);
    await putPart(target, alice.token, file.id, session, 1, first!);
    const garbled = Uint8Array.from(second!);
    garbled[0] = garbled[0]! ^ 0xff;
    await putPart(target, alice.token, file.id, session, 2, garbled);
    await putPart(target, alice.token, file.id, session, 2, second!);
    expect((await completeParts(target, alice.token, file.id, session)).statusCode).toBe(200);
    expect(sameBytes(await download(file.id, file.key), content)).toBe(true);
  });

  it("refuse to complete with a missing part, a short total, or no parts", async () => {
    const file = await createFile(target, alice, "gap.mp4");
    const ciphertext = encryptBytes(payload(96 * 1024), file.key);
    const [a, , c] = split(ciphertext, 3);
    const session = await begin(file.id, ciphertext.length);
    const empty = await completeParts(target, alice.token, file.id, session);
    expect(empty.statusCode).toBe(400);
    expect(empty.json()).toEqual({ error: "upload incomplete" });
    await putPart(target, alice.token, file.id, session, 1, a!);
    await putPart(target, alice.token, file.id, session, 3, c!);
    const gapped = await completeParts(target, alice.token, file.id, session);
    expect(gapped.statusCode).toBe(400);
    expect(gapped.json()).toEqual({ error: "upload incomplete" });
    expect((await syncFor(target, alice)).files.find((f) => f.id === file.id)!.uploaded).toBe(false);
  });

  it("refuse a declared size beyond the quota, and a malformed declaration", async () => {
    const file = await createFile(target, alice, "huge.mp4");
    const refused = await beginParts(target, alice.token, file.id, QUOTA * 2);
    expect(refused.statusCode).toBe(413);
    expect(refused.json()).toEqual({ error: "storage quota exceeded" });
    for (const size of [0, -1, 1.5, "100", null]) {
      const bad = await beginParts(target, alice.token, file.id, size);
      expect(bad.statusCode, String(size)).toBe(400);
      expect(bad.json()).toEqual({ error: "invalid request" });
    }
  });

  it("refuse parts that overflow the declared size, a bad part number, and an empty part", async () => {
    const file = await createFile(target, alice, "overflow.mp4");
    const ciphertext = encryptBytes(payload(64 * 1024), file.key);
    const session = await begin(file.id, 10 * 1024);
    const overflow = await putPart(target, alice.token, file.id, session, 1, ciphertext);
    expect(overflow.statusCode).toBe(413);
    expect(overflow.json()).toEqual({ error: "parts exceed the declared size" });
    for (const part of [0, 10_001, "x", -1]) {
      const bad = await putPart(target, alice.token, file.id, session, part, ciphertext.subarray(0, 10));
      expect(bad.statusCode, String(part)).toBe(400);
      expect(bad.json()).toEqual({ error: "invalid part number" });
    }
    const empty = await putPart(target, alice.token, file.id, session, 1, new Uint8Array(0));
    expect(empty.statusCode).toBe(400);
    expect(empty.json()).toEqual({ error: "content-length required" });
  });

  it("hide files and sessions from other accounts", async () => {
    const file = await createFile(target, alice, "private.mp4");
    const ciphertext = encryptBytes(payload(32 * 1024), file.key);
    const foreignBegin = await beginParts(target, bob.token, file.id, ciphertext.length);
    expect(foreignBegin.statusCode).toBe(404);
    expect(foreignBegin.json()).toEqual({ error: "file not found" });
    const session = await begin(file.id, ciphertext.length);
    for (const response of [
      await putPart(target, bob.token, file.id, session, 1, ciphertext),
      await completeParts(target, bob.token, file.id, session),
      await abortParts(target, bob.token, file.id, session),
    ]) {
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: "upload session not found" });
    }
  });

  it("abort a session and forget it", async () => {
    const file = await createFile(target, alice, "aborted.mp4");
    const ciphertext = encryptBytes(payload(32 * 1024), file.key);
    const session = await begin(file.id, ciphertext.length);
    await putPart(target, alice.token, file.id, session, 1, ciphertext);
    const aborted = await abortParts(target, alice.token, file.id, session);
    expect(aborted.statusCode).toBe(204);
    expect((await putPart(target, alice.token, file.id, session, 2, ciphertext)).statusCode).toBe(404);
    expect((await completeParts(target, alice.token, file.id, session)).statusCode).toBe(404);
    expect((await abortParts(target, alice.token, file.id, session)).statusCode).toBe(404);
  });

  it("supersede a stale session when a new one begins", async () => {
    const file = await createFile(target, alice, "superseded.mp4");
    const content = payload(64 * 1024);
    const ciphertext = encryptBytes(content, file.key);
    const first = await begin(file.id, ciphertext.length);
    await putPart(target, alice.token, file.id, first, 1, split(ciphertext, 2)[0]!);
    const second = await begin(file.id, ciphertext.length);
    expect((await completeParts(target, alice.token, file.id, first)).statusCode).toBe(404);
    for (const [i, part] of split(ciphertext, 2).entries()) {
      await putPart(target, alice.token, file.id, second, i + 1, part);
    }
    expect((await completeParts(target, alice.token, file.id, second)).statusCode).toBe(200);
    expect(sameBytes(await download(file.id, file.key), content)).toBe(true);
  });

  it("answer 409 and keep the other writer's bytes on a generation conflict", async () => {
    const file = await uploadFile(target, alice, "conflict.mp4", payload(24 * 1024));
    const mine = encryptBytes(payload(48 * 1024), file.key);
    const session = await begin(file.id, mine.length);
    await putPart(target, alice.token, file.id, session, 1, mine);
    const winner = payload(12 * 1024);
    expect((await putBlob(target, alice.token, file.id, "data", encryptBytes(winner, file.key))).statusCode).toBe(200);
    const lost = await completeParts(target, alice.token, file.id, session);
    expect(lost.statusCode).toBe(409);
    expect(lost.json()).toEqual({ error: "the file changed while saving; retry" });
    expect(sameBytes(await download(file.id, file.key), winner)).toBe(true);
    expect((await completeParts(target, alice.token, file.id, session)).statusCode).toBe(404);
  });

  it("snapshot the displaced generation as a version", async () => {
    const file = await uploadFile(target, alice, "versioned.mp4", payload(16 * 1024));
    const second = payload(32 * 1024);
    const ciphertext = encryptBytes(second, file.key);
    const session = await begin(file.id, ciphertext.length);
    for (const [i, part] of split(ciphertext, 2).entries()) {
      await putPart(target, alice.token, file.id, session, i + 1, part);
    }
    const done = await completeParts(target, alice.token, file.id, session);
    expect(done.json()).toEqual({ size: ciphertext.length, generation: 1 });
    expect(sameBytes(await download(file.id, file.key), second)).toBe(true);
    expect(await listVersions(target, alice.token, file.id)).toHaveLength(1);
  });
});
