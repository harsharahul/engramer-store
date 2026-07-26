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
  decryptBytes,
  encryptFileMetadata,
  decryptFileMetadata,
  encryptFolderMetadata,
  protectShareKey,
  deriveShareAccess,
  openShareKey,
  sealToPublicKey,
  openSealed,
  utf8Encode,
  type AccountKeys,
  type SecretBox,
  type KdfParams,
} from "@engramer/crypto";
import { buildApp } from "../src/app.js";

const QUOTA_BYTES = 512 * 1024;

let app: FastifyInstance;
let dataDir: string;
let account: AccountKeys;
let token: string;

const authHeader = () => ({ authorization: `Bearer ${token}` });

async function uploadFile(name: string, content: Uint8Array) {
  const fileKey = generateKey();
  const created = await app.inject({
    method: "POST",
    url: "/api/files",
    headers: authHeader(),
    payload: {
      folderId: null,
      encryptedKey: secretBoxSeal(fileKey, account.masterKey),
      encryptedMeta: encryptFileMetadata(
        { name, mime: "application/octet-stream", size: content.length, mtime: Date.now() },
        fileKey,
      ),
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
  dataDir = mkdtempSync(join(tmpdir(), "engramer-sharing-test-"));
  app = await buildApp({ dataDir, quotaBytes: QUOTA_BYTES, webDistDir: null });
  account = generateAccountKeys("orchid lantern velvet");
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: {
      email: "owner@example.com",
      loginKey: account.loginKey,
      keyAttributes: account.keyAttributes,
    },
  });
  expect(response.statusCode).toBe(201);
  token = response.json().token as string;
});

afterAll(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("share link expiry", () => {
  it("rejects an expiry in the past", async () => {
    const file = await uploadFile("expiring.bin", utf8Encode("soon gone"));
    const response = await app.inject({
      method: "POST",
      url: "/api/shares",
      headers: authHeader(),
      payload: { fileId: file.id, expiresAt: Date.now() - 1000 },
    });
    expect(response.statusCode).toBe(400);
  });

  it("serves until the expiry and 410s after", async () => {
    const file = await uploadFile("expiring2.bin", utf8Encode("short lived"));
    const created = await app.inject({
      method: "POST",
      url: "/api/shares",
      headers: authHeader(),
      payload: { fileId: file.id, expiresAt: Date.now() + 150 },
    });
    expect(created.statusCode).toBe(201);
    const shareToken = created.json().token as string;

    const before = await app.inject({ method: "GET", url: `/api/public/${shareToken}/meta` });
    expect(before.statusCode).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 200));
    const after = await app.inject({ method: "GET", url: `/api/public/${shareToken}/meta` });
    expect(after.statusCode).toBe(410);
    const data = await app.inject({ method: "GET", url: `/api/public/${shareToken}/data` });
    expect(data.statusCode).toBe(410);
  });
});

describe("share download limits", () => {
  it("enforces a one-time link atomically", async () => {
    const file = await uploadFile("once.bin", utf8Encode("read me once"));
    const created = await app.inject({
      method: "POST",
      url: "/api/shares",
      headers: authHeader(),
      payload: { fileId: file.id, maxDownloads: 1 },
    });
    const shareToken = created.json().token as string;

    const first = await app.inject({ method: "GET", url: `/api/public/${shareToken}/data` });
    expect(first.statusCode).toBe(200);
    expect(decryptBytes(new Uint8Array(first.rawPayload), file.fileKey)).toEqual(file.content);

    const second = await app.inject({ method: "GET", url: `/api/public/${shareToken}/data` });
    expect(second.statusCode).toBe(410);

    // The owner sees the exhausted counter in the share list.
    const list = await app.inject({ method: "GET", url: "/api/shares", headers: authHeader() });
    const entry = (list.json().shares as Array<{ token: string; downloadCount: number }>).find(
      (s) => s.token === shareToken,
    );
    expect(entry?.downloadCount).toBe(1);
  });
});

