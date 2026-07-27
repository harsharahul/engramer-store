import { existsSync, mkdtempSync, rmSync } from "node:fs";
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
  decryptBytes,
  encryptFileMetadata,
  utf8Encode,
  type AccountKeys,
} from "@engramer/crypto";
import { buildApp } from "../src/app.js";

let app: FastifyInstance;
let dataDir: string;
let account: AccountKeys;
let token: string;

const authHeader = () => ({ authorization: `Bearer ${token}` });

async function createFile(name: string) {
  const fileKey = generateKey();
  const created = await app.inject({
    method: "POST",
    url: "/api/files",
    headers: authHeader(),
    payload: {
      folderId: null,
      encryptedKey: secretBoxSeal(fileKey, account.masterKey),
      encryptedMeta: encryptFileMetadata(
        { name, mime: "text/plain", size: 4, mtime: Date.now(), hasText: true } as never,
        fileKey,
      ),
    },
  });
  const id = created.json().id as string;
  await app.inject({
    method: "PUT",
    url: `/api/files/${id}/data`,
    headers: { ...authHeader(), "content-type": "application/octet-stream" },
    payload: Buffer.from(encryptBytes(utf8Encode("body"), fileKey)),
  });
  return { id, fileKey };
}

beforeAll(async () => {
  await ready();
  dataDir = mkdtempSync(join(tmpdir(), "engramer-index-test-"));
  app = await buildApp({ dataDir, quotaBytes: 256 * 1024, webDistDir: null });
  account = generateAccountKeys("index blobs ahoy");
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: {
      email: "index@example.com",
      loginKey: account.loginKey,
      keyAttributes: account.keyAttributes,
    },
  });
  token = response.json().token as string;
});

afterAll(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("search-index blobs", () => {
  it("round-trips encrypted search text out of band of the metadata row", async () => {
    const { id, fileKey } = await createFile("indexed.txt");
    const text = utf8Encode("the searchable words live here, not in sync rows");

    const put = await app.inject({
      method: "PUT",
      url: `/api/files/${id}/index`,
      headers: { ...authHeader(), "content-type": "application/octet-stream" },
      payload: Buffer.from(encryptBytes(text, fileKey)),
    });
    expect(put.statusCode).toBe(200);

    const got = await app.inject({
      method: "GET",
      url: `/api/files/${id}/index`,
      headers: authHeader(),
    });
    expect(got.statusCode).toBe(200);
    expect(decryptBytes(new Uint8Array(got.rawPayload), fileKey)).toEqual(text);

    // The sync row advertises the index without carrying it.
    const sync = await app.inject({ method: "GET", url: "/api/sync?since=0", headers: authHeader() });
    const dto = (sync.json().files as Array<{ id: string; indexSize: number }>).find(
      (f) => f.id === id,
    )!;
    expect(dto.indexSize).toBeGreaterThan(0);
  });

  it("404s when a file has no index", async () => {
    const { id } = await createFile("plain.bin");
    const got = await app.inject({
      method: "GET",
      url: `/api/files/${id}/index`,
      headers: authHeader(),
    });
    expect(got.statusCode).toBe(404);
  });

  it("counts index bytes in quota and frees them on replacement", async () => {
    const { id, fileKey } = await createFile("requota.txt");
    const before = (await app.inject({ method: "GET", url: "/api/user", headers: authHeader() }))
      .json().usedBytes as number;
    await app.inject({
      method: "PUT",
      url: `/api/files/${id}/index`,
      headers: { ...authHeader(), "content-type": "application/octet-stream" },
      payload: Buffer.from(encryptBytes(new Uint8Array(10_000), fileKey)),
    });
    const withIndex = (await app.inject({ method: "GET", url: "/api/user", headers: authHeader() }))
      .json().usedBytes as number;
    expect(withIndex - before).toBeGreaterThan(9_000);

    // A smaller replacement shrinks usage instead of stacking.
    await app.inject({
      method: "PUT",
      url: `/api/files/${id}/index`,
      headers: { ...authHeader(), "content-type": "application/octet-stream" },
      payload: Buffer.from(encryptBytes(new Uint8Array(100), fileKey)),
    });
    const smaller = (await app.inject({ method: "GET", url: "/api/user", headers: authHeader() }))
      .json().usedBytes as number;
    expect(smaller).toBeLessThan(withIndex);
  });

  it("delete forever removes the index blob from disk", async () => {
    const { id, fileKey } = await createFile("purge-idx.txt");
    await app.inject({
      method: "PUT",
      url: `/api/files/${id}/index`,
      headers: { ...authHeader(), "content-type": "application/octet-stream" },
      payload: Buffer.from(encryptBytes(utf8Encode("bye"), fileKey)),
    });
    expect(existsSync(join(dataDir, "blobs", `${id}.idx`))).toBe(true);
    await app.inject({ method: "DELETE", url: `/api/files/${id}`, headers: authHeader() });
    await app.inject({ method: "DELETE", url: `/api/trash/${id}`, headers: authHeader() });
    expect(existsSync(join(dataDir, "blobs", `${id}.idx`))).toBe(false);
  });

  it("hides index blobs from other accounts", async () => {
    const { id, fileKey } = await createFile("private-idx.txt");
    await app.inject({
      method: "PUT",
      url: `/api/files/${id}/index`,
      headers: { ...authHeader(), "content-type": "application/octet-stream" },
      payload: Buffer.from(encryptBytes(utf8Encode("secret"), fileKey)),
    });
    const other = generateAccountKeys("someone else");
    const registered = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { email: "other-idx@example.com", loginKey: other.loginKey, keyAttributes: other.keyAttributes },
    });
    const got = await app.inject({
      method: "GET",
      url: `/api/files/${id}/index`,
      headers: { authorization: `Bearer ${registered.json().token as string}` },
    });
    expect(got.statusCode).toBe(404);
  });
});
