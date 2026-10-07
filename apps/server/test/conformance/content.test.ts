import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { decryptBytes, encryptBytes, ready, utf8Encode } from "@engramer/crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTarget, type Target } from "../helpers/target.js";
import { bearer, register } from "./accounts.js";
import { getBlob, metaFor, OCTETS, payload, putBlob, sameBytes, uploadFile, usedBytes } from "./content.js";
import { Feed } from "./feed.js";
import { createFile, syncFor, type Account } from "./storage.js";

/**
 * File content, previews and search indexes over the blob routes: the
 * shapes, headers, status codes and wording the clients rely on, and the
 * on-disk layout a vault shares with a server data directory, identical
 * on both backends.
 */
const QUOTA = 512 * 1024;

let target: Target;
let alice: Account;
let bob: Account;

const blobPath = (key: string) => join(target.dataDir, "blobs", key);
const blobsOf = (id: string) => readdirSync(join(target.dataDir, "blobs")).filter((name) => name.startsWith(id));

beforeAll(async () => {
  await ready();
  target = await startTarget({ quotaBytes: QUOTA });
  alice = await register(target, "alice@example.com");
  bob = await register(target, "bob@example.com");
});

afterAll(async () => {
  await target?.close();
});

describe("content", () => {
  it("round-trips sealed bytes and records the generation", async () => {
    const plain = payload(9000);
    const file = await createFile(target, alice, "roundtrip.bin");
    const ciphertext = encryptBytes(plain, file.key);
    const put = await putBlob(target, alice.token, file.id, "data", ciphertext);
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({ size: ciphertext.length, generation: 0 });

    const got = await getBlob(target, alice.token, file.id, "data");
    expect(got.statusCode).toBe(200);
    expect(got.headers["content-type"]).toBe("application/octet-stream");
    expect(got.headers["content-length"]).toBe(String(ciphertext.length));
    expect(got.headers["x-generation"]).toBe("0");
    expect(got.headers["accept-ranges"]).toBe("bytes");
    expect(sameBytes(decryptBytes(new Uint8Array(got.rawPayload), file.key), plain)).toBe(true);

    const row = (await syncFor(target, alice)).files.find((f) => f.id === file.id)!;
    expect(row).toMatchObject({ uploaded: true, size: ciphertext.length, generation: 0 });
    expect(row.updateSeq).toBeGreaterThan(file.row.updateSeq);
  });

  it("replaces content in place, one generation at a time", async () => {
    const file = await uploadFile(target, alice, "note.md", utf8Encode("first draft"));
    const revised = encryptBytes(utf8Encode("second draft, revised in the editor"), file.key);
    const replaced = await putBlob(target, alice.token, file.id, "data", revised);
    expect(replaced.statusCode).toBe(200);
    expect(replaced.json()).toEqual({ size: revised.length, generation: 1 });
    const got = await getBlob(target, alice.token, file.id, "data");
    expect(got.headers["x-generation"]).toBe("1");
    expect(decryptBytes(new Uint8Array(got.rawPayload), file.key)).toEqual(utf8Encode("second draft, revised in the editor"));
  });

  it("stores only ciphertext, under the server's blob names", async () => {
    const marker = "MARKER-plaintext-should-never-appear";
    const file = await uploadFile(target, alice, "secret.txt", utf8Encode(`${marker} content`));
    const stored = readFileSync(blobPath(file.id));
    expect(stored.includes(Buffer.from(marker))).toBe(false);
    expect(sameBytes(new Uint8Array(stored), file.ciphertext)).toBe(true);
    await putBlob(target, alice.token, file.id, "data", encryptBytes(utf8Encode("again"), file.key));
    expect(existsSync(blobPath(`${file.id}.g1`))).toBe(true);
  });

  it("commits metadata riding the save in the same transaction", async () => {
    const file = await uploadFile(target, alice, "doc.docx", utf8Encode("v1"));
    const nextMeta = metaFor(file.key, "doc.docx", 9, "meta rides");
    const bytes = encryptBytes(utf8Encode("meta rides"), file.key);
    const saved = await putBlob(target, alice.token, file.id, "data", bytes, {
      "x-encrypted-meta": Buffer.from(JSON.stringify(nextMeta)).toString("base64"),
    });
    expect(saved.statusCode).toBe(200);
    const body = saved.json();
    expect(body.size).toBe(bytes.length);
    expect(body.generation).toBe(1);
    expect(body.file).toMatchObject({ id: file.id, generation: 1, size: bytes.length, uploaded: true, hasCollaborators: false });
    expect(body.file.encryptedMeta).toEqual(nextMeta);
    const row = (await syncFor(target, alice)).files.find((f) => f.id === file.id)!;
    expect(row.encryptedMeta).toEqual(nextMeta);
  });

  it("refuses a malformed metadata header before taking any bytes", async () => {
    const file = await uploadFile(target, alice, "bad-meta.txt", utf8Encode("v1"));
    for (const header of ["not base64 json at all", Buffer.from("[1]").toString("base64"), Buffer.from("{}").toString("base64")]) {
      const saved = await putBlob(target, alice.token, file.id, "data", encryptBytes(utf8Encode("v2"), file.key), {
        "x-encrypted-meta": header,
      });
      expect(saved.statusCode, header).toBe(400);
      expect(saved.json()).toEqual({ error: "invalid request" });
    }
    expect((await syncFor(target, alice)).files.find((f) => f.id === file.id)!.generation).toBe(0);
  });

  it("answers 404 for a file with no content, a stranger's file, and a missing file", async () => {
    const empty = await createFile(target, alice, "empty.bin");
    const theirs = await uploadFile(target, bob, "bob.bin", utf8Encode("bob"));
    for (const id of [empty.id, theirs.id, "00000000-0000-4000-8000-000000000000"]) {
      const got = await getBlob(target, alice.token, id, "data");
      expect(got.statusCode, id).toBe(404);
      expect(got.json()).toEqual({ error: "blob not found" });
    }
    const put = await putBlob(target, alice.token, theirs.id, "data", utf8Encode("x"));
    expect(put.statusCode).toBe(404);
    expect(put.json()).toEqual({ error: "file not found" });
  });

  it("requires a session", async () => {
    const file = await uploadFile(target, alice, "anon.bin", utf8Encode("x"));
    for (const request of [
      { method: "GET", url: `/api/files/${file.id}/data` },
      { method: "PUT", url: `/api/files/${file.id}/data`, headers: OCTETS, payload: utf8Encode("x") },
      { method: "GET", url: `/api/files/${file.id}/thumbnail` },
    ]) {
      const response = await target.inject(request);
      expect(response.statusCode, request.url).toBe(401);
      expect(response.json()).toEqual({ error: "authentication required" });
    }
  });

  it("pokes the change feed for content and preview uploads", async () => {
    const file = await createFile(target, alice, "poked.bin");
    const feed = await new Feed().open(target.baseUrl, alice.token);
    const before = (await feed.next()).seq;
    await putBlob(target, alice.token, file.id, "data", encryptBytes(utf8Encode("x"), file.key));
    const afterData = (await feed.nextAbove(before)).seq;
    await putBlob(target, alice.token, file.id, "thumbnail", encryptBytes(utf8Encode("t"), file.key));
    expect((await feed.nextAbove(afterData)).seq).toBe((await syncFor(target, alice)).seq);
    feed.close();
  });
});

