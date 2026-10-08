import { unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encryptBytes, ready } from "@engramer/crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTarget, type Target } from "../helpers/target.js";
import { register } from "./accounts.js";
import { beginParts, completeParts, payload, putPart, uploadFile, verify } from "./content.js";
import { createFile, type Account } from "./storage.js";

/**
 * Checking stored content without downloading it: the backend cannot read
 * these files, but it can tell whether what it holds is still what it was
 * handed, which is every way stored data goes wrong on its own.
 */
let target: Target;
let alice: Account;
let bob: Account;

const blobPath = (key: string) => join(target.dataDir, "blobs", key);

beforeAll(async () => {
  await ready();
  target = await startTarget();
  alice = await register(target, "alice@example.com");
  bob = await register(target, "bob@example.com");
});

afterAll(async () => {
  await target?.close();
});

async function verdicts(ids: string[], token = alice.token) {
  const response = await verify(target, token, ids);
  expect(response.statusCode).toBe(200);
  return response.json().results as Array<{ id: string; verdict: string }>;
}

describe("verifying stored content", () => {
  it("says a stored file is intact without reading a byte of it to the client", async () => {
    const file = await uploadFile(target, alice, "f.bin", new Uint8Array([1, 2, 3, 4, 5]));
    expect(await verdicts([file.id])).toEqual([{ id: file.id, verdict: "intact" }]);
  });

  it("notices when stored bytes are not what was written", async () => {
    const file = await uploadFile(target, alice, "f.bin", new Uint8Array(2048).fill(7));
    writeFileSync(blobPath(`${file.id}.g1`), Buffer.alloc(file.ciphertext.length, 9));
    expect(await verdicts([file.id])).toEqual([{ id: file.id, verdict: "changed" }]);
  });

  it("notices a truncated blob", async () => {
    const file = await uploadFile(target, alice, "f.bin", new Uint8Array(4096).fill(3));
    writeFileSync(blobPath(`${file.id}.g1`), Buffer.from(file.ciphertext.subarray(0, 10)));
    expect(await verdicts([file.id])).toEqual([{ id: file.id, verdict: "changed" }]);
  });

  it("reports a blob that has gone missing rather than calling it intact", async () => {
    const file = await uploadFile(target, alice, "f.bin", new Uint8Array([9, 9, 9]));
    unlinkSync(blobPath(`${file.id}.g1`));
    expect(await verdicts([file.id])).toEqual([{ id: file.id, verdict: "unreadable" }]);
  });

  it("calls a file without content, a stranger's file and an unknown id missing", async () => {
    const empty = await createFile(target, alice, "empty.bin");
    const theirs = await uploadFile(target, bob, "theirs.bin", new Uint8Array([1]));
    expect(await verdicts([empty.id, theirs.id, "nothing"])).toEqual([
      { id: empty.id, verdict: "missing" },
      { id: theirs.id, verdict: "missing" },
      { id: "nothing", verdict: "missing" },
    ]);
  });

  it("records a digest for content joined from parts, then verifies against it", async () => {
    const file = await createFile(target, alice, "parts.bin");
    const ciphertext = encryptBytes(payload(20 * 1024), file.key);
    const session = (await beginParts(target, alice.token, file.id, ciphertext.length)).json().session as string;
    await putPart(target, alice.token, file.id, session, 1, ciphertext);
    expect((await completeParts(target, alice.token, file.id, session)).statusCode).toBe(200);
    expect(await verdicts([file.id])).toEqual([{ id: file.id, verdict: "recorded" }]);
    expect(await verdicts([file.id])).toEqual([{ id: file.id, verdict: "intact" }]);
  });

  it("bounds a request so one call cannot walk a whole vault, and checks its shape", async () => {
    for (const ids of [Array.from({ length: 51 }, (_, i) => `id-${i}`), [], ["a", 1], "a", undefined]) {
      const response = await verify(target, alice.token, ids);
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: "invalid request" });
    }
    const exact = await verify(target, alice.token, Array.from({ length: 50 }, (_, i) => `id-${i}`));
    expect(exact.statusCode).toBe(200);
    expect(exact.json().results).toHaveLength(50);
  });

  it("requires a session", async () => {
    const response = await target.inject({ method: "POST", url: "/api/files/verify", payload: { ids: ["x"] } });
    expect(response.statusCode).toBe(401);
  });
});
