import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
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
  utf8Encode,
  type AccountKeys,
  type SecretBox,
} from "@engramer/crypto";
import { buildApp } from "../src/app.js";

const QUOTA_BYTES = 512 * 1024;
const MAX_VERSIONS = 3;

let app: FastifyInstance;
let dataDir: string;
let account: AccountKeys;
let token: string;

const authHeader = () => ({ authorization: `Bearer ${token}` });

interface Doc {
  id: string;
  fileKey: Uint8Array;
}

async function createFile(name: string, content: Uint8Array): Promise<Doc> {
  const fileKey = generateKey();
  const created = await app.inject({
    method: "POST",
    url: "/api/files",
    headers: authHeader(),
    payload: {
      folderId: null,
      encryptedKey: secretBoxSeal(fileKey, account.masterKey),
      encryptedMeta: meta(name, content.length, fileKey),
    },
  });
  expect(created.statusCode).toBe(201);
  const id = created.json().id as string;
  await putContent(id, fileKey, content, 200);
  return { id, fileKey };
}

function meta(name: string, size: number, fileKey: Uint8Array, text?: string): SecretBox {
  return encryptFileMetadata(
    { name, mime: "text/plain", size, mtime: Date.now(), ...(text ? { text } : {}) },
    fileKey,
  );
}

async function putContent(id: string, fileKey: Uint8Array, content: Uint8Array, expected: number) {
  const response = await app.inject({
    method: "PUT",
    url: `/api/files/${id}/data`,
    headers: { ...authHeader(), "content-type": "application/octet-stream" },
    payload: Buffer.from(encryptBytes(content, fileKey)),
  });
  expect(response.statusCode).toBe(expected);
  return response;
}

async function currentContent(doc: Doc): Promise<Uint8Array> {
  const response = await app.inject({
    method: "GET",
    url: `/api/files/${doc.id}/data`,
    headers: authHeader(),
  });
  expect(response.statusCode).toBe(200);
  return decryptBytes(new Uint8Array(response.rawPayload), doc.fileKey);
}

async function listVersions(id: string) {
  const response = await app.inject({
    method: "GET",
    url: `/api/files/${id}/versions`,
    headers: authHeader(),
  });
  expect(response.statusCode).toBe(200);
  return response.json().versions as Array<{
    generation: number;
    size: number;
    encryptedMeta: SecretBox;
    createdAt: number;
  }>;
}

async function restore(id: string, generation: number, encryptedMeta: SecretBox, expected = 200) {
  const response = await app.inject({
    method: "POST",
    url: `/api/files/${id}/versions/${generation}/restore`,
    headers: authHeader(),
    payload: { encryptedMeta },
  });
  expect(response.statusCode).toBe(expected);
  return response;
}

beforeAll(async () => {
  await ready();
  dataDir = mkdtempSync(join(tmpdir(), "engramer-versions-test-"));
  app = await buildApp({
    dataDir,
    quotaBytes: QUOTA_BYTES,
    maxVersions: MAX_VERSIONS,
    webDistDir: null,
  });
  account = generateAccountKeys("versioned vault passphrase");
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: {
      email: "versions@example.com",
      loginKey: account.loginKey,
      keyAttributes: account.keyAttributes,
    },
  });
  token = response.json().token as string;
});

