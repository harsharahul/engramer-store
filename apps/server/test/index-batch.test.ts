import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ready,
  generateAccountKeys,
  generateKey,
  secretBoxSeal,
  encryptBytes,
  encryptFileMetadata,
  utf8Encode,
  type AccountKeys,
} from "@engramer/crypto";
import { buildApp } from "../src/app.js";

let app: FastifyInstance;
let dataDir: string;

interface Account {
  keys: AccountKeys;
  token: string;
}

let alice: Account;
let bob: Account;

async function register(email: string): Promise<Account> {
  const keys = generateAccountKeys(`${email} passphrase`);
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { email, loginKey: keys.loginKey, keyAttributes: keys.keyAttributes },
  });
  return { keys, token: response.json().token as string };
}

async function createFile(owner: Account, name: string, index?: string) {
  const fileKey = generateKey();
  const headers = { authorization: `Bearer ${owner.token}` };
  const created = await app.inject({
    method: "POST",
    url: "/api/files",
    headers,
    payload: {
      folderId: null,
      encryptedKey: secretBoxSeal(fileKey, owner.keys.masterKey),
      encryptedMeta: encryptFileMetadata(
        { name, mime: "text/plain", size: 4, mtime: 1, hasText: index !== undefined } as never,
        fileKey,
      ),
    },
  });
  const id = created.json().id as string;
  await app.inject({
    method: "PUT",
    url: `/api/files/${id}/data`,
    headers: { ...headers, "content-type": "application/octet-stream" },
    payload: Buffer.from(encryptBytes(utf8Encode("body"), fileKey)),
  });
  let blob: Buffer | undefined;
  if (index !== undefined) {
    blob = Buffer.from(encryptBytes(utf8Encode(index), fileKey));
    await app.inject({
      method: "PUT",
      url: `/api/files/${id}/index`,
      headers: { ...headers, "content-type": "application/octet-stream" },
      payload: blob,
    });
  }
  return { id, blob };
}

/** Splits a batch answer into [id, blob] pairs, in the order the server wrote them. */
function frames(body: Buffer): Array<[string, Buffer]> {
  const out: Array<[string, Buffer]> = [];
  let at = 0;
  while (at < body.length) {
    const idLength = body.readUInt32BE(at);
    const id = body.subarray(at + 4, at + 4 + idLength).toString("utf8");
    at += 4 + idLength;
    const size = body.readUInt32BE(at);
    out.push([id, body.subarray(at + 4, at + 4 + size)]);
    at += 4 + size;
  }
  return out;
}

async function batch(account: Account, ids: string[]) {
  return app.inject({
    method: "POST",
    url: "/api/files/index/batch",
    headers: { authorization: `Bearer ${account.token}` },
    payload: { ids },
  });
}

beforeAll(async () => {
  await ready();
  dataDir = mkdtempSync(join(tmpdir(), "engramer-index-batch-"));
  app = await buildApp({ dataDir, quotaBytes: 1024 * 1024, webDistDir: null });
  alice = await register("alice@example.com");
  bob = await register("bob@example.com");
});

afterAll(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("batch index download", () => {
  it("returns the index blobs of readable files in request order", async () => {
    const one = await createFile(alice, "one.txt", "first words");
    const two = await createFile(alice, "two.txt", "second words");
    const three = await createFile(alice, "three.txt", "third words");
    const response = await batch(alice, [three.id, one.id, two.id]);
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("application/octet-stream");
    const got = frames(response.rawPayload);
    expect(got.map(([id]) => id)).toEqual([three.id, one.id, two.id]);
    expect(got[0]![1].equals(three.blob!)).toBe(true);
    expect(got[1]![1].equals(one.blob!)).toBe(true);
    expect(got[2]![1].equals(two.blob!)).toBe(true);
  });

  it("leaves out files without an index and files the caller cannot read", async () => {
    const indexed = await createFile(alice, "indexed.txt", "kept");
    const plain = await createFile(alice, "plain.bin");
    const foreign = await createFile(bob, "bobs.txt", "not for alice");
    const response = await batch(alice, [plain.id, foreign.id, indexed.id]);
    expect(response.statusCode).toBe(200);
    expect(frames(response.rawPayload).map(([id]) => id)).toEqual([indexed.id]);
  });

  it("refuses more than 500 ids", async () => {
    const ids = Array.from({ length: 501 }, () => crypto.randomUUID());
    const response = await batch(alice, ids);
    expect(response.statusCode).toBe(400);
  });
});