describe("previews and search indexes", () => {
  it("round-trip out of band of the metadata row and advertise their sizes", async () => {
    const file = await uploadFile(target, alice, "indexed.txt", utf8Encode("body"));
    const text = encryptBytes(utf8Encode("the searchable words live here, not in sync rows"), file.key);
    const thumb = encryptBytes(payload(300), file.key);
    const putIndex = await putBlob(target, alice.token, file.id, "index", text);
    expect(putIndex.statusCode).toBe(200);
    expect(putIndex.json()).toEqual({ size: text.length });
    const putThumb = await putBlob(target, alice.token, file.id, "thumbnail", thumb);
    expect(putThumb.json()).toEqual({ size: thumb.length });

    const gotIndex = await getBlob(target, alice.token, file.id, "index");
    expect(gotIndex.statusCode).toBe(200);
    expect(gotIndex.headers["content-length"]).toBe(String(text.length));
    expect(gotIndex.headers["x-generation"]).toBeUndefined();
    expect(new Uint8Array(gotIndex.rawPayload)).toEqual(text);
    const gotThumb = await getBlob(target, alice.token, file.id, "thumbnail");
    expect(new Uint8Array(gotThumb.rawPayload)).toEqual(thumb);

    const row = (await syncFor(target, alice)).files.find((f) => f.id === file.id)!;
    expect(row.indexSize).toBe(text.length);
    expect(row.thumbSize).toBe(thumb.length);
    expect(existsSync(blobPath(`${file.id}.idx`))).toBe(true);
    expect(existsSync(blobPath(`${file.id}.thumb`))).toBe(true);
  });

  it("answer 404 when a file has none, or belongs to someone else", async () => {
    const file = await uploadFile(target, alice, "plain.bin", utf8Encode("x"));
    for (const kind of ["thumbnail", "index"] as const) {
      const got = await getBlob(target, alice.token, file.id, kind);
      expect(got.statusCode).toBe(404);
      expect(got.json()).toEqual({ error: "blob not found" });
    }
    await putBlob(target, alice.token, file.id, "index", encryptBytes(utf8Encode("secret"), file.key));
    const foreign = await getBlob(target, bob.token, file.id, "index");
    expect(foreign.statusCode).toBe(404);
  });

  it("count against the quota and free their space when replaced", async () => {
    const file = await uploadFile(target, alice, "requota.txt", utf8Encode("x"));
    const before = await usedBytes(target, alice.token);
    await putBlob(target, alice.token, file.id, "index", encryptBytes(new Uint8Array(10_000), file.key));
    const withIndex = await usedBytes(target, alice.token);
    expect(withIndex - before).toBeGreaterThan(9_000);
    await putBlob(target, alice.token, file.id, "index", encryptBytes(new Uint8Array(100), file.key));
    expect(await usedBytes(target, alice.token)).toBeLessThan(withIndex);
  });

  it("a content replace drops the preview so any device re-derives it", async () => {
    const file = await uploadFile(target, alice, "photo.jpg", utf8Encode("original image bytes"));
    await putBlob(target, alice.token, file.id, "thumbnail", encryptBytes(utf8Encode("preview"), file.key));
    expect((await getBlob(target, alice.token, file.id, "thumbnail")).statusCode).toBe(200);
    await putBlob(target, alice.token, file.id, "data", encryptBytes(utf8Encode("replacement image bytes"), file.key));
    expect((await getBlob(target, alice.token, file.id, "thumbnail")).statusCode).toBe(404);
    expect((await syncFor(target, alice)).files.find((f) => f.id === file.id)!.thumbSize).toBe(0);
    expect(existsSync(blobPath(`${file.id}.thumb`))).toBe(false);
  });
});