describe("password protected shares", () => {
  it("gates meta and data on the password and never stores the key in the clear", async () => {
    const file = await uploadFile("secret.bin", utf8Encode("password protected payload"));
    const protection = protectShareKey(file.fileKey, "hunter2 but stronger");

    const created = await app.inject({
      method: "POST",
      url: "/api/shares",
      headers: authHeader(),
      payload: {
        fileId: file.id,
        password: {
          digest: protection.accessKeyDigest,
          kdf: protection.kdf,
          wrappedKey: protection.wrappedKey,
        },
      },
    });
    expect(created.statusCode).toBe(201);
    const shareToken = created.json().token as string;

    // Without the password: only the KDF parameters come back.
    const closed = await app.inject({ method: "GET", url: `/api/public/${shareToken}/meta` });
    expect(closed.statusCode).toBe(200);
    expect(closed.json().protected).toBe(true);
    expect(closed.json().encryptedMeta).toBeUndefined();
    expect(closed.json().kdf).toBeTruthy();
    const kdf = closed.json().kdf as KdfParams;

    // Data is refused outright without proof.
    const blind = await app.inject({ method: "GET", url: `/api/public/${shareToken}/data` });
    expect(blind.statusCode).toBe(403);

    // A wrong password is rejected by digest, not by a failed decrypt.
    const wrong = deriveShareAccess("not the password", kdf);
    const denied = await app.inject({
      method: "GET",
      url: `/api/public/${shareToken}/meta`,
      headers: { "x-share-access": wrong.accessKey },
    });
    expect(denied.statusCode).toBe(403);

    // The right password unlocks meta, the wrapped key, and the ciphertext.
    const access = deriveShareAccess("hunter2 but stronger", kdf);
    const open = await app.inject({
      method: "GET",
      url: `/api/public/${shareToken}/meta`,
      headers: { "x-share-access": access.accessKey },
    });
    expect(open.statusCode).toBe(200);
    const wrappedKey = open.json().wrappedKey as SecretBox;
    const fileKey = openShareKey(wrappedKey, access);
    expect(Buffer.from(fileKey)).toEqual(Buffer.from(file.fileKey));
    const meta = decryptFileMetadata(open.json().encryptedMeta as SecretBox, fileKey);
    expect(meta.name).toBe("secret.bin");

    const data = await app.inject({
      method: "GET",
      url: `/api/public/${shareToken}/data`,
      headers: { "x-share-access": access.accessKey },
    });
    expect(data.statusCode).toBe(200);
    expect(decryptBytes(new Uint8Array(data.rawPayload), fileKey)).toEqual(file.content);
  });
});

