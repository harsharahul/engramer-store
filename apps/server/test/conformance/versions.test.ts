import Database from "better-sqlite3";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decryptBytes, decryptFileMetadata, encryptBytes, ready, utf8Encode } from "@engramer/crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTarget, type Target } from "../helpers/target.js";
import { bearer, register } from "./accounts.js";
import { getBlob, listVersions, metaFor, putBlob, restoreVersion, uploadFile, usedBytes, verify, versionData } from "./content.js";
import { createFile, syncFor, type Account } from "./storage.js";

/**
 * Content history: every save keeps the displaced bytes as a version
 * within a retention window, a restore is a pointer swap that is itself
 * undoable, and nothing is ever lost until history prunes it.
 */
const MAX_VERSIONS = 3;

let target: Target;
let alice: Account;
let bob: Account;

const blobDir = () => join(target.dataDir, "blobs");

beforeAll(async () => {
  await ready();
  target = await startTarget({ maxVersions: MAX_VERSIONS });
  alice = await register(target, "alice@example.com");
  bob = await register(target, "bob@example.com");
});

afterAll(async () => {
  await target?.close();
});

async function save(file: { id: string; key: Uint8Array }, text: string, expected = 200) {
  const response = await putBlob(target, alice.token, file.id, "data", encryptBytes(utf8Encode(text), file.key));
  expect(response.statusCode).toBe(expected);
  return response;
}

async function current(file: { id: string; key: Uint8Array }): Promise<string> {
  const response = await getBlob(target, alice.token, file.id, "data");
  expect(response.statusCode).toBe(200);
  return Buffer.from(decryptBytes(new Uint8Array(response.rawPayload), file.key)).toString("utf8");
}

describe("version creation", () => {
  it("keeps the previous content as a version on every save, newest first", async () => {
    const file = await uploadFile(target, alice, "draft.txt", utf8Encode("first"));
    await save(file, "second");
    await save(file, "third");
    expect(await current(file)).toBe("third");
    const versions = await listVersions(target, alice.token, file.id);
    expect(versions.map((v) => v.generation)).toEqual([2, 1]);
    expect(versions[1]).toMatchObject({ size: file.ciphertext.length });
    expect(Object.keys(versions[0]!).sort()).toEqual(["createdAt", "encryptedMeta", "generation", "size"]);
    expect(decryptFileMetadata(versions[1]!.encryptedMeta, file.key).name).toBe("draft.txt");
    const first = await versionData(target, alice.token, file.id, 1);
    expect(first.statusCode).toBe(200);
    expect(first.headers["content-type"]).toBe("application/octet-stream");
    expect(first.headers["content-length"]).toBe(String(file.ciphertext.length));
    expect(decryptBytes(new Uint8Array(first.rawPayload), file.key)).toEqual(utf8Encode("first"));
  });

  it("does not version the first upload", async () => {
    const file = await uploadFile(target, alice, "fresh.txt", utf8Encode("only"));
    expect(await listVersions(target, alice.token, file.id)).toEqual([]);
  });

  it("prunes to the retention window and removes pruned blobs from disk", async () => {
    const file = await uploadFile(target, alice, "busy.txt", utf8Encode("v0"));
    for (let i = 1; i <= MAX_VERSIONS + 2; i++) {
      await save(file, `v${i}`);
    }
    const versions = await listVersions(target, alice.token, file.id);
    expect(versions.map((v) => v.generation)).toEqual([5, 4, 3]);
    expect(existsSync(join(blobDir(), `${file.id}.g1`))).toBe(false);
    expect(existsSync(join(blobDir(), `${file.id}.g2`))).toBe(false);
    for (const version of versions) {
      expect(existsSync(join(blobDir(), `${file.id}.g${version.generation}`))).toBe(true);
    }
    expect(existsSync(join(blobDir(), `${file.id}.g6`))).toBe(true);
  });

  it("counts version bytes against the quota", async () => {
    const before = await usedBytes(target, alice.token);
    const file = await uploadFile(target, alice, "fat.txt", new Uint8Array(40 * 1024));
    await putBlob(target, alice.token, file.id, "data", encryptBytes(new Uint8Array(40 * 1024), file.key));
    expect((await usedBytes(target, alice.token)) - before).toBeGreaterThan(75 * 1024);
  });
});

