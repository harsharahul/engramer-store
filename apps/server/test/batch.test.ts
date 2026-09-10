import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ready,
  generateAccountKeys,
  generateKey,
  secretBoxSeal,
  encryptBytes,
  encryptFileMetadata,
  encryptFolderMetadata,
  decryptFileMetadata,
  secretBoxOpen,
  sealToPublicKey,
  utf8Encode,
  type AccountKeys,
  type SecretBox,
} from "@engramer/crypto";
import { buildApp } from "../src/app.js";

/**
 * One request moves, trashes, restores, or re-labels many files at once.
 * The contract every consumer relies on is unchanged: each touched row
 * takes its own update_seq, so the delta sync every client and the Mac
 * index pull sees the batch exactly as it would have seen the single
 * writes, and the change feed announces the batch once.
 */

interface TestAccount {
  keys: AccountKeys;
  token: string;
  email: string;
  uid: number;
}

let app: FastifyInstance;
let dataDir: string;
let owner: TestAccount;
let other: TestAccount;

const auth = (account: TestAccount) => ({ authorization: `Bearer ${account.token}` });

async function register(email: string, phrase: string): Promise<TestAccount> {
  const keys = generateAccountKeys(phrase);
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { email, loginKey: keys.loginKey, keyAttributes: keys.keyAttributes },
  });
  expect(response.statusCode).toBe(201);
  const row = await app.db.get<{ id: number }>("SELECT id FROM users WHERE email = ?", email);
  return { keys, token: response.json().token as string, email, uid: row!.id };
}

async function uploadFile(account: TestAccount, name: string, folderId: string | null = null) {
  const fileKey = generateKey();
  const content = utf8Encode(`content of ${name}`);
  const created = await app.inject({
    method: "POST",
    url: "/api/files",
    headers: auth(account),
    payload: {
      folderId,
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
  return { id, fileKey };
}

async function createFolder(account: TestAccount, name: string): Promise<string> {
  const folderKey = generateKey();
  const response = await app.inject({
    method: "POST",
    url: "/api/folders",
    headers: auth(account),
    payload: {
      encryptedKey: secretBoxSeal(folderKey, account.keys.masterKey),
      encryptedMeta: encryptFolderMetadata({ name }, folderKey),
    },
  });
  expect(response.statusCode).toBe(201);
  return response.json().id as string;
}

/** Shares owner's file with `target` as an editor; returns nothing the test needs. */
async function shareAsEditor(fileId: string, fileKey: Uint8Array, target: TestAccount) {
  const minted = await app.inject({
    method: "POST",
    url: "/api/collab/invites",
    headers: auth(owner),
    payload: { fileId, role: "editor" },
  });
  expect(minted.statusCode).toBe(201);
  const token = minted.json().token as string;
  const claimed = await app.inject({
    method: "POST",
    url: `/api/collab/invites/${token}/claim`,
    headers: auth(target),
  });
  expect([200, 201]).toContain(claimed.statusCode);
  const list = await app.inject({ method: "GET", url: "/api/collab/invites", headers: auth(owner) });
  const entry = (list.json().invites as Array<Record<string, unknown>>).find((i) => i.token === token)!;
  const granted = await app.inject({
    method: "POST",
    url: `/api/collab/invites/${token}/grant`,
    headers: auth(owner),
    payload: { sealedKey: sealToPublicKey(fileKey, entry.claimantPublicKey as string) },
  });
  expect([200, 201]).toContain(granted.statusCode);
}

async function syncFor(account: TestAccount, since = 0) {
  const response = await app.inject({
    method: "GET",
    url: `/api/sync?since=${since}`,
    headers: auth(account),
  });
  expect(response.statusCode).toBe(200);
  return response.json() as {
    seq: number;
    files: Array<{ id: string; folderId: string | null; trashed: boolean; updateSeq: number; encryptedMeta: SecretBox; encryptedKey: SecretBox }>;
  };
}

/** Counts change-feed pokes for one account while `run` executes. */
async function pokesDuring(uid: number, run: () => Promise<void>): Promise<number> {
  const lines: string[] = [];
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(String(chunk));
      callback();
    },
  });
  const unsubscribe = app.seqEvents.subscribe(uid, sink);
  // Let any flush armed by setup writes land before counting.
  await new Promise((resolve) => setTimeout(resolve, 250));
  lines.length = 0;
  await run();
  await new Promise((resolve) => setTimeout(resolve, 400));
  unsubscribe();
  return lines.filter((line) => line.startsWith("data:")).length;
}

