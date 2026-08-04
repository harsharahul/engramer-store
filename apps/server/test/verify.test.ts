import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ready,
  encryptBytes,
  encryptFileMetadata,
  generateAccountKeys,
  generateKey,
  secretBoxSeal,
  type AccountKeys,
} from "@engramer/crypto";
import { buildApp } from "../src/app.js";
import { blobKey } from "../src/blobs.js";
import { Readable } from "node:stream";

/**
 * Checking stored blobs without downloading them.
 *
 * The server cannot read these files, but it can tell whether what it holds
 * is still what it was handed. That is every way stored data goes wrong on
 * its own, and it costs the client nothing: a vault of any size is checked
 * over a list of ids rather than a terabyte of transfer.
 */
describe("verifying stored content", () => {
  let app: FastifyInstance;
  let dataDir: string;
  let token: string;
  let account: AccountKeys;

  const auth = () => ({ authorization: `Bearer ${token}` });

  const upload = async (content: Uint8Array): Promise<string> => {
    const fileKey = generateKey();
    const created = await app.inject({
      method: "POST",
      url: "/api/files",
      headers: auth(),
      payload: {
        folderId: null,
        encryptedKey: secretBoxSeal(fileKey, account.masterKey),
        encryptedMeta: encryptFileMetadata(
          { name: "f.bin", mime: "application/octet-stream", size: content.length, mtime: 1 },
          fileKey,
        ),
      },
    });
    const id = created.json().id as string;
    await app.inject({
      method: "PUT",
      url: `/api/files/${id}/data`,
      headers: { ...auth(), "content-type": "application/octet-stream" },
      payload: Buffer.from(encryptBytes(content, fileKey)),
    });
    return id;
  };

  const verify = async (ids: string[]) => {
    const response = await app.inject({
      method: "POST",
      url: "/api/files/verify",
      headers: auth(),
      payload: { ids },
    });
    return response.json().results as { id: string; verdict: string }[];
  };

  beforeAll(async () => {
    await ready();
    dataDir = mkdtempSync(join(tmpdir(), "engramer-verify-"));
    app = await buildApp({ dataDir, webDistDir: null });
    const keys = generateAccountKeys("a verify password");
    account = keys;
    const registered = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { email: "v@example.com", loginKey: keys.loginKey, keyAttributes: keys.keyAttributes },
    });
    token = registered.json().token as string;
  });

  afterAll(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("says a stored file is intact without reading a byte of it to the client", async () => {
    const id = await upload(new Uint8Array([1, 2, 3, 4, 5]));
    expect(await verify([id])).toEqual([{ id, verdict: "intact" }]);
  });

  it("notices when stored bytes are not what was written", async () => {
    const id = await upload(new Uint8Array(2048).fill(7));
    // Corruption the encryption cannot report until someone reads the file:
    // the object simply is not what it was.
    await app.blobs.put(blobKey(id, "data", 0), Readable.from(Buffer.alloc(2048, 9)), 1 << 20);
    expect(await verify([id])).toEqual([{ id, verdict: "changed" }]);
  });

  it("notices a truncated blob", async () => {
    const id = await upload(new Uint8Array(4096).fill(3));
    await app.blobs.put(blobKey(id, "data", 0), Readable.from(Buffer.alloc(10)), 1 << 20);
    expect(await verify([id])).toEqual([{ id, verdict: "changed" }]);
  });

  it("reports a blob that has gone missing rather than calling it intact", async () => {
    const id = await upload(new Uint8Array([9, 9, 9]));
    await app.blobs.remove(blobKey(id, "data", 0));
    expect(await verify([id])).toEqual([{ id, verdict: "unreadable" }]);
  });

  it("refuses to answer for someone else's files", async () => {
    const id = await upload(new Uint8Array([1]));
    const other = generateAccountKeys("another password");
    const registered = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { email: "w@example.com", loginKey: other.loginKey, keyAttributes: other.keyAttributes },
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/files/verify",
      headers: { authorization: `Bearer ${registered.json().token}` },
      payload: { ids: [id] },
    });
    expect(response.json().results).toEqual([{ id, verdict: "missing" }]);
  });

  it("bounds a request so one call cannot walk a whole vault", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/files/verify",
      headers: auth(),
      payload: { ids: Array.from({ length: 51 }, (_, i) => `id-${i}`) },
    });
    expect(response.statusCode).toBe(400);
  });
});