describe("quota", () => {
  it("refuses content past the storage quota and reports usage", async () => {
    const file = await createFile(target, alice, "big.bin");
    const upload = await putBlob(target, alice.token, file.id, "data", encryptBytes(new Uint8Array(QUOTA), file.key));
    expect(upload.statusCode).toBe(413);
    expect(upload.json()).toEqual({ error: "storage quota exceeded" });
    expect((await syncFor(target, alice)).files.find((f) => f.id === file.id)!.uploaded).toBe(false);
    expect(blobsOf(file.id)).toEqual([]);
    const user = await target.inject({ method: "GET", url: "/api/user", headers: bearer(alice.token) });
    expect(user.json().quotaBytes).toBe(QUOTA);
    expect(user.json().usedBytes).toBeGreaterThan(0);
  });
});

describe("ranges", () => {
  let id: string;
  let ciphertext: Uint8Array;

  beforeAll(async () => {
    const file = await uploadFile(target, alice, "ranged.mp4", payload(64 * 1024));
    id = file.id;
    ciphertext = file.ciphertext;
  });

  const ranged = (range: string) => getBlob(target, alice.token, id, "data", { range });

  it("serves an inner range with 206 and the exact bytes", async () => {
    const response = await ranged("bytes=100-299");
    expect(response.statusCode).toBe(206);
    expect(response.headers["content-range"]).toBe(`bytes 100-299/${ciphertext.length}`);
    expect(response.headers["content-length"]).toBe("200");
    expect(response.headers["accept-ranges"]).toBe("bytes");
    expect(response.headers["x-generation"]).toBe("0");
    expect(sameBytes(new Uint8Array(response.rawPayload), ciphertext.subarray(100, 300))).toBe(true);
  });

  it("serves open-ended and suffix ranges", async () => {
    const open = await ranged(`bytes=${ciphertext.length - 50}-`);
    expect(open.statusCode).toBe(206);
    expect(sameBytes(new Uint8Array(open.rawPayload), ciphertext.subarray(ciphertext.length - 50))).toBe(true);
    const suffix = await ranged("bytes=-32");
    expect(suffix.statusCode).toBe(206);
    expect(suffix.headers["content-range"]).toBe(`bytes ${ciphertext.length - 32}-${ciphertext.length - 1}/${ciphertext.length}`);
    expect(sameBytes(new Uint8Array(suffix.rawPayload), ciphertext.subarray(ciphertext.length - 32))).toBe(true);
  });

  it("clamps an overlong end and refuses an unsatisfiable start", async () => {
    const clamped = await ranged(`bytes=0-${ciphertext.length * 2}`);
    expect(clamped.statusCode).toBe(206);
    expect(clamped.rawPayload.length).toBe(ciphertext.length);
    for (const range of [`bytes=${ciphertext.length}-`, "bytes=-0", "bytes=5-2", "bytes=x-y"]) {
      const beyond = await ranged(range);
      expect(beyond.statusCode, range).toBe(416);
      expect(beyond.headers["content-range"]).toBe(`bytes */${ciphertext.length}`);
      expect(beyond.json()).toEqual({ error: "range not satisfiable" });
    }
  });

  it("still serves the whole blob without a range header", async () => {
    const whole = await getBlob(target, alice.token, id, "data");
    expect(whole.statusCode).toBe(200);
    expect(sameBytes(new Uint8Array(whole.rawPayload), ciphertext)).toBe(true);
  });
});

