import { decryptFolderMetadata, encryptFolderMetadata, ready } from "@engramer/crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTarget, type Target } from "../helpers/target.js";
import { bearer, register } from "./accounts.js";
import { createFile, createFolder, folderBody, syncFor, type Account } from "./storage.js";

/**
 * Folders: created, renamed, moved and deleted with the shapes, status
 * codes and wording the web client relies on, identical on both backends.
 */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

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

describe("creating a folder", () => {
  it("answers 201 with the stored row", async () => {
    const { payload } = folderBody(alice, "Photos");
    const response = await target.inject({ method: "POST", url: "/api/folders", headers: bearer(alice.token), payload });
    expect(response.statusCode).toBe(201);
    const row = response.json();
    expect(Object.keys(row).sort()).toEqual(
      ["createdAt", "deleted", "encryptedKey", "encryptedMeta", "id", "parentId", "updateSeq", "updatedAt"].sort(),
    );
    expect(row.id).toMatch(UUID_V4);
    expect(row.parentId).toBeNull();
    expect(row.encryptedKey).toEqual(payload.encryptedKey);
    expect(row.encryptedMeta).toEqual(payload.encryptedMeta);
    expect(row.deleted).toBe(false);
    expect(row.updateSeq).toBeGreaterThan(0);
    expect(typeof row.createdAt).toBe("number");
    expect(row.updatedAt).toBe(row.createdAt);
  });

  it("nests under a parent the account owns", async () => {
    const parent = await createFolder(target, alice, "Parent");
    const child = await createFolder(target, alice, "Child", parent.id);
    expect(child.row.parentId).toBe(parent.id);
  });

  it("refuses a missing parent, or one that belongs to another account", async () => {
    const theirs = await createFolder(target, bob, "Bob's");
    for (const parentId of ["00000000-0000-4000-8000-000000000000", theirs.id]) {
      const { payload } = folderBody(alice, "Orphan", parentId);
      const response = await target.inject({ method: "POST", url: "/api/folders", headers: bearer(alice.token), payload });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: "parent folder not found" });
    }
  });

  it("refuses a malformed body opaquely", async () => {
    const { payload } = folderBody(alice, "Bad");
    for (const bad of [
      { encryptedMeta: payload.encryptedMeta },
      { ...payload, encryptedKey: "not a box" },
      { ...payload, encryptedMeta: { nonce: "x" } },
      { ...payload, parentId: 7 },
    ]) {
      const response = await target.inject({ method: "POST", url: "/api/folders", headers: bearer(alice.token), payload: bad });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: "invalid request" });
    }
  });

  it("requires a session", async () => {
    const { payload } = folderBody(alice, "Anon");
    const response = await target.inject({ method: "POST", url: "/api/folders", payload });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "authentication required" });
  });
});

