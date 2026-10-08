import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ready,
  generateAccountKeys,
  generateKey,
  secretBoxSeal,
  encryptBytes,
  decryptBytes,
  encryptFileMetadata,
  utf8Encode,
  type AccountKeys,
} from "@engramer/crypto";
import { buildApp } from "../src/app.js";
import { blobKey } from "../src/blobs.js";
import { mintGeneration } from "../src/db.js";

/**
 * Every content write owns a generation of its own, handed out by one
 * atomic update per file, so two writers overlapping on one file can
 * never write under one blob name, and a save after a restore never
 * reuses the name of a version that still exists. A restore also drops
 * the digest of the bytes it displaces, so the storage check records the
 * restored bytes instead of calling them changed.
 */
let app: FastifyInstance;
let dataDir: string;
let base: string;
let port: number;
let account: AccountKeys;
let token: string;

const auth = () => ({ authorization: `Bearer ${token}` });
const blobDir = () => join(dataDir, "blobs");
const blobsOf = (id: string) => readdirSync(blobDir()).filter((name) => name.startsWith(id)).sort();

async function createFile(name: string): Promise<{ id: string; fileKey: Uint8Array }> {
  const fileKey = generateKey();
  const created = await app.inject({
    method: "POST",
    url: "/api/files",
    headers: auth(),
    payload: {
      folderId: null,
      encryptedKey: secretBoxSeal(fileKey, account.masterKey),
      encryptedMeta: encryptFileMetadata({ name, mime: "text/plain", size: 1, mtime: 1 }, fileKey),
    },
  });
  expect(created.statusCode).toBe(201);
  return { id: created.json().id as string, fileKey };
}

async function save(id: string, fileKey: Uint8Array, text: string) {
  return app.inject({
    method: "PUT",
    url: `/api/files/${id}/data`,
    headers: { ...auth(), "content-type": "application/octet-stream" },
    payload: Buffer.from(encryptBytes(utf8Encode(text), fileKey)),
  });
}

async function current(id: string, fileKey: Uint8Array): Promise<string> {
  const response = await app.inject({ method: "GET", url: `/api/files/${id}/data`, headers: auth() });
  expect(response.statusCode).toBe(200);
  return Buffer.from(decryptBytes(new Uint8Array(response.rawPayload), fileKey)).toString("utf8");
}

async function versions(id: string): Promise<Array<{ generation: number; size: number }>> {
  const response = await app.inject({ method: "GET", url: `/api/files/${id}/versions`, headers: auth() });
  expect(response.statusCode).toBe(200);
  return response.json().versions;
}

async function restore(id: string, fileKey: Uint8Array, generation: number) {
  return app.inject({
    method: "POST",
    url: `/api/files/${id}/versions/${generation}/restore`,
    headers: auth(),
    payload: { encryptedMeta: encryptFileMetadata({ name: "restored.txt", mime: "text/plain", size: 1, mtime: 1 }, fileKey) },
  });
}

async function verdict(id: string): Promise<string> {
  const response = await app.inject({ method: "POST", url: "/api/files/verify", headers: auth(), payload: { ids: [id] } });
  expect(response.statusCode).toBe(200);
  return (response.json().results as Array<{ verdict: string }>)[0]!.verdict;
}

beforeAll(async () => {
  await ready();
  dataDir = mkdtempSync(join(tmpdir(), "engramer-generations-"));
  app = await buildApp({ dataDir, quotaBytes: 4 * 1024 * 1024, webDistDir: null });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (typeof address === "string" || !address) {
    throw new Error("no port");
  }
  port = address.port;
  base = `http://127.0.0.1:${port}`;
  account = generateAccountKeys("generations passphrase");
  const registered = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { email: "gen@example.com", loginKey: account.loginKey, keyAttributes: account.keyAttributes },
  });
  token = registered.json().token as string;
});

