import { decryptFileMetadata, encryptFileMetadata, ready, secretBoxOpen } from "@engramer/crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTarget, type Target } from "../helpers/target.js";
import { bearer, register } from "./accounts.js";
import { Feed } from "./feed.js";
import { createFile, createFolder, syncFor, type Account } from "./storage.js";

/**
 * One request moves, trashes, restores or re-labels many files. Each
 * touched row takes its own sequence, so a delta sync sees the batch as
 * it would have seen the single writes, and the change feed announces
 * the batch once, after it commits.
 */
let target: Target;
let alice: Account;
let bob: Account;

beforeAll(async () => {
  await ready();
  target = await startTarget();
  alice = await register(target, "alice@example.com");
  bob = await register(target, "bob@example.com");
});

afterAll(async () => {
  await target?.close();
});

const batch = (account: Account, payload: unknown) =>
  target.inject({ method: "POST", url: "/api/files/batch", headers: bearer(account.token), payload });

describe("a batch", () => {
  it("moves many files in one request, one sequence each, one poke for all", async () => {
    const folder = await createFolder(target, alice, "Trip");
    const files: Array<Awaited<ReturnType<typeof createFile>>> = [];
    for (const name of ["a.jpg", "b.jpg", "c.jpg"]) {
      files.push(await createFile(target, alice, name));
    }
    const before = (await syncFor(target, alice)).seq;
    const feed = await new Feed().open(target.baseUrl, alice.token);
    await feed.settle();

    const response = await batch(alice, { action: "patch", items: files.map((f) => ({ id: f.id, folderId: folder.id })) });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.results).toEqual(files.map((f) => ({ id: f.id, ok: true })));
    expect(body.files.map((f: { id: string }) => f.id)).toEqual(files.map((f) => f.id));
    expect(body.files.every((f: { folderId: string; hasCollaborators: boolean }) => f.folderId === folder.id && f.hasCollaborators === false)).toBe(true);

    const pokes = await feed.drain();
    feed.close();
    const delta = await syncFor(target, alice, before);
    expect(pokes).toEqual([{ seq: delta.seq }]);
    const moved = delta.files.filter((f) => files.some((x) => x.id === f.id));
    expect(moved).toHaveLength(3);
    expect(new Set(moved.map((f) => f.updateSeq)).size).toBe(3);
    expect(Math.min(...moved.map((f) => f.updateSeq))).toBeGreaterThan(before);
    const key = secretBoxOpen(moved[0]!.encryptedKey, alice.keys.masterKey);
    expect(decryptFileMetadata(moved[0]!.encryptedMeta, key).name).toBe(
      ["a.jpg", "b.jpg", "c.jpg"][files.findIndex((f) => f.id === moved[0]!.id)],
    );
  });

  it("answers per row: an own file moves, a missing or foreign one is not found", async () => {
    const folder = await createFolder(target, alice, "Mixed");
    const mine = await createFile(target, alice, "mine.txt");
    const theirs = await createFile(target, bob, "theirs.txt");
    const response = await batch(alice, {
      action: "patch",
      items: [
        { id: mine.id, folderId: folder.id },
        { id: theirs.id, folderId: folder.id },
        { id: "00000000-0000-4000-8000-000000000000", folderId: folder.id },
      ],
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().results).toEqual([
      { id: mine.id, ok: true },
      { id: theirs.id, ok: false, status: 404, error: "file not found" },
      { id: "00000000-0000-4000-8000-000000000000", ok: false, status: 404, error: "file not found" },
    ]);
    expect(response.json().files.map((f: { id: string }) => f.id)).toEqual([mine.id]);
    expect((await syncFor(target, bob)).files.find((f) => f.id === theirs.id)!.folderId).toBeNull();
  });

  it("refuses the whole request for a destination it cannot find", async () => {
    const mine = await createFile(target, alice, "stay.txt");
    const foreign = await createFolder(target, bob, "Not yours");
    const before = (await syncFor(target, alice)).seq;
    const response = await batch(alice, { action: "patch", items: [{ id: mine.id, folderId: foreign.id }] });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "destination folder not found" });
    expect((await syncFor(target, alice)).seq).toBe(before);
  });

  it("refuses an empty, oversized or unknown request opaquely", async () => {
    for (const payload of [
      { action: "trash", ids: [] },
      { action: "trash", ids: Array.from({ length: 501 }, (_, i) => `id-${i}`) },
      { action: "patch", items: Array.from({ length: 501 }, (_, i) => ({ id: `id-${i}` })) },
      { action: "shred", ids: ["x"] },
      { ids: ["x"] },
      { action: "patch", items: [{ folderId: null }] },
    ]) {
      const response = await batch(alice, payload);
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: "invalid request" });
    }
  });

  it("takes exactly the maximum", async () => {
    const response = await batch(alice, {
      action: "trash",
      ids: Array.from({ length: 500 }, (_, i) => `missing-${i}`),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().results).toHaveLength(500);
    expect(response.json().files).toEqual([]);
  });

  it("re-labels many files with their own sealed metadata", async () => {
    const files = [await createFile(target, alice, "x.txt"), await createFile(target, alice, "y.txt")];
    const response = await batch(alice, {
      action: "patch",
      items: files.map((f, i) => ({
        id: f.id,
        encryptedMeta: encryptFileMetadata(
          { name: `renamed-${i}.txt`, mime: "text/plain", size: 1, mtime: 1, favorite: true },
          f.key,
        ),
      })),
    });
    expect(response.statusCode).toBe(200);
    const rows = (await syncFor(target, alice)).files;
    for (const [i, f] of files.entries()) {
      const row = rows.find((r) => r.id === f.id)!;
      const meta = decryptFileMetadata(row.encryptedMeta, f.key);
      expect(meta.name).toBe(`renamed-${i}.txt`);
      expect(meta.favorite).toBe(true);
      expect(row.folderId).toBeNull();
    }
  });

  it("trashes and restores many files, each with a fresh sequence", async () => {
    const folder = await createFolder(target, alice, "Bin-bound");
    const files = [await createFile(target, alice, "t1.txt", folder.id), await createFile(target, alice, "t2.txt", folder.id)];
    const before = (await syncFor(target, alice)).seq;

    const trashed = await batch(alice, { action: "trash", ids: files.map((f) => f.id) });
    expect(trashed.statusCode).toBe(200);
    expect(trashed.json().results).toEqual(files.map((f) => ({ id: f.id, ok: true })));
    expect(trashed.json().files.every((f: { trashed: boolean }) => f.trashed)).toBe(true);
    const gone = (await syncFor(target, alice, before)).files.filter((f) => files.some((x) => x.id === f.id));
    expect(gone).toHaveLength(2);
    expect(gone.every((f) => f.trashed)).toBe(true);

    const mark = (await syncFor(target, alice)).seq;
    const restored = await batch(alice, { action: "restore", ids: [...files.map((f) => f.id), "not-in-trash"] });
    expect(restored.statusCode).toBe(200);
    expect(restored.json().results).toEqual([
      ...files.map((f) => ({ id: f.id, ok: true })),
      { id: "not-in-trash", ok: false, status: 404, error: "file not found in trash" },
    ]);
    const back = (await syncFor(target, alice, mark)).files.filter((f) => files.some((x) => x.id === f.id));
    expect(back).toHaveLength(2);
    expect(back.every((f) => !f.trashed && f.folderId === folder.id)).toBe(true);
  });

  it("restores to the root when the folder is gone, and refuses another account's file", async () => {
    const folder = await createFolder(target, alice, "Vanishing");
    const file = await createFile(target, alice, "left.txt", folder.id);
    const theirs = await createFile(target, bob, "bob.txt");
    await target.inject({ method: "DELETE", url: `/api/folders/${folder.id}`, headers: bearer(alice.token) });
    const trashed = await batch(alice, { action: "trash", ids: [theirs.id] });
    expect(trashed.json().results).toEqual([{ id: theirs.id, ok: false, status: 404, error: "file not found" }]);
    const restored = await batch(alice, { action: "restore", ids: [file.id] });
    expect(restored.json().files[0].folderId).toBeNull();
  });

  it("treats a repeated id as two writes", async () => {
    const file = await createFile(target, alice, "twice.txt");
    const before = (await syncFor(target, alice)).seq;
    const response = await batch(alice, { action: "trash", ids: [file.id, file.id] });
    expect(response.json().results).toEqual([
      { id: file.id, ok: true },
      { id: file.id, ok: true },
    ]);
    expect(response.json().files).toHaveLength(2);
    expect((await syncFor(target, alice)).seq).toBe(before + 2);
  });

  it("does not poke when nothing changed", async () => {
    const feed = await new Feed().open(target.baseUrl, alice.token);
    await feed.settle();
    const response = await batch(alice, { action: "restore", ids: ["nothing-here"] });
    expect(response.statusCode).toBe(200);
    expect(await feed.drain()).toEqual([]);
    feed.close();
  });
});
