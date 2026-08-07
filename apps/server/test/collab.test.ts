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
  sealToPublicKey,
  openSealed,
  utf8Encode,
  type AccountKeys,
} from "@engramer/crypto";
import { buildApp } from "../src/app.js";

const QUOTA_BYTES = 512 * 1024;

interface TestAccount {
  keys: AccountKeys;
  token: string;
  email: string;
}

let app: FastifyInstance;
let dataDir: string;
let owner: TestAccount;
let recipient: TestAccount;
let stranger: TestAccount;

const auth = (account: TestAccount) => ({ authorization: `Bearer ${account.token}` });

/** The one body every dead, foreign, spent or fictional token answers with. */
const NOT_AVAILABLE = { error: "this invitation is no longer available" };

async function register(email: string, phrase: string): Promise<TestAccount> {
  const keys = generateAccountKeys(phrase);
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { email, loginKey: keys.loginKey, keyAttributes: keys.keyAttributes },
  });
  expect(response.statusCode).toBe(201);
  return { keys, token: response.json().token as string, email };
}

async function uploadFile(account: TestAccount, name: string, content: Uint8Array) {
  const fileKey = generateKey();
  const created = await app.inject({
    method: "POST",
    url: "/api/files",
    headers: auth(account),
    payload: {
      folderId: null,
      encryptedKey: secretBoxSeal(fileKey, account.keys.masterKey),
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
    headers: { ...auth(account), "content-type": "application/octet-stream" },
    payload: Buffer.from(encryptBytes(content, fileKey)),
  });
  expect(uploaded.statusCode).toBe(200);
  return { id, fileKey, content };
}

/** Mint -> claim -> grant, returning what the recipient needs. */
async function shareWith(
  target: TestAccount,
  fileId: string,
  fileKey: Uint8Array,
  role: "viewer" | "editor",
) {
  const minted = await app.inject({
    method: "POST",
    url: "/api/collab/invites",
    headers: auth(owner),
    payload: { fileId, role },
  });
  expect(minted.statusCode).toBe(201);
  const token = minted.json().token as string;
  const claimed = await app.inject({
    method: "POST",
    url: `/api/collab/invites/${token}/claim`,
    headers: auth(target),
  });
  expect(claimed.statusCode).toBe(200);
  const list = await app.inject({ method: "GET", url: "/api/collab/invites", headers: auth(owner) });
  const entry = (list.json().invites as Array<Record<string, unknown>>).find(
    (i) => i.token === token,
  )!;
  expect(entry).toBeDefined();
  const sealedKey = sealToPublicKey(fileKey, entry.claimantPublicKey as string);
  const granted = await app.inject({
    method: "POST",
    url: `/api/collab/invites/${token}/grant`,
    headers: auth(owner),
    payload: { sealedKey },
  });
  expect(granted.statusCode).toBe(201);
  return { token, sealedKey };
}

beforeAll(async () => {
  await ready();
  dataDir = mkdtempSync(join(tmpdir(), "engramer-collab-test-"));
  app = await buildApp({ dataDir, quotaBytes: QUOTA_BYTES, webDistDir: null });
  owner = await register("owner@example.com", "orchid lantern velvet");
  recipient = await register("recipient@example.com", "cedar mosaic thimble");
  stranger = await register("stranger@example.com", "quartz bellows meadow");
});

afterAll(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("invite lifecycle", () => {
  it("mint, claim, grant: the collaborator downloads and decrypts the file", async () => {
    const content = utf8Encode("the shared document body");
    const file = await uploadFile(owner, "shared.docx", content);
    const { sealedKey } = await shareWith(recipient, file.id, file.fileKey, "editor");

    const got = await app.inject({
      method: "GET",
      url: `/api/files/${file.id}/data`,
      headers: auth(recipient),
    });
    expect(got.statusCode).toBe(200);
    const key = openSealed(
      sealedKey,
      recipient.keys.keyAttributes.publicKey,
      recipient.keys.privateKey,
    );
    expect(decryptBytes(new Uint8Array(got.rawPayload), key)).toEqual(content);
  });

  it("tells the claimant who is sharing and at what role, and nothing about the file", async () => {
    const file = await uploadFile(owner, "quiet.docx", utf8Encode("x"));
    const minted = await app.inject({
      method: "POST",
      url: "/api/collab/invites",
      headers: auth(owner),
      payload: { fileId: file.id, role: "viewer" },
    });
    const token = minted.json().token as string;
    const claimed = await app.inject({
      method: "POST",
      url: `/api/collab/invites/${token}/claim`,
      headers: auth(recipient),
    });
    expect(claimed.statusCode).toBe(200);
    expect(claimed.json()).toEqual({ ownerEmail: owner.email, role: "viewer" });
  });

  it("answers every bad token with one identical body", async () => {
    const file = await uploadFile(owner, "tokens.docx", utf8Encode("x"));
    const minted = await app.inject({
      method: "POST",
      url: "/api/collab/invites",
      headers: auth(owner),
      payload: { fileId: file.id, role: "viewer" },
    });
    const revokedToken = minted.json().token as string;
    await app.inject({
      method: "DELETE",
      url: `/api/collab/invites/${revokedToken}`,
      headers: auth(owner),
    });

    for (const token of ["does-not-exist", revokedToken]) {
      const response = await app.inject({
        method: "POST",
        url: `/api/collab/invites/${token}/claim`,
        headers: auth(recipient),
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual(NOT_AVAILABLE);
    }
  });

  it("refuses a second claim of a claimed invite, with the same body", async () => {
    const file = await uploadFile(owner, "double.docx", utf8Encode("x"));
    const minted = await app.inject({
      method: "POST",
      url: "/api/collab/invites",
      headers: auth(owner),
      payload: { fileId: file.id, role: "viewer" },
    });
    const token = minted.json().token as string;
    const first = await app.inject({
      method: "POST",
      url: `/api/collab/invites/${token}/claim`,
      headers: auth(recipient),
    });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({
      method: "POST",
      url: `/api/collab/invites/${token}/claim`,
      headers: auth(stranger),
    });
    expect(second.statusCode).toBe(404);
    expect(second.json()).toEqual(NOT_AVAILABLE);
  });

  it("never lets a non-owner mint an invite for someone else's file", async () => {
    const file = await uploadFile(owner, "mine.docx", utf8Encode("x"));
    const minted = await app.inject({
      method: "POST",
      url: "/api/collab/invites",
      headers: auth(stranger),
      payload: { fileId: file.id, role: "editor" },
    });
    expect(minted.statusCode).toBe(404);
  });
});

describe("collaborator access", () => {
  it("keeps every route a 404 for a signed-in stranger", async () => {
    const file = await uploadFile(owner, "private.docx", utf8Encode("secret"));
    await shareWith(recipient, file.id, file.fileKey, "viewer");
    for (const url of [
      `/api/files/${file.id}/data`,
      `/api/files/${file.id}/thumbnail`,
      `/api/files/${file.id}/index`,
      `/api/files/${file.id}/versions`,
    ]) {
      const response = await app.inject({ method: "GET", url, headers: auth(stranger) });
      expect([404, 403]).toContain(response.statusCode);
      expect(response.statusCode).toBe(404);
    }
  });

  it("lets a viewer read but refuses their writes", async () => {
    const content = utf8Encode("viewer bytes");
    const file = await uploadFile(owner, "readonly.docx", content);
    const { sealedKey } = await shareWith(recipient, file.id, file.fileKey, "viewer");
    const read = await app.inject({
      method: "GET",
      url: `/api/files/${file.id}/data`,
      headers: auth(recipient),
    });
    expect(read.statusCode).toBe(200);
    const key = openSealed(
      sealedKey,
      recipient.keys.keyAttributes.publicKey,
      recipient.keys.privateKey,
    );
    const write = await app.inject({
      method: "PUT",
      url: `/api/files/${file.id}/data`,
      headers: { ...auth(recipient), "content-type": "application/octet-stream" },
      payload: Buffer.from(encryptBytes(utf8Encode("overwritten"), key)),
    });
    expect(write.statusCode).toBe(403);
  });

  it("lets an editor write, and the bytes land on the owner's quota", async () => {
    const file = await uploadFile(owner, "editable.docx", utf8Encode("v1"));
    const { sealedKey } = await shareWith(recipient, file.id, file.fileKey, "editor");
    const key = openSealed(
      sealedKey,
      recipient.keys.keyAttributes.publicKey,
      recipient.keys.privateKey,
    );
    const before = await app.inject({ method: "GET", url: "/api/user", headers: auth(recipient) });
    const editorUsedBefore = before.json().usedBytes as number;

    const write = await app.inject({
      method: "PUT",
      url: `/api/files/${file.id}/data`,
      headers: { ...auth(recipient), "content-type": "application/octet-stream" },
      payload: Buffer.from(encryptBytes(utf8Encode("v2 by the editor"), key)),
    });
    expect(write.statusCode).toBe(200);

    const after = await app.inject({ method: "GET", url: "/api/user", headers: auth(recipient) });
    expect(after.json().usedBytes as number).toBe(editorUsedBefore);
    const read = await app.inject({
      method: "GET",
      url: `/api/files/${file.id}/data`,
      headers: auth(owner),
    });
    expect(decryptBytes(new Uint8Array(read.rawPayload), key)).toEqual(
      utf8Encode("v2 by the editor"),
    );
  });

  it("refuses an editor moving the file or touching owner-only routes", async () => {
    const file = await uploadFile(owner, "anchored.docx", utf8Encode("x"));
    const { sealedKey } = await shareWith(recipient, file.id, file.fileKey, "editor");
    const key = openSealed(
      sealedKey,
      recipient.keys.keyAttributes.publicKey,
      recipient.keys.privateKey,
    );
    const move = await app.inject({
      method: "PATCH",
      url: `/api/files/${file.id}`,
      headers: auth(recipient),
      payload: { folderId: null },
    });
    expect(move.statusCode).toBe(403);
    const metaPatch = await app.inject({
      method: "PATCH",
      url: `/api/files/${file.id}`,
      headers: auth(recipient),
      payload: {
        encryptedMeta: encryptFileMetadata(
          { name: "renamed by editor", mime: "application/octet-stream", size: 1, mtime: 1 },
          key,
        ),
      },
    });
    expect(metaPatch.statusCode).toBe(200);
    const trash = await app.inject({
      method: "DELETE",
      url: `/api/files/${file.id}`,
      headers: auth(recipient),
    });
    expect(trash.statusCode).toBe(403);
    const share = await app.inject({
      method: "POST",
      url: "/api/shares",
      headers: auth(recipient),
      payload: { fileId: file.id },
    });
    expect(share.statusCode).toBe(404);
  });

  it("revoking a collaborator makes every route a 404 for them immediately", async () => {
    const file = await uploadFile(owner, "revocable.docx", utf8Encode("x"));
    await shareWith(recipient, file.id, file.fileKey, "editor");
    const collaborators = await app.inject({
      method: "GET",
      url: `/api/collab/files/${file.id}/collaborators`,
      headers: auth(owner),
    });
    const uid = (collaborators.json().collaborators as Array<{ userId: number }>)[0]!.userId;
    const revoked = await app.inject({
      method: "DELETE",
      url: `/api/collab/files/${file.id}/collaborators/${uid}`,
      headers: auth(owner),
    });
    expect(revoked.statusCode).toBe(204);
    const read = await app.inject({
      method: "GET",
      url: `/api/files/${file.id}/data`,
      headers: auth(recipient),
    });
    expect(read.statusCode).toBe(404);
  });
});

/**
 * The riskiest surface of the feature: a bug here does not error, it
 * silently hides a file from a vault or duplicates one into it. Shared
 * rows ride the recipient's own cursor so one /api/sync call serves.
 */
describe("shared rows in sync", () => {
  it("delivers a granted share through the recipient's own cursor, without the owner's wrapped key", async () => {
    const content = utf8Encode("synced body");
    const file = await uploadFile(owner, "synced.docx", content);
    const { sealedKey } = await shareWith(recipient, file.id, file.fileKey, "editor");

    const sync = await app.inject({ method: "GET", url: "/api/sync?since=0", headers: auth(recipient) });
    expect(sync.statusCode).toBe(200);
    const shared = (sync.json().shared as Array<Record<string, unknown>>).find(
      (row) => row.id === file.id,
    )!;
    expect(shared).toBeDefined();
    expect(shared.encryptedKey).toBeUndefined();
    expect(shared.folderId).toBeNull();
    expect(shared.ownerEmail).toBe(owner.email);
    expect(shared.role).toBe("editor");
    expect(shared.revoked).toBe(false);
    expect(shared.sealedKey).toBe(sealedKey);
    const key = openSealed(
      shared.sealedKey as string,
      recipient.keys.keyAttributes.publicKey,
      recipient.keys.privateKey,
    );
    expect(key).toEqual(file.fileKey);
  });

  it("advances the member's cursor when the owner writes, so the change syncs", async () => {
    const file = await uploadFile(owner, "advancing.docx", utf8Encode("v1"));
    await shareWith(recipient, file.id, file.fileKey, "viewer");
    const first = await app.inject({ method: "GET", url: "/api/sync?since=0", headers: auth(recipient) });
    const cursor = first.json().seq as number;

    const write = await app.inject({
      method: "PUT",
      url: `/api/files/${file.id}/data`,
      headers: { ...auth(owner), "content-type": "application/octet-stream" },
      payload: Buffer.from(encryptBytes(utf8Encode("v2"), file.fileKey)),
    });
    expect(write.statusCode).toBe(200);

    const second = await app.inject({
      method: "GET",
      url: `/api/sync?since=${cursor}`,
      headers: auth(recipient),
    });
    const rows = second.json().shared as Array<Record<string, unknown>>;
    expect(rows.some((row) => row.id === file.id)).toBe(true);
  });

  it("tombstones on trash, returns on restore", async () => {
    const file = await uploadFile(owner, "trashable.docx", utf8Encode("x"));
    await shareWith(recipient, file.id, file.fileKey, "viewer");
    const cursor = (
      await app.inject({ method: "GET", url: "/api/sync?since=0", headers: auth(recipient) })
    ).json().seq as number;

    await app.inject({ method: "DELETE", url: `/api/files/${file.id}`, headers: auth(owner) });
    const afterTrash = await app.inject({
      method: "GET",
      url: `/api/sync?since=${cursor}`,
      headers: auth(recipient),
    });
    const trashedRow = (afterTrash.json().shared as Array<Record<string, unknown>>).find(
      (row) => row.id === file.id,
    )!;
    expect(trashedRow).toBeDefined();
    expect(trashedRow.revoked).toBe(true);

    const cursor2 = afterTrash.json().seq as number;
    await app.inject({ method: "POST", url: `/api/trash/${file.id}/restore`, headers: auth(owner) });
    const afterRestore = await app.inject({
      method: "GET",
      url: `/api/sync?since=${cursor2}`,
      headers: auth(recipient),
    });
    const restoredRow = (afterRestore.json().shared as Array<Record<string, unknown>>).find(
      (row) => row.id === file.id,
    )!;
    expect(restoredRow).toBeDefined();
    expect(restoredRow.revoked).toBe(false);
  });

  it("tombstones on revocation and on delete forever", async () => {
    const file = await uploadFile(owner, "gone.docx", utf8Encode("x"));
    await shareWith(recipient, file.id, file.fileKey, "viewer");
    const cursor = (
      await app.inject({ method: "GET", url: "/api/sync?since=0", headers: auth(recipient) })
    ).json().seq as number;

    const members = await app.inject({
      method: "GET",
      url: `/api/collab/files/${file.id}/collaborators`,
      headers: auth(owner),
    });
    const uid = (members.json().collaborators as Array<{ userId: number }>)[0]!.userId;
    await app.inject({
      method: "DELETE",
      url: `/api/collab/files/${file.id}/collaborators/${uid}`,
      headers: auth(owner),
    });
    const afterRevoke = await app.inject({
      method: "GET",
      url: `/api/sync?since=${cursor}`,
      headers: auth(recipient),
    });
    const revokedRow = (afterRevoke.json().shared as Array<Record<string, unknown>>).find(
      (row) => row.id === file.id,
    )!;
    expect(revokedRow).toBeDefined();
    expect(revokedRow.revoked).toBe(true);
  });

  it("never leaks shared rows into a stranger's sync", async () => {
    const file = await uploadFile(owner, "leakproof.docx", utf8Encode("x"));
    await shareWith(recipient, file.id, file.fileKey, "viewer");
    const sync = await app.inject({ method: "GET", url: "/api/sync?since=0", headers: auth(stranger) });
    const rows = (sync.json().shared ?? []) as Array<Record<string, unknown>>;
    expect(rows.every((row) => row.id !== file.id)).toBe(true);
  });
});