describe("changing a folder", () => {
  it("renames with new sealed metadata and a new sequence", async () => {
    const folder = await createFolder(target, alice, "Old name");
    const response = await target.inject({
      method: "PATCH",
      url: `/api/folders/${folder.id}`,
      headers: bearer(alice.token),
      payload: { encryptedMeta: encryptFolderMetadata({ name: "New name" }, folder.key) },
    });
    expect(response.statusCode).toBe(200);
    const row = response.json();
    expect(decryptFolderMetadata(row.encryptedMeta, folder.key).name).toBe("New name");
    expect(row.parentId).toBeNull();
    expect(row.encryptedKey).toEqual(folder.row.encryptedKey);
    expect(row.updateSeq).toBeGreaterThan(folder.row.updateSeq);
  });

  it("moves into another folder and back to the root", async () => {
    const box = await createFolder(target, alice, "Box");
    const item = await createFolder(target, alice, "Item");
    const moved = await target.inject({
      method: "PATCH",
      url: `/api/folders/${item.id}`,
      headers: bearer(alice.token),
      payload: { parentId: box.id },
    });
    expect(moved.json().parentId).toBe(box.id);
    const kept = await target.inject({
      method: "PATCH",
      url: `/api/folders/${item.id}`,
      headers: bearer(alice.token),
      payload: {},
    });
    expect(kept.statusCode).toBe(200);
    expect(kept.json().parentId).toBe(box.id);
    const root = await target.inject({
      method: "PATCH",
      url: `/api/folders/${item.id}`,
      headers: bearer(alice.token),
      payload: { parentId: null },
    });
    expect(root.json().parentId).toBeNull();
  });

  it("refuses itself, a foreign folder, or a missing one as the destination", async () => {
    const folder = await createFolder(target, alice, "Self");
    const theirs = await createFolder(target, bob, "Bob's target");
    for (const parentId of [folder.id, theirs.id, "00000000-0000-4000-8000-000000000000"]) {
      const response = await target.inject({
        method: "PATCH",
        url: `/api/folders/${folder.id}`,
        headers: bearer(alice.token),
        payload: { parentId },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: "invalid destination folder" });
    }
  });

  it("refuses a move into its own subtree", async () => {
    const top = await createFolder(target, alice, "Top");
    const middle = await createFolder(target, alice, "Middle", top.id);
    const bottom = await createFolder(target, alice, "Bottom", middle.id);
    const response = await target.inject({
      method: "PATCH",
      url: `/api/folders/${top.id}`,
      headers: bearer(alice.token),
      payload: { parentId: bottom.id },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "cannot move a folder into its own subtree" });
  });

  it("does not find another account's folder", async () => {
    const theirs = await createFolder(target, bob, "Private");
    for (const method of ["PATCH", "DELETE"]) {
      const response = await target.inject({
        method,
        url: `/api/folders/${theirs.id}`,
        headers: bearer(alice.token),
        payload: method === "PATCH" ? { parentId: null } : undefined,
      });
      expect(response.statusCode, method).toBe(404);
      expect(response.json()).toEqual({ error: "folder not found" });
    }
  });
});

describe("deleting a folder", () => {
  it("tombstones the subtree and trashes its files, one sequence per row", async () => {
    const top = await createFolder(target, alice, "Doomed");
    const inner = await createFolder(target, alice, "Inner", top.id);
    const outerFile = await createFile(target, alice, "a.txt", top.id);
    const innerFile = await createFile(target, alice, "b.txt", inner.id);
    const mark = (await syncFor(target, alice)).seq;

    const response = await target.inject({ method: "DELETE", url: `/api/folders/${top.id}`, headers: bearer(alice.token) });
    expect(response.statusCode).toBe(204);
    expect(response.body).toBe("");

    const delta = await syncFor(target, alice, mark);
    const folders = delta.folders.filter((f) => [top.id, inner.id].includes(f.id));
    const files = delta.files.filter((f) => [outerFile.id, innerFile.id].includes(f.id));
    expect(folders).toHaveLength(2);
    expect(folders.every((f) => f.deleted)).toBe(true);
    expect(files).toHaveLength(2);
    expect(files.every((f) => f.trashed && !f.deleted)).toBe(true);
    const seqs = [...folders, ...files].map((row) => row.updateSeq);
    expect(new Set(seqs).size).toBe(4);
    expect(Math.min(...seqs)).toBeGreaterThan(mark);
    expect(delta.seq).toBe(Math.max(...seqs));
  });

  it("is gone afterwards", async () => {
    const folder = await createFolder(target, alice, "Once");
    await target.inject({ method: "DELETE", url: `/api/folders/${folder.id}`, headers: bearer(alice.token) });
    const again = await target.inject({ method: "DELETE", url: `/api/folders/${folder.id}`, headers: bearer(alice.token) });
    expect(again.statusCode).toBe(404);
    expect(again.json()).toEqual({ error: "folder not found" });
    const rename = await target.inject({
      method: "PATCH",
      url: `/api/folders/${folder.id}`,
      headers: bearer(alice.token),
      payload: { encryptedMeta: encryptFolderMetadata({ name: "Late" }, folder.key) },
    });
    expect(rename.statusCode).toBe(404);
  });
});