describe("file requests", () => {
  const requestMetaKey = () => account.masterKey;

  async function createRequest(folderId: string | null = null, expiresAt?: number) {
    const response = await app.inject({
      method: "POST",
      url: "/api/requests",
      headers: authHeader(),
      payload: {
        folderId,
        encryptedMeta: secretBoxSeal(utf8Encode(JSON.stringify({ label: "Tax documents" })), requestMetaKey()),
        ...(expiresAt ? { expiresAt } : {}),
      },
    });
    expect(response.statusCode).toBe(201);
    return response.json().token as string;
  }

  /** What the public upload page does: encrypt locally, seal the key to the owner. */
  async function sendFile(requestToken: string, name: string, content: Uint8Array) {
    const info = await app.inject({ method: "GET", url: `/api/public/requests/${requestToken}` });
    expect(info.statusCode).toBe(200);
    const { publicKey } = info.json() as { publicKey: string };

    const fileKey = generateKey();
    const created = await app.inject({
      method: "POST",
      url: `/api/public/requests/${requestToken}/files`,
      payload: {
        sealedKey: sealToPublicKey(fileKey, publicKey),
        encryptedMeta: encryptFileMetadata(
          { name, mime: "text/plain", size: content.length, mtime: Date.now() },
          fileKey,
        ),
      },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;
    const uploaded = await app.inject({
      method: "PUT",
      url: `/api/public/requests/${requestToken}/files/${id}/data`,
      headers: { "content-type": "application/octet-stream" },
      payload: Buffer.from(encryptBytes(content, fileKey)),
    });
    expect(uploaded.statusCode).toBe(200);
    return { id, fileKey };
  }

  it("receives an end-to-end encrypted file and files it into the vault", async () => {
    // Destination folder for the request.
    const folderKey = generateKey();
    const folder = await app.inject({
      method: "POST",
      url: "/api/folders",
      headers: authHeader(),
      payload: {
        parentId: null,
        encryptedKey: secretBoxSeal(folderKey, account.masterKey),
        encryptedMeta: encryptFolderMetadata({ name: "Inbox" }, folderKey),
      },
    });
    const folderId = folder.json().id as string;

    const requestToken = await createRequest(folderId);
    const content = utf8Encode("a document from the outside world");
    await sendFile(requestToken, "from-bob.txt", content);

    // The owner sees the pending upload with counts.
    const listed = await app.inject({ method: "GET", url: "/api/requests", headers: authHeader() });
    const entry = (listed.json().requests as Array<{ token: string; received: number; pending: number }>).find(
      (r) => r.token === requestToken,
    );
    expect(entry).toMatchObject({ received: 1, pending: 1 });

    const uploads = await app.inject({
      method: "GET",
      url: "/api/requests/uploads",
      headers: authHeader(),
    });
    const upload = (uploads.json().uploads as Array<{
      id: string;
      sealedKey: string;
      encryptedMeta: SecretBox;
    }>)[0]!;

    // Owner unseals with the account key pair; nobody else can.
    const fileKey = openSealed(
      upload.sealedKey,
      account.keyAttributes.publicKey,
      account.privateKey,
    );
    const meta = decryptFileMetadata(upload.encryptedMeta, fileKey);
    expect(meta.name).toBe("from-bob.txt");

    // Accept: re-wrap under the master key; the blob becomes a normal file.
    const accepted = await app.inject({
      method: "POST",
      url: `/api/requests/uploads/${upload.id}/accept`,
      headers: authHeader(),
      payload: {
        encryptedKey: secretBoxSeal(fileKey, account.masterKey),
        encryptedMeta: encryptFileMetadata({ ...meta, category: "Documents" }, fileKey),
      },
    });
    expect(accepted.statusCode).toBe(201);
    expect(accepted.json().folderId).toBe(folderId);
    expect(accepted.json().uploaded).toBe(true);

    // The filed blob decrypts to what the sender sent.
    const download = await app.inject({
      method: "GET",
      url: `/api/files/${upload.id}/data`,
      headers: authHeader(),
    });
    expect(download.statusCode).toBe(200);
    expect(decryptBytes(new Uint8Array(download.rawPayload), fileKey)).toEqual(content);

    // Nothing left to ingest.
    const drained = await app.inject({
      method: "GET",
      url: "/api/requests/uploads",
      headers: authHeader(),
    });
    expect(drained.json().uploads).toHaveLength(0);
  });

  it("counts pending uploads against the owner's quota", async () => {
    const before = await app.inject({ method: "GET", url: "/api/user", headers: authHeader() });
    const usedBefore = before.json().usedBytes as number;

    const requestToken = await createRequest();
    await sendFile(requestToken, "pending.txt", utf8Encode("takes up space immediately"));

    const after = await app.inject({ method: "GET", url: "/api/user", headers: authHeader() });
    expect(after.json().usedBytes as number).toBeGreaterThan(usedBefore);
  });

  it("rejects uploads past the owner's quota", async () => {
    const requestToken = await createRequest();
    const info = await app.inject({ method: "GET", url: `/api/public/requests/${requestToken}` });
    const { publicKey, maxBytes } = info.json() as { publicKey: string; maxBytes: number };
    expect(maxBytes).toBeLessThanOrEqual(QUOTA_BYTES);

    const fileKey = generateKey();
    const big = new Uint8Array(QUOTA_BYTES + 1024);
    const created = await app.inject({
      method: "POST",
      url: `/api/public/requests/${requestToken}/files`,
      payload: {
        sealedKey: sealToPublicKey(fileKey, publicKey),
        encryptedMeta: encryptFileMetadata(
          { name: "big.bin", mime: "application/octet-stream", size: big.length, mtime: Date.now() },
          fileKey,
        ),
      },
    });
    const id = created.json().id as string;
    const uploaded = await app.inject({
      method: "PUT",
      url: `/api/public/requests/${requestToken}/files/${id}/data`,
      headers: { "content-type": "application/octet-stream" },
      payload: Buffer.from(encryptBytes(big, fileKey)),
    });
    expect(uploaded.statusCode).toBe(413);
  });

  it("discards an unwanted upload and frees its space", async () => {
    const requestToken = await createRequest();
    const { id } = await sendFile(requestToken, "unwanted.txt", utf8Encode("no thanks"));

    const before = await app.inject({ method: "GET", url: "/api/user", headers: authHeader() });
    const discarded = await app.inject({
      method: "DELETE",
      url: `/api/requests/uploads/${id}`,
      headers: authHeader(),
    });
    expect(discarded.statusCode).toBe(204);
    const after = await app.inject({ method: "GET", url: "/api/user", headers: authHeader() });
    expect(after.json().usedBytes as number).toBeLessThan(before.json().usedBytes as number);
  });

  it("stops accepting files once revoked or expired", async () => {
    const requestToken = await createRequest();
    const revoked = await app.inject({
      method: "DELETE",
      url: `/api/requests/${requestToken}`,
      headers: authHeader(),
    });
    expect(revoked.statusCode).toBe(204);
    const closed = await app.inject({ method: "GET", url: `/api/public/requests/${requestToken}` });
    expect(closed.statusCode).toBe(404);

    const expiring = await createRequest(null, Date.now() + 100);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const expired = await app.inject({ method: "GET", url: `/api/public/requests/${expiring}` });
    expect(expired.statusCode).toBe(410);
  });

  it("keeps request uploads invisible to other accounts", async () => {
    const requestToken = await createRequest();
    await sendFile(requestToken, "private.txt", utf8Encode("owner's eyes only"));

    const other = generateAccountKeys("a different password");
    const registered = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        email: "mallory@example.com",
        loginKey: other.loginKey,
        keyAttributes: other.keyAttributes,
      },
    });
    const otherToken = registered.json().token as string;
    const uploads = await app.inject({
      method: "GET",
      url: "/api/requests/uploads",
      headers: { authorization: `Bearer ${otherToken}` },
    });
    expect(uploads.json().uploads).toHaveLength(0);
  });
});
