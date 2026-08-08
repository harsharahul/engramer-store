import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ready,
  generateAccountKeys,
  generateKey,
  unlockWithPassword,
  secretBoxSeal,
  secretBoxOpen,
  encryptBytes,
  decryptBytes,
  encryptFileMetadata,
  decryptFileMetadata,
  encryptFolderMetadata,
  fromB64,
  toB64,
  utf8Encode,
  type AccountKeys,
  type SecretBox,
} from "@engramer/crypto";
import { buildApp } from "../src/app.js";

const QUOTA_BYTES = 512 * 1024;

let app: FastifyInstance;
let dataDir: string;
let account: AccountKeys;
let token: string;

const authHeader = () => ({ authorization: `Bearer ${token}` });

async function registerAccount(email: string, password: string) {
  const keys = generateAccountKeys(password);
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { email, loginKey: keys.loginKey, keyAttributes: keys.keyAttributes },
  });
  expect(response.statusCode).toBe(201);
  return { keys, token: response.json().token as string };
}

interface UploadedFile {
  id: string;
  fileKey: Uint8Array;
  content: Uint8Array;
}

async function uploadFile(
  name: string,
  content: Uint8Array,
  folderId: string | null = null,
): Promise<UploadedFile> {
  const fileKey = generateKey();
  const meta = encryptFileMetadata(
    { name, mime: "application/octet-stream", size: content.length, mtime: Date.now() },
    fileKey,
  );
  const created = await app.inject({
    method: "POST",
    url: "/api/files",
    headers: authHeader(),
    payload: {
      folderId,
      encryptedKey: secretBoxSeal(fileKey, account.masterKey),
      encryptedMeta: meta,
    },
  });
  expect(created.statusCode).toBe(201);
  const id = created.json().id as string;
  const uploaded = await app.inject({
    method: "PUT",
    url: `/api/files/${id}/data`,
    headers: { ...authHeader(), "content-type": "application/octet-stream" },
    payload: Buffer.from(encryptBytes(content, fileKey)),
  });
  expect(uploaded.statusCode).toBe(200);
  return { id, fileKey, content };
}

beforeAll(async () => {
  await ready();
  dataDir = mkdtempSync(join(tmpdir(), "engramer-test-"));
  app = await buildApp({ dataDir, quotaBytes: QUOTA_BYTES, webDistDir: null });
  const registered = await registerAccount("alice@example.com", "correct horse battery staple");
  account = registered.keys;
  token = registered.token;
});

afterAll(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("auth", () => {
  it("rejects duplicate registration", async () => {
    const keys = generateAccountKeys("another password");
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        email: "alice@example.com",
        loginKey: keys.loginKey,
        keyAttributes: keys.keyAttributes,
      },
    });
    expect(response.statusCode).toBe(409);
  });

  it("serves KDF attributes for the login ceremony", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/auth/attributes?email=alice@example.com",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().kdf).toEqual(account.keyAttributes.kdf);
  });

  it("rejects a wrong login key", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "alice@example.com", loginKey: toB64(generateKey()) },
    });
    expect(response.statusCode).toBe(401);
  });

  it("logs in and the client can unlock the master key end to end", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "alice@example.com", loginKey: account.loginKey },
    });
    expect(response.statusCode).toBe(200);
    const unlocked = unlockWithPassword(
      "correct horse battery staple",
      response.json().keyAttributes,
    );
    expect(unlocked.masterKey).toEqual(account.masterKey);
  });

  it("requires authentication on storage routes", async () => {
    const response = await app.inject({ method: "GET", url: "/api/sync" });
    expect(response.statusCode).toBe(401);
  });
});