beforeAll(async () => {
  await ready();
  dataDir = mkdtempSync(join(tmpdir(), "engramer-batch-"));
  app = await buildApp({ dataDir, quotaBytes: 4 * 1024 * 1024, webDistDir: null });
  owner = await register("owner@example.com", "owner passphrase that is long");
  other = await register("other@example.com", "other passphrase that is long");
});

afterAll(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("POST /api/files/batch", () => {
  it("moves many files in one request, one seq each, one poke for all", async () => {
    const folder = await createFolder(owner, "Trip");
    const files = await Promise.all(["a.jpg", "b.jpg", "c.jpg"].map((n) => uploadFile(owner, n)));
    const before = (await syncFor(owner)).seq;

    let body: { results: Array<{ id: string; ok: boolean }>; files: Array<{ id: string; folderId: string | null }> } | null = null;
    const pokes = await pokesDuring(owner.uid, async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/files/batch",
        headers: auth(owner),
        payload: {
          action: "patch",
          items: files.map((f) => ({ id: f.id, folderId: folder })),
        },
      });
      expect(response.statusCode).toBe(200);
      body = response.json();
    });

    expect(body!.results.every((r) => r.ok)).toBe(true);
    expect(body!.files.map((f) => f.folderId)).toEqual([folder, folder, folder]);
    // The batch reads as one change to the feed, not three.
    expect(pokes).toBe(1);

    const delta = await syncFor(owner, before);
    const moved = delta.files.filter((f) => files.some((x) => x.id === f.id));
    expect(moved).toHaveLength(3);
    expect(moved.every((f) => f.folderId === folder)).toBe(true);
    const seqs = moved.map((f) => f.updateSeq).sort((a, b) => a - b);
    expect(new Set(seqs).size).toBe(3);
    expect(seqs[0]!).toBeGreaterThan(before);
    // The response rows decrypt like any sync row.
    const key = secretBoxOpen(delta.files.find((f) => f.id === files[0]!.id)!.encryptedKey, owner.keys.masterKey);
    expect(decryptFileMetadata(moved.find((f) => f.id === files[0]!.id)!.encryptedMeta, key).name).toBe("a.jpg");
  });

  it("answers per row for a mixed list: own file moves, a shared one is refused, an unknown is not found", async () => {
    const folder = await createFolder(owner, "Mixed");
    const mine = await uploadFile(owner, "mine.txt");
    const theirs = await uploadFile(other, "theirs.txt");
    // The same file, once shared with `other`, is visible to them but never movable.
    const shared = await uploadFile(owner, "shared.txt");
    await shareAsEditor(shared.id, shared.fileKey, other);
    const otherFolder = await createFolder(other, "Other's");

    const response = await app.inject({
      method: "POST",
      url: "/api/files/batch",
      headers: auth(other),
      payload: {
        action: "patch",
        items: [
          { id: theirs.id, folderId: otherFolder },
          { id: shared.id, folderId: otherFolder },
          { id: mine.id, folderId: otherFolder },
          { id: "00000000-0000-0000-0000-000000000000", folderId: otherFolder },
        ],
      },
    });
    expect(response.statusCode).toBe(200);
    const results = response.json().results as Array<{ id: string; ok: boolean; status?: number }>;
    expect(results.map((r) => [r.ok, r.status])).toEqual([
      [true, undefined],
      [false, 403],
      [false, 404],
      [false, 404],
    ]);
    const after = await syncFor(other);
    expect(after.files.find((f) => f.id === theirs.id)!.folderId).toBe(otherFolder);
    // The owner's file never moved.
    expect((await syncFor(owner)).files.find((f) => f.id === shared.id)!.folderId).toBeNull();
    void folder;
  });

  it("refuses a destination the caller does not own, and an oversized list", async () => {
    const mine = await uploadFile(owner, "stay.txt");
    const foreign = await createFolder(other, "Not yours");
    const refused = await app.inject({
      method: "POST",
      url: "/api/files/batch",
      headers: auth(owner),
      payload: { action: "patch", items: [{ id: mine.id, folderId: foreign }] },
    });
    expect(refused.statusCode).toBe(404);
    expect((await syncFor(owner)).files.find((f) => f.id === mine.id)!.folderId).toBeNull();

    const tooMany = await app.inject({
      method: "POST",
      url: "/api/files/batch",
      headers: auth(owner),
      payload: {
        action: "trash",
        ids: Array.from({ length: 501 }, (_, i) => `id-${i}`),
      },
    });
    expect(tooMany.statusCode).toBe(400);
  });

  it("re-labels many files with their own sealed metadata in one request", async () => {
    const files = await Promise.all(["x.txt", "y.txt"].map((n) => uploadFile(owner, n)));
    const items = files.map((f, i) => ({
      id: f.id,
      encryptedMeta: encryptFileMetadata(
        { name: `renamed-${i}.txt`, mime: "text/plain", size: 1, mtime: 1, favorite: true },
        f.fileKey,
      ),
    }));
    const response = await app.inject({
      method: "POST",
      url: "/api/files/batch",
      headers: auth(owner),
      payload: { action: "patch", items },
    });
    expect(response.statusCode).toBe(200);
    const rows = (await syncFor(owner)).files;
    for (const [i, f] of files.entries()) {
      const meta = decryptFileMetadata(rows.find((r) => r.id === f.id)!.encryptedMeta, f.fileKey);
      expect(meta.name).toBe(`renamed-${i}.txt`);
      expect(meta.favorite).toBe(true);
    }
  });

  it("trashes and restores many files at once, each with a fresh seq", async () => {
    const folder = await createFolder(owner, "Bin-bound");
    const files = await Promise.all(["t1.txt", "t2.txt"].map((n) => uploadFile(owner, n, folder)));
    const before = (await syncFor(owner)).seq;

    const trashed = await app.inject({
      method: "POST",
      url: "/api/files/batch",
      headers: auth(owner),
      payload: { action: "trash", ids: files.map((f) => f.id) },
    });
    expect(trashed.statusCode).toBe(200);
    expect((trashed.json().results as Array<{ ok: boolean }>).every((r) => r.ok)).toBe(true);
    const gone = (await syncFor(owner, before)).files.filter((f) => files.some((x) => x.id === f.id));
    expect(gone).toHaveLength(2);
    expect(gone.every((f) => f.trashed)).toBe(true);

    const mark = (await syncFor(owner)).seq;
    const restored = await app.inject({
      method: "POST",
      url: "/api/files/batch",
      headers: auth(owner),
      payload: { action: "restore", ids: [...files.map((f) => f.id), "not-in-trash"] },
    });
    expect(restored.statusCode).toBe(200);
    const results = restored.json().results as Array<{ ok: boolean; status?: number }>;
    expect(results.map((r) => r.ok)).toEqual([true, true, false]);
    expect(results[2]!.status).toBe(404);
    const back = (await syncFor(owner, mark)).files.filter((f) => files.some((x) => x.id === f.id));
    expect(back).toHaveLength(2);
    expect(back.every((f) => !f.trashed && f.folderId === folder)).toBe(true);
  });
});