describe("restore", () => {
  it("round-trips content and keeps the displaced current as a version", async () => {
    const file = await uploadFile(target, alice, "essay.txt", utf8Encode("original words"));
    await save(file, "overwritten badly");
    const [original] = await listVersions(target, alice.token, file.id);
    const merged = metaFor(file.key, "renamed-later.txt", original!.size, "original words");
    const restored = await restoreVersion(target, alice.token, file.id, original!.generation, { encryptedMeta: merged });
    expect(restored.statusCode).toBe(200);
    expect(restored.json()).toMatchObject({ id: file.id, generation: 1, size: original!.size, thumbSize: 0, uploaded: true });
    expect(restored.json().encryptedMeta).toEqual(merged);
    expect(restored.json().hasCollaborators).toBeUndefined();
    expect(await current(file)).toBe("original words");
    const after = await listVersions(target, alice.token, file.id);
    expect(after.map((v) => v.generation)).toEqual([2]);
    const bad = await versionData(target, alice.token, file.id, 2);
    expect(decryptBytes(new Uint8Array(bad.rawPayload), file.key)).toEqual(utf8Encode("overwritten badly"));
  });

  it("applies the provided metadata with the swap and pokes the account", async () => {
    const file = await uploadFile(target, alice, "notes.txt", utf8Encode("alpha"));
    await save(file, "beta");
    const [version] = await listVersions(target, alice.token, file.id);
    const mark = (await syncFor(target, alice)).seq;
    await restoreVersion(target, alice.token, file.id, version!.generation, {
      encryptedMeta: metaFor(file.key, "kept-name.txt", version!.size, "alpha"),
    });
    const delta = await syncFor(target, alice, mark);
    const row = delta.files.find((f) => f.id === file.id)!;
    const decoded = decryptFileMetadata(row.encryptedMeta, file.key);
    expect(decoded.name).toBe("kept-name.txt");
    expect(decoded.text).toBe("alpha");
    expect(row.size).toBe(version!.size);
    expect(row.generation).toBe(1);
  });

  it("restores a restore, so nothing is ever lost", async () => {
    const file = await uploadFile(target, alice, "ping.txt", utf8Encode("one"));
    await save(file, "two");
    let [version] = await listVersions(target, alice.token, file.id);
    await restoreVersion(target, alice.token, file.id, version!.generation, { encryptedMeta: metaFor(file.key, "ping.txt", version!.size) });
    expect(await current(file)).toBe("one");
    [version] = await listVersions(target, alice.token, file.id);
    await restoreVersion(target, alice.token, file.id, version!.generation, { encryptedMeta: metaFor(file.key, "ping.txt", version!.size) });
    expect(await current(file)).toBe("two");
  });

  it("drops the preview, which described the displaced bytes", async () => {
    const file = await uploadFile(target, alice, "scan.png", utf8Encode("first scan"));
    await save(file, "rescanned bytes");
    await putBlob(target, alice.token, file.id, "thumbnail", encryptBytes(utf8Encode("preview"), file.key));
    const [original] = await listVersions(target, alice.token, file.id);
    await restoreVersion(target, alice.token, file.id, original!.generation, { encryptedMeta: metaFor(file.key, "scan.png", original!.size) });
    expect(await current(file)).toBe("first scan");
    expect((await getBlob(target, alice.token, file.id, "thumbnail")).statusCode).toBe(404);
    expect(existsSync(join(blobDir(), `${file.id}.thumb`))).toBe(false);
  });

  it("refuses a version that does not exist, and a malformed body", async () => {
    const file = await uploadFile(target, alice, "solo.txt", utf8Encode("alone"));
    for (const generation of [5, "abc"]) {
      const missing = await restoreVersion(target, alice.token, file.id, generation, { encryptedMeta: metaFor(file.key, "solo.txt", 1) });
      expect(missing.statusCode, String(generation)).toBe(404);
      expect(missing.json()).toEqual({ error: "version not found" });
      const data = await versionData(target, alice.token, file.id, generation);
      expect(data.statusCode).toBe(404);
      expect(data.json()).toEqual({ error: "version not found" });
    }
    for (const body of [{}, { encryptedMeta: "x" }, { encryptedMeta: { nonce: "n" } }]) {
      const bad = await restoreVersion(target, alice.token, file.id, 0, body);
      expect(bad.statusCode).toBe(400);
      expect(bad.json()).toEqual({ error: "invalid request" });
    }
  });

  it("refuses a file without content and a file in the trash", async () => {
    // The server answers these two with its collaborator wording, and the
    // device answers the same way.
    const empty = await createFile(target, alice, "empty.txt");
    const noContent = await restoreVersion(target, alice.token, empty.id, 0, { encryptedMeta: metaFor(empty.key, "empty.txt", 1) });
    expect(noContent.statusCode).toBe(403);
    expect(noContent.json()).toEqual({ error: "only the owner can restore a version" });
    const file = await uploadFile(target, alice, "binned.txt", utf8Encode("one"));
    await save(file, "two");
    await target.inject({ method: "DELETE", url: `/api/files/${file.id}`, headers: bearer(alice.token) });
    const binned = await restoreVersion(target, alice.token, file.id, 0, { encryptedMeta: metaFor(file.key, "binned.txt", 1) });
    expect(binned.statusCode).toBe(403);
    expect(binned.json()).toEqual({ error: "only the owner can restore a version" });
    // History still lists and serves while the file sits in the trash.
    expect(await listVersions(target, alice.token, file.id)).toHaveLength(1);
  });

  it("hides history from other accounts", async () => {
    const file = await uploadFile(target, alice, "private.txt", utf8Encode("v1"));
    await save(file, "v2");
    const listed = await target.inject({ method: "GET", url: `/api/files/${file.id}/versions`, headers: bearer(bob.token) });
    expect(listed.statusCode).toBe(404);
    expect(listed.json()).toEqual({ error: "file not found" });
    expect((await versionData(target, bob.token, file.id, 0)).statusCode).toBe(404);
    const restored = await restoreVersion(target, bob.token, file.id, 0, { encryptedMeta: metaFor(file.key, "x", 1) });
    expect(restored.statusCode).toBe(404);
    expect(restored.json()).toEqual({ error: "file not found" });
  });

  it("versions a generation-zero file under the server's blob names", async () => {
    // A row from before versioning shipped keeps its content at the bare
    // key as generation 0; new content starts at generation 1, so that
    // state is written directly into the vault.
    const file = await createFile(target, alice, "legacy.txt");
    const ancient = encryptBytes(utf8Encode("ancient bytes"), file.key);
    writeFileSync(join(blobDir(), file.id), ancient);
    const db = new Database(join(target.dataDir, "engramer.db"));
    try {
      db.pragma("busy_timeout = 5000");
      db.prepare("UPDATE files SET uploaded = 1, size = ?, generation = 0 WHERE id = ?").run(ancient.length, file.id);
    } finally {
      db.close();
    }
    expect(await current(file)).toBe("ancient bytes");
    expect(existsSync(join(blobDir(), file.id))).toBe(true);
    await save(file, "modern bytes");
    expect(existsSync(join(blobDir(), `${file.id}.g1`))).toBe(true);
    expect(existsSync(join(blobDir(), file.id))).toBe(true);
    const [version] = await listVersions(target, alice.token, file.id);
    expect(version!.generation).toBe(0);
    await restoreVersion(target, alice.token, file.id, 0, { encryptedMeta: metaFor(file.key, "legacy.txt", version!.size) });
    expect(await current(file)).toBe("ancient bytes");
    expect(readdirSync(blobDir()).filter((name) => name.startsWith(file.id)).sort()).toEqual([file.id, `${file.id}.g1`]);
  });

  it("a restored file verifies clean", async () => {
    const file = await uploadFile(target, alice, "restore-check.txt", utf8Encode("one"));
    await save(file, "two");
    expect((await restoreVersion(target, alice.token, file.id, 1, { encryptedMeta: metaFor(file.key, "restore-check.txt", 1) })).statusCode).toBe(200);
    const verdict = async () => {
      const response = await verify(target, alice.token, [file.id]);
      expect(response.statusCode).toBe(200);
      return (response.json().results as Array<{ verdict: string }>)[0]!.verdict;
    };
    // The restored bytes carry no digest of their own yet; the check
    // records one instead of comparing against the displaced content.
    expect(await verdict()).toBe("recorded");
    expect(await verdict()).toBe("intact");
  });

  it("a save after a restore keeps every version", async () => {
    const file = await uploadFile(target, alice, "history.txt", utf8Encode("v1"));
    await save(file, "v2");
    await save(file, "v3");
    expect((await restoreVersion(target, alice.token, file.id, 1, { encryptedMeta: metaFor(file.key, "history.txt", 1) })).statusCode).toBe(200);
    const saved = await putBlob(target, alice.token, file.id, "data", encryptBytes(utf8Encode("v4"), file.key));
    expect(saved.json().generation).toBe(4);
    for (const [generation, text] of [[1, "v1"], [2, "v2"], [3, "v3"]] as const) {
      const response = await versionData(target, alice.token, file.id, generation);
      expect(response.statusCode, `generation ${generation}`).toBe(200);
      expect(decryptBytes(new Uint8Array(response.rawPayload), file.key)).toEqual(utf8Encode(text));
    }
    expect((await listVersions(target, alice.token, file.id)).map((v) => v.generation).sort()).toEqual([1, 2, 3]);
    expect(await current(file)).toBe("v4");
  });
});

describe("with history off", () => {
  it("a save replaces the bytes and removes the displaced blob", async () => {
    const bare = await startTarget({ maxVersions: 0 });
    try {
      const account = await register(bare, "bare@example.com");
      const file = await uploadFile(bare, account, "nohistory.txt", utf8Encode("one"));
      const replaced = await putBlob(bare, account.token, file.id, "data", encryptBytes(utf8Encode("two"), file.key));
      expect(replaced.json().generation).toBe(2);
      expect(await listVersions(bare, account.token, file.id)).toEqual([]);
      const names = readdirSync(join(bare.dataDir, "blobs")).filter((name) => name.startsWith(file.id));
      expect(names).toEqual([`${file.id}.g2`]);
    } finally {
      await bare.close();
    }
  });
});