describe("files and folders", () => {
  it("round-trips an encrypted file through upload and download", async () => {
    const content = crypto.getRandomValues(new Uint8Array(9000));
    const file = await uploadFile("roundtrip.bin", content);

    const download = await app.inject({
      method: "GET",
      url: `/api/files/${file.id}/data`,
      headers: authHeader(),
    });
    expect(download.statusCode).toBe(200);
    const decrypted = decryptBytes(new Uint8Array(download.rawPayload), file.fileKey);
    expect(decrypted).toEqual(content);
  });

  it("replaces blob content in place for in-app edits", async () => {
    const file = await uploadFile("note.md", utf8Encode("first draft"));
    const revised = utf8Encode("second draft, revised in the editor");
    const replaced = await app.inject({
      method: "PUT",
      url: `/api/files/${file.id}/data`,
      headers: { ...authHeader(), "content-type": "application/octet-stream" },
      payload: Buffer.from(encryptBytes(revised, file.fileKey)),
    });
    expect(replaced.statusCode).toBe(200);

    const download = await app.inject({
      method: "GET",
      url: `/api/files/${file.id}/data`,
      headers: authHeader(),
    });
    expect(decryptBytes(new Uint8Array(download.rawPayload), file.fileKey)).toEqual(revised);
  });

  it("stores only ciphertext on disk", async () => {
    const marker = "MARKER-plaintext-should-never-appear";
    const file = await uploadFile("secret.txt", utf8Encode(`${marker} content`));
    const blob = readFileSync(join(dataDir, "blobs", file.id));
    expect(blob.includes(Buffer.from(marker))).toBe(false);
  });

  it("organizes files in folders and syncs metadata that decrypts correctly", async () => {
    const folderKey = generateKey();
    const folderResponse = await app.inject({
      method: "POST",
      url: "/api/folders",
      headers: authHeader(),
      payload: {
        encryptedKey: secretBoxSeal(folderKey, account.masterKey),
        encryptedMeta: encryptFolderMetadata({ name: "Documents" }, folderKey),
      },
    });
    expect(folderResponse.statusCode).toBe(201);
    const folderId = folderResponse.json().id as string;

    const file = await uploadFile("in-folder.txt", utf8Encode("filed away"), folderId);

    const sync = await app.inject({ method: "GET", url: "/api/sync", headers: authHeader() });
    const body = sync.json();
    const syncedFile = body.files.find((f: { id: string }) => f.id === file.id);
    expect(syncedFile.folderId).toBe(folderId);
    const fileKey = secretBoxOpen(syncedFile.encryptedKey as SecretBox, account.masterKey);
    const meta = decryptFileMetadata(syncedFile.encryptedMeta as SecretBox, fileKey);
    expect(meta.name).toBe("in-folder.txt");
  });

  it("paged sync drains to the same rows an unpaged sync returns", async () => {
    const before = await app.inject({ method: "GET", url: "/api/sync", headers: authHeader() });
    const cursor = before.json().seq as number;

    const made: string[] = [];
    for (let i = 0; i < 5; i++) {
      made.push((await uploadFile(`paged-${i}.txt`, utf8Encode(`page ${i}`))).id);
    }

    const whole = await app.inject({
      method: "GET",
      url: `/api/sync?since=${cursor}`,
      headers: authHeader(),
    });
    const wholeIds = (whole.json().files as Array<{ id: string }>).map((f) => f.id);

    const drained: string[] = [];
    let at = cursor;
    for (let hops = 0; hops < 20; hops++) {
      const page = await app.inject({
        method: "GET",
        url: `/api/sync?since=${at}&limit=2`,
        headers: authHeader(),
      });
      const body = page.json() as { seq: number; files: Array<{ id: string }> };
      expect(body.files.length).toBeLessThanOrEqual(2);
      drained.push(...body.files.map((f) => f.id));
      if (body.seq === at) {
        break;
      }
      at = body.seq;
    }

    // Same rows, same order, none lost, none duplicated.
    expect(drained).toEqual(wholeIds);
    for (const id of made) {
      expect(drained).toContain(id);
    }
  });

  it("delta sync returns only changes after the cursor", async () => {
    const before = await app.inject({ method: "GET", url: "/api/sync", headers: authHeader() });
    const cursor = before.json().seq as number;

    const file = await uploadFile("delta.txt", utf8Encode("delta"));
    const after = await app.inject({
      method: "GET",
      url: `/api/sync?since=${cursor}`,
      headers: authHeader(),
    });
    const changed = after.json().files as Array<{ id: string }>;
    expect(changed.some((f) => f.id === file.id)).toBe(true);
    expect(changed.every((f) => f.id === file.id)).toBe(true);
  });

  it("refuses to move a folder into its own subtree", async () => {
    const makeFolder = async (parentId: string | null) => {
      const key = generateKey();
      const response = await app.inject({
        method: "POST",
        url: "/api/folders",
        headers: authHeader(),
        payload: {
          parentId,
          encryptedKey: secretBoxSeal(key, account.masterKey),
          encryptedMeta: encryptFolderMetadata({ name: "nested" }, key),
        },
      });
      return response.json().id as string;
    };
    const parent = await makeFolder(null);
    const child = await makeFolder(parent);
    const response = await app.inject({
      method: "PATCH",
      url: `/api/folders/${parent}`,
      headers: authHeader(),
      payload: { parentId: child },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe("trash", () => {
  it("trashes, restores, and permanently deletes", async () => {
    const file = await uploadFile("disposable.txt", utf8Encode("to be deleted"));

    expect(
      (await app.inject({ method: "DELETE", url: `/api/files/${file.id}`, headers: authHeader() }))
        .statusCode,
    ).toBe(204);

    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/trash/${file.id}/restore`,
          headers: authHeader(),
        })
      ).statusCode,
    ).toBe(204);

    await app.inject({ method: "DELETE", url: `/api/files/${file.id}`, headers: authHeader() });
    expect(
      (await app.inject({ method: "DELETE", url: `/api/trash/${file.id}`, headers: authHeader() }))
        .statusCode,
    ).toBe(204);

    const download = await app.inject({
      method: "GET",
      url: `/api/files/${file.id}/data`,
      headers: authHeader(),
    });
    expect(download.statusCode).toBe(404);
  });
});

describe("public share links", () => {
  it("serves encrypted data to link holders and revokes cleanly", async () => {
    const content = utf8Encode("shared secret document");
    const file = await uploadFile("shared.txt", content);

    const share = await app.inject({
      method: "POST",
      url: "/api/shares",
      headers: authHeader(),
      payload: { fileId: file.id },
    });
    expect(share.statusCode).toBe(201);
    const shareToken = share.json().token as string;

    // No authentication: only the token, as a link recipient would have.
    const meta = await app.inject({ method: "GET", url: `/api/public/${shareToken}/meta` });
    expect(meta.statusCode).toBe(200);
    const decryptedMeta = decryptFileMetadata(meta.json().encryptedMeta, file.fileKey);
    expect(decryptedMeta.name).toBe("shared.txt");

    const data = await app.inject({ method: "GET", url: `/api/public/${shareToken}/data` });
    expect(decryptBytes(new Uint8Array(data.rawPayload), file.fileKey)).toEqual(content);

    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/shares/${shareToken}`,
          headers: authHeader(),
        })
      ).statusCode,
    ).toBe(204);
    expect(
      (await app.inject({ method: "GET", url: `/api/public/${shareToken}/meta` })).statusCode,
    ).toBe(404);
  });
});

describe("quota", () => {
  it("rejects uploads past the storage quota", async () => {
    const fileKey = generateKey();
    const created = await app.inject({
      method: "POST",
      url: "/api/files",
      headers: authHeader(),
      payload: {
        encryptedKey: secretBoxSeal(fileKey, account.masterKey),
        encryptedMeta: encryptFileMetadata(
          { name: "big.bin", mime: "application/octet-stream", size: QUOTA_BYTES, mtime: 0 },
          fileKey,
        ),
      },
    });
    const upload = await app.inject({
      method: "PUT",
      url: `/api/files/${created.json().id}/data`,
      headers: { ...authHeader(), "content-type": "application/octet-stream" },
      payload: Buffer.from(encryptBytes(new Uint8Array(QUOTA_BYTES), fileKey)),
    });
    expect(upload.statusCode).toBe(413);
  });

  it("reports usage", async () => {
    const response = await app.inject({ method: "GET", url: "/api/user", headers: authHeader() });
    const body = response.json();
    expect(body.email).toBe("alice@example.com");
    expect(body.quotaBytes).toBe(QUOTA_BYTES);
    expect(body.usedBytes).toBeGreaterThan(0);
  });
});

describe("isolation between accounts", () => {
  it("hides one user's files from another", async () => {
    const file = await uploadFile("private.txt", utf8Encode("alice only"));
    const bob = await registerAccount("bob@example.com", "a different password");
    const response = await app.inject({
      method: "GET",
      url: `/api/files/${file.id}/data`,
      headers: { authorization: `Bearer ${bob.token}` },
    });
    expect(response.statusCode).toBe(404);
  });
});
