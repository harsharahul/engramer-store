import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import pg from "pg";
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
import { totpAt } from "../src/totp.js";

/**
 * Exercises the PostgreSQL metadata backend against a real server. Gated
 * behind ENGRAMER_TEST_PG (an admin connection string) so the default suite
 * needs no external services:
 *
 *   docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=pgtest postgres:17-alpine
 *   ENGRAMER_TEST_PG=postgres://postgres:pgtest@127.0.0.1:5432/postgres \
 *     pnpm --filter @engramer/server test
 *
 * A throwaway database is created per run and dropped afterwards. The flow
 * covers every route family plus the spots where the dialects genuinely
 * differ: identity columns, RETURNING, int8/numeric parsing, CASE WHEN
 * placeholders, the recursive folder CTE, upserts, and real transactions.
 */
const adminUrl = process.env.ENGRAMER_TEST_PG;

describe.skipIf(!adminUrl)("postgres metadata backend", () => {
  const dbName = `engramer_test_${Date.now()}`;
  let app: FastifyInstance;
  let dataDir: string;
  let keys: AccountKeys;
  let token: string;

  const auth = () => ({ authorization: `Bearer ${token}` });

  beforeAll(async () => {
    await ready();
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    await admin.end();
    const url = new URL(adminUrl!);
    url.pathname = `/${dbName}`;
    dataDir = mkdtempSync(join(tmpdir(), "engramer-pg-"));
    app = await buildApp({ dataDir, webDistDir: null, databaseUrl: url.toString() });
    keys = generateAccountKeys("a postgres test password");
  });

  afterAll(async () => {
    await app.close(); // ends the pool so the database can be dropped
    rmSync(dataDir, { recursive: true, force: true });
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.end();
  });

  it("runs the full product flow on postgres", async () => {
    // Register + login: identity column, RETURNING, digest comparison.
    const registered = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { email: "pg@example.com", loginKey: keys.loginKey, keyAttributes: keys.keyAttributes },
    });
    expect(registered.statusCode).toBe(201);
    token = registered.json().token as string;

    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "pg@example.com", loginKey: keys.loginKey },
    });
    expect(login.statusCode).toBe(200);

    // Folder tree + file: inserts, per-user seq, recursive CTE later.
    const rootFolder = await app.inject({
      method: "POST",
      url: "/api/folders",
      headers: auth(),
      payload: {
        encryptedKey: secretBoxSeal(generateKey(), keys.masterKey),
        encryptedMeta: encryptFileMetadata({ name: "root", mime: "", size: 0, mtime: 0 }, generateKey()),
      },
    });
    const rootId = rootFolder.json().id as string;
    const child = await app.inject({
      method: "POST",
      url: "/api/folders",
      headers: auth(),
      payload: {
        parentId: rootId,
        encryptedKey: secretBoxSeal(generateKey(), keys.masterKey),
        encryptedMeta: encryptFileMetadata({ name: "child", mime: "", size: 0, mtime: 0 }, generateKey()),
      },
    });
    const childId = child.json().id as string;

    const fileKey = generateKey();
    const content = utf8Encode("postgres content v1");
    const created = await app.inject({
      method: "POST",
      url: "/api/files",
      headers: auth(),
      payload: {
        folderId: childId,
        encryptedKey: secretBoxSeal(fileKey, keys.masterKey),
        encryptedMeta: encryptFileMetadata(
          { name: "pg.txt", mime: "text/plain", size: content.length, mtime: 0 },
          fileKey,
        ),
      },
    });
    const fileId = created.json().id as string;
    const upload = await app.inject({
      method: "PUT",
      url: `/api/files/${fileId}/data`,
      headers: { ...auth(), "content-type": "application/octet-stream" },
      payload: Buffer.from(encryptBytes(content, fileKey)),
    });
    expect(upload.statusCode).toBe(200);
    const download = await app.inject({ method: "GET", url: `/api/files/${fileId}/data`, headers: auth() });
    expect(decryptBytes(new Uint8Array(download.rawPayload), fileKey)).toEqual(content);

    // Patch: the CASE WHEN placeholder form must bind on postgres.
    const moved = await app.inject({
      method: "PATCH",
      url: `/api/files/${fileId}`,
      headers: auth(),
      payload: { folderId: rootId },
    });
    expect(moved.statusCode).toBe(200);
    expect(moved.json().folderId).toBe(rootId);

    // Delta sync: numbers must come back as numbers (int8 parser).
    const full = await app.inject({ method: "GET", url: "/api/sync?since=0", headers: auth() });
    const seq = full.json().seq as number;
    expect(typeof seq).toBe("number");
    expect(full.json().files).toHaveLength(1);
    const renamed = await app.inject({
      method: "PATCH",
      url: `/api/files/${fileId}`,
      headers: auth(),
      payload: { encryptedMeta: encryptFileMetadata({ name: "pg-renamed.txt", mime: "text/plain", size: content.length, mtime: 0 }, fileKey) },
    });
    expect(renamed.statusCode).toBe(200);
    const delta = await app.inject({ method: "GET", url: `/api/sync?since=${seq}`, headers: auth() });
    expect(delta.json().files).toHaveLength(1);
    expect(delta.json().folders).toHaveLength(0);

    // Versioning: real BEGIN/COMMIT transactions, snapshot + restore.
    const v2 = utf8Encode("postgres content v2");
    await app.inject({
      method: "PUT",
      url: `/api/files/${fileId}/data`,
      headers: { ...auth(), "content-type": "application/octet-stream" },
      payload: Buffer.from(encryptBytes(v2, fileKey)),
    });
    const versions = await app.inject({ method: "GET", url: `/api/files/${fileId}/versions`, headers: auth() });
    const versionList = versions.json().versions as Array<{ generation: number; size: number }>;
    expect(versionList).toHaveLength(1);
    expect(typeof versionList[0]!.size).toBe("number");
    const versionData = await app.inject({
      method: "GET",
      url: `/api/files/${fileId}/versions/${versionList[0]!.generation}/data`,
      headers: auth(),
    });
    expect(decryptBytes(new Uint8Array(versionData.rawPayload), fileKey)).toEqual(content);
    const restored = await app.inject({
      method: "POST",
      url: `/api/files/${fileId}/versions/${versionList[0]!.generation}/restore`,
      headers: auth(),
      payload: {
        encryptedMeta: encryptFileMetadata(
          { name: "pg-renamed.txt", mime: "text/plain", size: content.length, mtime: 0 },
          fileKey,
        ),
      },
    });
    expect(restored.statusCode).toBe(200);
    const reverted = await app.inject({ method: "GET", url: `/api/files/${fileId}/data`, headers: auth() });
    expect(decryptBytes(new Uint8Array(reverted.rawPayload), fileKey)).toEqual(content);

    // Quota accounting: numeric SUM must parse to a number.
    const user = await app.inject({ method: "GET", url: "/api/user", headers: auth() });
    expect(typeof user.json().usedBytes).toBe("number");
    expect(user.json().usedBytes).toBeGreaterThan(0);

    // Share with a download limit: the atomic claim must work on postgres.
    const share = await app.inject({
      method: "POST",
      url: "/api/shares",
      headers: auth(),
      payload: { fileId, maxDownloads: 1 },
    });
    const shareToken = share.json().token as string;
    const first = await app.inject({ method: "GET", url: `/api/public/${shareToken}/data` });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({ method: "GET", url: `/api/public/${shareToken}/data` });
    expect(second.statusCode).toBe(410);

    // File request: sealed upload accepted into the vault in one transaction.
    const requested = await app.inject({
      method: "POST",
      url: "/api/requests",
      headers: auth(),
      payload: { folderId: rootId, encryptedMeta: { ciphertext: "aGk", nonce: "aGk" } },
    });
    const requestToken = requested.json().token as string;
    const senderKey = generateKey();
    const senderMeta = encryptFileMetadata({ name: "sent.bin", mime: "application/octet-stream", size: 4, mtime: 0 }, senderKey);
    const info = await app.inject({ method: "GET", url: `/api/public/requests/${requestToken}` });
    expect(info.statusCode).toBe(200);
    const createdUpload = await app.inject({
      method: "POST",
      url: `/api/public/requests/${requestToken}/files`,
      payload: { sealedKey: "c2VhbGVk", encryptedMeta: senderMeta },
    });
    const uploadId = createdUpload.json().id as string;
    const sentBytes = await app.inject({
      method: "PUT",
      url: `/api/public/requests/${requestToken}/files/${uploadId}/data`,
      headers: { "content-type": "application/octet-stream" },
      payload: Buffer.from(encryptBytes(new Uint8Array([1, 2, 3, 4]), senderKey)),
    });
    expect(sentBytes.statusCode).toBe(200);
    const accepted = await app.inject({
      method: "POST",
      url: `/api/requests/uploads/${uploadId}/accept`,
      headers: auth(),
      payload: {
        encryptedKey: secretBoxSeal(senderKey, keys.masterKey),
        encryptedMeta: senderMeta,
      },
    });
    expect(accepted.statusCode).toBe(201);

    // Folder delete: the recursive CTE tombstones root + child, trashes files.
    const removedFolder = await app.inject({ method: "DELETE", url: `/api/folders/${rootId}`, headers: auth() });
    expect(removedFolder.statusCode).toBe(204);
    const afterDelete = await app.inject({ method: "GET", url: "/api/sync?since=0", headers: auth() });
    const folders = afterDelete.json().folders as Array<{ id: string; deleted: boolean }>;
    expect(folders.find((f) => f.id === rootId)?.deleted).toBe(true);
    expect(folders.find((f) => f.id === childId)?.deleted).toBe(true);

    // Delete forever: transactional purge.
    const gone = await app.inject({ method: "DELETE", url: `/api/trash/${fileId}`, headers: auth() });
    expect(gone.statusCode).toBe(204);

    // Throttle: shared, database-backed, kicks in after the free failures.
    let lastStatus = 0;
    for (let i = 0; i < 8; i++) {
      const bad = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { email: "pg@example.com", loginKey: "d3JvbmctcGFzc3dvcmQ" },
      });
      lastStatus = bad.statusCode;
      if (lastStatus === 429) {
        expect(bad.headers["retry-after"]).toBeDefined();
        break;
      }
    }
    expect(lastStatus).toBe(429);

    // Two-factor: enroll, confirm with a live code, complete a two-step login.
    const setup = await app.inject({ method: "POST", url: "/api/auth/totp/setup", headers: auth(), payload: {} });
    const secret = setup.json().secret as string;
    const confirm = await app.inject({
      method: "POST",
      url: "/api/auth/totp/confirm",
      headers: auth(),
      payload: { code: totpAt(secret, Date.now()) },
    });
    expect(confirm.statusCode).toBe(200);
    expect(confirm.json().recoveryCodes).toHaveLength(10);
  });

  it("shares a file account-to-account on postgres", async () => {
    // The dialect-sensitive spots: the membership upsert (ON CONFLICT DO
    // UPDATE), the three-way sync join, and per-member seq draws.
    const partnerKeys = generateAccountKeys("a second postgres password");
    const partnerRes = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        email: "pg-partner@example.com",
        loginKey: partnerKeys.loginKey,
        keyAttributes: partnerKeys.keyAttributes,
      },
    });
    expect(partnerRes.statusCode).toBe(201);
    const partnerToken = partnerRes.json().token as string;
    const partnerAuth = () => ({ authorization: `Bearer ${partnerToken}` });

    const fileKey = generateKey();
    const content = utf8Encode("shared across accounts on postgres");
    const created = await app.inject({
      method: "POST",
      url: "/api/files",
      headers: auth(),
      payload: {
        folderId: null,
        encryptedKey: secretBoxSeal(fileKey, keys.masterKey),
        encryptedMeta: encryptFileMetadata(
          { name: "pg-shared.docx", mime: "application/octet-stream", size: content.length, mtime: Date.now() },
          fileKey,
        ),
      },
    });
    const fileId = created.json().id as string;
    await app.inject({
      method: "PUT",
      url: `/api/files/${fileId}/data`,
      headers: { ...auth(), "content-type": "application/octet-stream" },
      payload: Buffer.from(encryptBytes(content, fileKey)),
    });

    const minted = await app.inject({
      method: "POST",
      url: "/api/collab/invites",
      headers: auth(),
      payload: { fileId, role: "editor" },
    });
    expect(minted.statusCode).toBe(201);
    const inviteToken = minted.json().token as string;
    const claimed = await app.inject({
      method: "POST",
      url: `/api/collab/invites/${inviteToken}/claim`,
      headers: partnerAuth(),
    });
    expect(claimed.statusCode).toBe(200);
    const invites = await app.inject({ method: "GET", url: "/api/collab/invites", headers: auth() });
    const entry = (invites.json().invites as Array<Record<string, unknown>>).find(
      (i) => i.token === inviteToken,
    )!;
    const { sealToPublicKey, openSealed } = await import("@engramer/crypto");
    const sealedKey = sealToPublicKey(fileKey, entry.claimantPublicKey as string);
    const granted = await app.inject({
      method: "POST",
      url: `/api/collab/invites/${inviteToken}/grant`,
      headers: auth(),
      payload: { sealedKey },
    });
    expect(granted.statusCode).toBe(201);

    const download = await app.inject({
      method: "GET",
      url: `/api/files/${fileId}/data`,
      headers: partnerAuth(),
    });
    expect(download.statusCode).toBe(200);
    const key = openSealed(sealedKey, partnerKeys.keyAttributes.publicKey, partnerKeys.privateKey);
    expect(decryptBytes(new Uint8Array(download.rawPayload), key)).toEqual(content);

    const sync = await app.inject({ method: "GET", url: "/api/sync?since=0", headers: partnerAuth() });
    const sharedRow = (sync.json().shared as Array<Record<string, unknown>>).find(
      (row) => row.id === fileId,
    )!;
    expect(sharedRow).toBeDefined();
    expect(sharedRow.role).toBe("editor");
    expect(sharedRow.revoked).toBe(false);
  });
});