afterAll(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("version creation", () => {
  it("keeps the previous content as a version on every save", async () => {
    const doc = await createFile("draft.txt", utf8Encode("first"));
    await putContent(doc.id, doc.fileKey, utf8Encode("second"), 200);
    await putContent(doc.id, doc.fileKey, utf8Encode("third"), 200);

    expect(await currentContent(doc)).toEqual(utf8Encode("third"));
    const versions = await listVersions(doc.id);
    expect(versions).toHaveLength(2);

    // Each version's bytes decrypt to exactly what was current back then.
    const first = await app.inject({
      method: "GET",
      url: `/api/files/${doc.id}/versions/${versions[1]!.generation}/data`,
      headers: authHeader(),
    });
    expect(decryptBytes(new Uint8Array(first.rawPayload), doc.fileKey)).toEqual(
      utf8Encode("first"),
    );
  });

  it("does not version the first upload", async () => {
    const doc = await createFile("fresh.txt", utf8Encode("only"));
    expect(await listVersions(doc.id)).toHaveLength(0);
  });

  it("prunes to the retention window and removes pruned blobs", async () => {
    const doc = await createFile("busy.txt", utf8Encode("v0"));
    for (let i = 1; i <= MAX_VERSIONS + 2; i++) {
      await putContent(doc.id, doc.fileKey, utf8Encode(`v${i}`), 200);
    }
    const versions = await listVersions(doc.id);
    expect(versions).toHaveLength(MAX_VERSIONS);
    // Oldest generations are gone from the database and from disk.
    const keptGens = new Set(versions.map((v) => v.generation));
    expect(keptGens.has(0)).toBe(false);
    const blobDir = join(dataDir, "blobs");
    expect(existsSync(join(blobDir, doc.id))).toBe(false); // gen 0 blob pruned
    // Current and kept-version blobs exist.
    for (const v of versions) {
      expect(existsSync(join(blobDir, `${doc.id}.g${v.generation}`))).toBe(true);
    }
  });
});

describe("restore", () => {
  it("round-trips content and makes the displaced current a version", async () => {
    const doc = await createFile("essay.txt", utf8Encode("original words"));
    await putContent(doc.id, doc.fileKey, utf8Encode("overwritten badly"), 200);

    const versions = await listVersions(doc.id);
    const target = versions[0]!;
    // Client-side merge: keep the current name, take the version's size/text.
    const merged = meta("renamed-later.txt", target.size, doc.fileKey, "original words");
    await restore(doc.id, target.generation, merged);

    expect(await currentContent(doc)).toEqual(utf8Encode("original words"));
    const after = await listVersions(doc.id);
    // The bad save is preserved as a version: restore is undoable.
    const badVersion = after.find((v) => v.generation !== target.generation);
    expect(badVersion).toBeTruthy();
    const bad = await app.inject({
      method: "GET",
      url: `/api/files/${doc.id}/versions/${badVersion!.generation}/data`,
      headers: authHeader(),
    });
    expect(decryptBytes(new Uint8Array(bad.rawPayload), doc.fileKey)).toEqual(
      utf8Encode("overwritten badly"),
    );
  });

  it("applies the provided metadata atomically with the swap", async () => {
    const doc = await createFile("notes.txt", utf8Encode("alpha"));
    await putContent(doc.id, doc.fileKey, utf8Encode("beta"), 200);
    const versions = await listVersions(doc.id);
    const merged = meta("kept-name.txt", versions[0]!.size, doc.fileKey, "alpha");
    await restore(doc.id, versions[0]!.generation, merged);

    const sync = await app.inject({ method: "GET", url: "/api/sync?since=0", headers: authHeader() });
    const dto = (sync.json().files as Array<{ id: string; encryptedMeta: SecretBox; size: number }>).find(
      (f) => f.id === doc.id,
    )!;
    const decoded = decryptFileMetadata(dto.encryptedMeta, doc.fileKey);
    expect(decoded.name).toBe("kept-name.txt");
    expect(decoded.text).toBe("alpha");
    expect(dto.size).toBe(versions[0]!.size);
  });

  it("restores a restore (nothing is ever lost)", async () => {
    const doc = await createFile("ping.txt", utf8Encode("one"));
    await putContent(doc.id, doc.fileKey, utf8Encode("two"), 200);
    let versions = await listVersions(doc.id);
    await restore(doc.id, versions[0]!.generation, meta("ping.txt", versions[0]!.size, doc.fileKey));
    expect(await currentContent(doc)).toEqual(utf8Encode("one"));

    versions = await listVersions(doc.id);
    await restore(doc.id, versions[0]!.generation, meta("ping.txt", versions[0]!.size, doc.fileKey));
    expect(await currentContent(doc)).toEqual(utf8Encode("two"));
  });

  it("404s on a version that does not exist", async () => {
    const doc = await createFile("solo.txt", utf8Encode("alone"));
    await restore(doc.id, 5, meta("solo.txt", 1, doc.fileKey), 404);
  });
});

describe("safety properties", () => {
  it("a failed blob write never moves the pointer", async () => {
    const doc = await createFile("precious.txt", utf8Encode("safe content"));
    const original = app.blobs.put.bind(app.blobs);
    app.blobs.put = async () => {
      throw new Error("disk on fire");
    };
    try {
      const response = await app.inject({
        method: "PUT",
        url: `/api/files/${doc.id}/data`,
        headers: { ...authHeader(), "content-type": "application/octet-stream" },
        payload: Buffer.from(encryptBytes(utf8Encode("doomed"), doc.fileKey)),
      });
      expect(response.statusCode).toBe(500);
    } finally {
      app.blobs.put = original;
    }
    // The file still serves its previous content and grew no versions.
    expect(await currentContent(doc)).toEqual(utf8Encode("safe content"));
    expect(await listVersions(doc.id)).toHaveLength(0);
  });

  it("rejects a save that raced a concurrent writer and cleans its blob", async () => {
    const doc = await createFile("contended.txt", utf8Encode("base"));
    // Simulate another client completing a save while this request's bytes
    // stream in: the moment the blob store is asked to write, advance the
    // file's generation underneath the in-flight request.
    const original = app.blobs.put.bind(app.blobs);
    app.blobs.put = async (key, source, maxBytes) => {
      const written = await original(key, source, maxBytes);
      await app.db.run("UPDATE files SET generation = generation + 1 WHERE id = ?", doc.id);
      return written;
    };
    try {
      const response = await app.inject({
        method: "PUT",
        url: `/api/files/${doc.id}/data`,
        headers: { ...authHeader(), "content-type": "application/octet-stream" },
        payload: Buffer.from(encryptBytes(utf8Encode("late arrival"), doc.fileKey)),
      });
      expect(response.statusCode).toBe(409);
    } finally {
      app.blobs.put = original;
      await app.db.run("UPDATE files SET generation = generation - 1 WHERE id = ?", doc.id);
    }
    // The loser's blob was cleaned up and no version was recorded.
    expect(await currentContent(doc)).toEqual(utf8Encode("base"));
    expect(await listVersions(doc.id)).toHaveLength(0);
    const leftovers = readdirSync(join(dataDir, "blobs")).filter(
      (f) => f.startsWith(doc.id) && f.includes(".g"),
    );
    expect(leftovers).toEqual([]);
  });

  it("version bytes count against the quota", async () => {
    const before = (await app.inject({ method: "GET", url: "/api/user", headers: authHeader() }))
      .json().usedBytes as number;
    const doc = await createFile("fat.txt", new Uint8Array(40 * 1024));
    await putContent(doc.id, doc.fileKey, new Uint8Array(40 * 1024), 200);
    const after = (await app.inject({ method: "GET", url: "/api/user", headers: authHeader() }))
      .json().usedBytes as number;
    // Current plus one version: roughly double the single-blob footprint.
    expect(after - before).toBeGreaterThan(75 * 1024);
  });

  it("delete forever removes every generation from disk", async () => {
    const doc = await createFile("purge.txt", utf8Encode("gen zero"));
    await putContent(doc.id, doc.fileKey, utf8Encode("gen one"), 200);
    await putContent(doc.id, doc.fileKey, utf8Encode("gen two"), 200);

    await app.inject({ method: "DELETE", url: `/api/files/${doc.id}`, headers: authHeader() });
    const purged = await app.inject({
      method: "DELETE",
      url: `/api/trash/${doc.id}`,
      headers: authHeader(),
    });
    expect(purged.statusCode).toBe(204);
    const leftovers = readdirSync(join(dataDir, "blobs")).filter((f) => f.startsWith(doc.id));
    expect(leftovers).toEqual([]);
  });

  it("hides versions from other accounts", async () => {
    const doc = await createFile("private.txt", utf8Encode("v1"));
    await putContent(doc.id, doc.fileKey, utf8Encode("v2"), 200);

    const other = generateAccountKeys("someone else entirely");
    const registered = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        email: "intruder@example.com",
        loginKey: other.loginKey,
        keyAttributes: other.keyAttributes,
      },
    });
    const otherToken = registered.json().token as string;
    const listed = await app.inject({
      method: "GET",
      url: `/api/files/${doc.id}/versions`,
      headers: { authorization: `Bearer ${otherToken}` },
    });
    expect(listed.statusCode).toBe(404);
    const restored = await app.inject({
      method: "POST",
      url: `/api/files/${doc.id}/versions/1/restore`,
      headers: { authorization: `Bearer ${otherToken}` },
      payload: { encryptedMeta: meta("x", 1, doc.fileKey) },
    });
    expect(restored.statusCode).toBe(404);
  });

  it("share links serve the current generation after saves and restores", async () => {
    const doc = await createFile("shared.txt", utf8Encode("public v1"));
    await putContent(doc.id, doc.fileKey, utf8Encode("public v2"), 200);
    const share = await app.inject({
      method: "POST",
      url: "/api/shares",
      headers: authHeader(),
      payload: { fileId: doc.id },
    });
    const shareToken = share.json().token as string;
    const served = await app.inject({ method: "GET", url: `/api/public/${shareToken}/data` });
    expect(decryptBytes(new Uint8Array(served.rawPayload), doc.fileKey)).toEqual(
      utf8Encode("public v2"),
    );

    const versions = await listVersions(doc.id);
    await restore(doc.id, versions[0]!.generation, meta("shared.txt", versions[0]!.size, doc.fileKey));
    const reverted = await app.inject({ method: "GET", url: `/api/public/${shareToken}/data` });
    expect(decryptBytes(new Uint8Array(reverted.rawPayload), doc.fileKey)).toEqual(
      utf8Encode("public v1"),
    );
  });
});

describe("legacy compatibility", () => {
  it("a generation-zero file (pre-versioning blob name) versions cleanly", async () => {
    // createFile writes generation 0 at the bare key, exactly like every blob
    // that existed before versioning shipped.
    const doc = await createFile("legacy.txt", utf8Encode("ancient bytes"));
    const blobDir = join(dataDir, "blobs");
    expect(existsSync(join(blobDir, doc.id))).toBe(true);

    await putContent(doc.id, doc.fileKey, utf8Encode("modern bytes"), 200);
    expect(existsSync(join(blobDir, `${doc.id}.g1`))).toBe(true);
    expect(existsSync(join(blobDir, doc.id))).toBe(true); // gen 0 kept as a version

    const versions = await listVersions(doc.id);
    expect(versions[0]!.generation).toBe(0);
    await restore(doc.id, 0, meta("legacy.txt", versions[0]!.size, doc.fileKey));
    expect(await currentContent(doc)).toEqual(utf8Encode("ancient bytes"));
  });
});