afterAll(async () => {
  app.server.closeAllConnections();
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("content generations", () => {
  it("hands the first content generation 1 under its own blob name", async () => {
    const { id, fileKey } = await createFile("first.txt");
    const saved = await save(id, fileKey, "one");
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual({ size: saved.json().size, generation: 1 });
    expect(blobsOf(id)).toEqual([`${id}.g1`]);
    const again = await save(id, fileKey, "two");
    expect(again.json().generation).toBe(2);
    expect((await versions(id)).map((v) => v.generation)).toEqual([1]);
  });

  it("mints past a file's whole history, including rows from before the allocator", async () => {
    const { id, fileKey } = await createFile("legacy.txt");
    // A row written before generations were minted: content at the bare
    // key, versions up to 5, and no allocator state.
    await app.blobs.put(blobKey(id, "data", 0), Readable.from(Buffer.from("old")), 1024);
    await app.db.run("UPDATE files SET uploaded = 1, size = 3, generation = 0, minted_generation = 0 WHERE id = ?", id);
    for (const generation of [2, 5]) {
      await app.db.run(
        "INSERT INTO file_versions (file_id, user_id, generation, size, encrypted_meta, created_at) VALUES (?, (SELECT user_id FROM files WHERE id = ?), ?, 1, '{}', 0)",
        id,
        id,
        generation,
      );
    }
    expect(await mintGeneration(app.db, id)).toBe(6);
    expect(await mintGeneration(app.db, id)).toBe(7);
    await app.db.run("DELETE FROM file_versions WHERE file_id = ?", id);
    expect((await save(id, fileKey, "new")).json().generation).toBe(8);
  });

  it("two overlapping saves keep the winner's bytes and leave one blob", async () => {
    const { id, fileKey } = await createFile("overlap.txt");
    const slow = encryptBytes(utf8Encode("slow writer"), fileKey);
    // Writer A opens a save and sends half of its bytes.
    const socket = connect(port, "127.0.0.1");
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    const head =
      `PUT /api/files/${id}/data HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${token}\r\n` +
      `Content-Type: application/octet-stream\r\nContent-Length: ${slow.length}\r\nConnection: close\r\n\r\n`;
    const half = Math.floor(slow.length / 2);
    socket.write(Buffer.concat([Buffer.from(head), Buffer.from(slow.subarray(0, half))]));
    // A is admitted once its blob name is reserved.
    const deadline = Date.now() + 5000;
    while ((await app.db.get<{ minted_generation: number }>("SELECT minted_generation FROM files WHERE id = ?", id))!.minted_generation < 1) {
      expect(Date.now()).toBeLessThan(deadline);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    // Writer B saves whole and wins.
    const won = await save(id, fileKey, "fast writer");
    expect(won.statusCode).toBe(200);
    // A finishes and loses without touching B's bytes.
    const answer = new Promise<string>((resolve) => {
      const chunks: Buffer[] = [];
      socket.on("data", (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)));
      socket.on("close", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    socket.write(Buffer.from(slow.subarray(half)));
    const text = await answer;
    expect(text.startsWith("HTTP/1.1 409")).toBe(true);
    expect(await current(id, fileKey)).toBe("fast writer");
    expect(blobsOf(id)).toEqual([blobKey(id, "data", won.json().generation as number)]);
  });

  it("a restored file verifies clean", async () => {
    const { id, fileKey } = await createFile("restore-check.txt");
    await save(id, fileKey, "one");
    await save(id, fileKey, "two");
    expect((await restore(id, fileKey, 1)).statusCode).toBe(200);
    expect(await verdict(id)).toBe("recorded");
    expect(await verdict(id)).toBe("intact");
  });

  it("a save after a restore keeps every version", async () => {
    const { id, fileKey } = await createFile("history.txt");
    for (const text of ["v1", "v2", "v3"]) {
      await save(id, fileKey, text);
    }
    expect((await restore(id, fileKey, 1)).statusCode).toBe(200);
    expect((await save(id, fileKey, "v4")).json().generation).toBe(4);
    for (const [generation, text] of [[1, "v1"], [2, "v2"], [3, "v3"]] as const) {
      const response = await app.inject({ method: "GET", url: `/api/files/${id}/versions/${generation}/data`, headers: auth() });
      expect(response.statusCode, `generation ${generation}`).toBe(200);
      expect(Buffer.from(decryptBytes(new Uint8Array(response.rawPayload), fileKey)).toString("utf8")).toBe(text);
    }
    expect((await versions(id)).map((v) => v.generation).sort()).toEqual([1, 2, 3]);
    expect(await current(id, fileKey)).toBe("v4");
    expect(existsSync(join(blobDir(), `${id}.g4`))).toBe(true);
  });
});
