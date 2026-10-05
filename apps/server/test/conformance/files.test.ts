import {
  decryptFileMetadata,
  encryptFileMetadata,
  generateKey,
  ready,
  secretBoxOpen,
  secretBoxSeal,
} from "@engramer/crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTarget, type Target } from "../helpers/target.js";
import { bearer, register } from "./accounts.js";
import { createFile, createFolder, fileBody, syncFor, type Account } from "./storage.js";

/**
 * File rows: created, re-labelled, moved and re-keyed with the shapes,
 * status codes and wording the web client relies on, identical on both
 * backends. File content arrives with the blob routes.
 */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FILE_KEYS = [
  "createdAt",
  "deleted",
  "encryptedKey",
  "encryptedMeta",
  "folderId",
  "generation",
  "id",
  "indexSize",
  "keyEpoch",
  "size",
  "thumbSize",
  "trashed",
  "updateSeq",
  "updatedAt",
  "uploaded",
];

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

describe("creating a file", () => {
  it("answers 201 with an empty, not yet uploaded row", async () => {
    const { payload } = fileBody(alice, "notes.txt");
    const response = await target.inject({
      method: "POST",
      url: "/api/files",
      headers: bearer(alice.token),
      payload: { ...payload, seekable: true },
    });
    expect(response.statusCode).toBe(201);
    const row = response.json();
    // A new file carries no collaborator flag; sync and changes do.
    expect(Object.keys(row).sort()).toEqual(FILE_KEYS);
    expect(row.id).toMatch(UUID_V4);
    expect(row).toMatchObject({
      folderId: null,
      keyEpoch: 0,
      generation: 0,
      size: 0,
      thumbSize: 0,
      indexSize: 0,
      uploaded: false,
      trashed: false,
      deleted: false,
    });
    expect(row.encryptedKey).toEqual(payload.encryptedKey);
    expect(row.encryptedMeta).toEqual(payload.encryptedMeta);
    expect(row.updateSeq).toBeGreaterThan(0);
  });

  it("lands in a folder the account owns, and syncs with the collaborator flag", async () => {
    const folder = await createFolder(target, alice, "Docs");
    const file = await createFile(target, alice, "in-folder.txt", folder.id);
    expect(file.row.folderId).toBe(folder.id);
    const synced = (await syncFor(target, alice)).files.find((f) => f.id === file.id)!;
    expect(Object.keys(synced).sort()).toEqual([...FILE_KEYS, "hasCollaborators"].sort());
    expect(synced.hasCollaborators).toBe(false);
  });

  it("refuses a missing folder, or one that belongs to another account", async () => {
    const theirs = await createFolder(target, bob, "Bob's");
    for (const folderId of ["00000000-0000-4000-8000-000000000000", theirs.id]) {
      const { payload } = fileBody(alice, "lost.txt", folderId);
      const response = await target.inject({ method: "POST", url: "/api/files", headers: bearer(alice.token), payload });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: "folder not found" });
    }
  });

  it("refuses a malformed body opaquely", async () => {
    const { payload } = fileBody(alice, "bad.txt");
    for (const bad of [{ encryptedKey: payload.encryptedKey }, { ...payload, seekable: "yes" }, { ...payload, folderId: 1 }]) {
      const response = await target.inject({ method: "POST", url: "/api/files", headers: bearer(alice.token), payload: bad });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: "invalid request" });
    }
  });
});

describe("many writes at once", () => {
  it("give every row its own sequence and leave the cursor on the last", async () => {
    const before = (await syncFor(target, alice)).seq;
    const created = await Promise.all(
      Array.from({ length: 20 }, (_, i) => createFile(target, alice, `parallel-${i}.txt`)),
    );
    const seqs = created.map((file) => file.row.updateSeq);
    expect(new Set(seqs).size).toBe(20);
    expect(Math.min(...seqs)).toBe(before + 1);
    expect(Math.max(...seqs)).toBe(before + 20);
    const delta = await syncFor(target, alice, before);
    expect(delta.seq).toBe(before + 20);
    expect(delta.files.map((f) => f.id).sort()).toEqual(created.map((f) => f.id).sort());
  });
});

describe("changing a file", () => {
  it("re-labels and moves, answering with the collaborator flag", async () => {
    const folder = await createFolder(target, alice, "Target");
    const file = await createFile(target, alice, "before.txt");
    const response = await target.inject({
      method: "PATCH",
      url: `/api/files/${file.id}`,
      headers: bearer(alice.token),
      payload: {
        folderId: folder.id,
        encryptedMeta: encryptFileMetadata({ name: "after.txt", mime: "text/plain", size: 1, mtime: 2 }, file.key),
      },
    });
    expect(response.statusCode).toBe(200);
    const row = response.json();
    expect(row.folderId).toBe(folder.id);
    expect(decryptFileMetadata(row.encryptedMeta, file.key).name).toBe("after.txt");
    expect(row.keyEpoch).toBe(0);
    expect(row.hasCollaborators).toBe(false);
    expect(row.updateSeq).toBeGreaterThan(file.row.updateSeq);

    const home = await target.inject({
      method: "PATCH",
      url: `/api/files/${file.id}`,
      headers: bearer(alice.token),
      payload: { folderId: null },
    });
    expect(home.json().folderId).toBeNull();
    expect(decryptFileMetadata(home.json().encryptedMeta, file.key).name).toBe("after.txt");
  });

  it("takes a rotated key and moves the key epoch on", async () => {
    const file = await createFile(target, alice, "rotate.txt");
    const fresh = generateKey();
    const response = await target.inject({
      method: "PATCH",
      url: `/api/files/${file.id}`,
      headers: bearer(alice.token),
      payload: {
        encryptedKey: secretBoxSeal(fresh, alice.keys.masterKey),
        encryptedMeta: encryptFileMetadata({ name: "rotate.txt", mime: "text/plain", size: 1, mtime: 1 }, fresh),
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().keyEpoch).toBe(1);
    expect(secretBoxOpen(response.json().encryptedKey, alice.keys.masterKey)).toEqual(fresh);
  });

  it("refuses a destination folder it cannot find", async () => {
    const file = await createFile(target, alice, "stay.txt");
    const theirs = await createFolder(target, bob, "Not Alice's");
    const response = await target.inject({
      method: "PATCH",
      url: `/api/files/${file.id}`,
      headers: bearer(alice.token),
      payload: { folderId: theirs.id },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "destination folder not found" });
  });

  it("does not find another account's file or a missing one", async () => {
    const theirs = await createFile(target, bob, "bob.txt");
    for (const id of [theirs.id, "00000000-0000-4000-8000-000000000000"]) {
      const response = await target.inject({
        method: "PATCH",
        url: `/api/files/${id}`,
        headers: bearer(alice.token),
        payload: { folderId: null },
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: "file not found" });
    }
  });

  it("checks the body before it looks for the file", async () => {
    const response = await target.inject({
      method: "PATCH",
      url: "/api/files/00000000-0000-4000-8000-000000000000",
      headers: bearer(alice.token),
      payload: { encryptedMeta: "not a box" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid request" });
  });
});
