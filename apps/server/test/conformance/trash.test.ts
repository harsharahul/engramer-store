import { ready } from "@engramer/crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTarget, type Target } from "../helpers/target.js";
import { bearer, register } from "./accounts.js";
import { createFile, createFolder, syncFor, type Account } from "./storage.js";

/**
 * The trash: a file moves in, comes back, or is deleted for good, with
 * the status codes and wording the web client relies on, identical on
 * both backends.
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

const trash = (account: Account, id: string) =>
  target.inject({ method: "DELETE", url: `/api/files/${id}`, headers: bearer(account.token) });
const restore = (account: Account, id: string) =>
  target.inject({ method: "POST", url: `/api/trash/${id}/restore`, headers: bearer(account.token) });
const purge = (account: Account, id: string) =>
  target.inject({ method: "DELETE", url: `/api/trash/${id}`, headers: bearer(account.token) });

describe("moving a file to the trash", () => {
  it("answers 204 and syncs the file as trashed", async () => {
    const file = await createFile(target, alice, "bin.txt");
    const response = await trash(alice, file.id);
    expect(response.statusCode).toBe(204);
    expect(response.body).toBe("");
    const row = (await syncFor(target, alice, file.row.updateSeq)).files.find((f) => f.id === file.id)!;
    expect(row.trashed).toBe(true);
    expect(row.deleted).toBe(false);
  });

  it("does not find another account's file", async () => {
    const theirs = await createFile(target, bob, "bob.txt");
    const response = await trash(alice, theirs.id);
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "file not found" });
  });
});

describe("restoring from the trash", () => {
  it("returns the file to its folder", async () => {
    const folder = await createFolder(target, alice, "Home");
    const file = await createFile(target, alice, "back.txt", folder.id);
    await trash(alice, file.id);
    const response = await restore(alice, file.id);
    expect(response.statusCode).toBe(204);
    const row = (await syncFor(target, alice)).files.find((f) => f.id === file.id)!;
    expect(row.trashed).toBe(false);
    expect(row.folderId).toBe(folder.id);
  });

  it("returns the file to the root when its folder is gone", async () => {
    const folder = await createFolder(target, alice, "Gone");
    const file = await createFile(target, alice, "orphan.txt", folder.id);
    await target.inject({ method: "DELETE", url: `/api/folders/${folder.id}`, headers: bearer(alice.token) });
    const response = await restore(alice, file.id);
    expect(response.statusCode).toBe(204);
    const row = (await syncFor(target, alice)).files.find((f) => f.id === file.id)!;
    expect(row.trashed).toBe(false);
    expect(row.folderId).toBeNull();
  });

  it("refuses a file that is not in the trash", async () => {
    const file = await createFile(target, alice, "live.txt");
    const theirs = await createFile(target, bob, "bob-binned.txt");
    await trash(bob, theirs.id);
    for (const id of [file.id, theirs.id, "00000000-0000-4000-8000-000000000000"]) {
      const response = await restore(alice, id);
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: "file not found in trash" });
    }
  });
});

describe("deleting for good", () => {
  it("tombstones the row with no size, and only once", async () => {
    const file = await createFile(target, alice, "forever.txt");
    expect((await purge(alice, file.id)).statusCode).toBe(404);
    await trash(alice, file.id);
    const mark = (await syncFor(target, alice)).seq;
    const response = await purge(alice, file.id);
    expect(response.statusCode).toBe(204);
    const row = (await syncFor(target, alice, mark)).files.find((f) => f.id === file.id)!;
    expect(row).toMatchObject({ deleted: true, size: 0, thumbSize: 0, uploaded: false });
    expect(row.updateSeq).toBeGreaterThan(mark);
    const again = await purge(alice, file.id);
    expect(again.statusCode).toBe(404);
    expect(again.json()).toEqual({ error: "file not found in trash" });
    expect((await trash(alice, file.id)).statusCode).toBe(404);
  });
});