describe("deleting for good", () => {
  it("removes every stored byte of the file", async () => {
    const file = await uploadFile(target, alice, "purge.txt", utf8Encode("gen zero"));
    await putBlob(target, alice.token, file.id, "data", encryptBytes(utf8Encode("gen one"), file.key));
    await putBlob(target, alice.token, file.id, "data", encryptBytes(utf8Encode("gen two"), file.key));
    await putBlob(target, alice.token, file.id, "thumbnail", encryptBytes(utf8Encode("t"), file.key));
    await putBlob(target, alice.token, file.id, "index", encryptBytes(utf8Encode("i"), file.key));
    expect(blobsOf(file.id).sort()).toEqual([file.id, `${file.id}.g1`, `${file.id}.g2`, `${file.id}.idx`, `${file.id}.thumb`].sort());
    const trashed = await target.inject({ method: "DELETE", url: `/api/files/${file.id}`, headers: bearer(alice.token) });
    expect(trashed.statusCode).toBe(204);
    const purged = await target.inject({ method: "DELETE", url: `/api/trash/${file.id}`, headers: bearer(alice.token) });
    expect(purged.statusCode).toBe(204);
    expect(blobsOf(file.id)).toEqual([]);
    expect((await getBlob(target, alice.token, file.id, "data")).statusCode).toBe(404);
  });
});

describe("large content", () => {
  it("streams past the size a JSON body may have", async () => {
    const roomy = await startTarget({ quotaBytes: 64 * 1024 * 1024 });
    try {
      const account = await register(roomy, "roomy@example.com");
      const plain = payload(17 * 1024 * 1024);
      const file = await createFile(roomy, account, "large.bin");
      const ciphertext = encryptBytes(plain, file.key);
      const put = await putBlob(roomy, account.token, file.id, "data", ciphertext);
      expect(put.statusCode).toBe(200);
      expect(put.json().size).toBe(ciphertext.length);
      const got = await getBlob(roomy, account.token, file.id, "data");
      expect(got.statusCode).toBe(200);
      expect(got.rawPayload.length).toBe(ciphertext.length);
      expect(sameBytes(new Uint8Array(got.rawPayload), ciphertext)).toBe(true);
      expect(sameBytes(decryptBytes(new Uint8Array(got.rawPayload), file.key), plain)).toBe(true);
    } finally {
      await roomy.close();
    }
  });
});
