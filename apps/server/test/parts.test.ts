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
  type AccountKeys,
  type SecretBox,
} from "@engramer/crypto";
import { buildApp } from "../src/app.js";

const QUOTA_BYTES = 2 * 1024 * 1024;

let app: FastifyInstance;
let dataDir: string;
let account: AccountKeys;
let token: string;
let otherToken: string;

const authHeader = (t = token) => ({ authorization: `Bearer ${t}` });

function meta(name: string, size: number, fileKey: Uint8Array): SecretBox {
  return encryptFileMetadata({ name, mime: "video/mp4", size, mtime: Date.now() }, fileKey);
}

async function createFileRow(name: string): Promise<{ id: string; fileKey: Uint8Array }> {
  const fileKey = generateKey();
  const created = await app.inject({
    method: "POST",
    url: "/api/files",
    headers: authHeader(),
    payload: {
      folderId: null,
      encryptedKey: secretBoxSeal(fileKey, account.masterKey),
      encryptedMeta: meta(name, 0, fileKey),
    },
  });
  expect(created.statusCode).toBe(201);
  return { id: created.json().id as string, fileKey };
}

async function begin(id: string, size: number, expected = 201, t = token): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: `/api/files/${id}/data/parts`,
    headers: authHeader(t),
    payload: { size },
  });
  expect(response.statusCode).toBe(expected);
  return expected === 201 ? (response.json().session as string) : "";
}

async function putPart(
  id: string,
  session: string,
  partNo: number,
  bytes: Buffer,
  expected = 200,
) {
  const response = await app.inject({
    method: "PUT",
    url: `/api/files/${id}/data/parts/${session}/${partNo}`,
    headers: { ...authHeader(), "content-type": "application/octet-stream" },
    payload: bytes,
  });
  expect(response.statusCode).toBe(expected);
  return response;
}

async function complete(id: string, session: string, expected = 200) {
  const response = await app.inject({
    method: "POST",
    url: `/api/files/${id}/data/parts/${session}/complete`,
    headers: authHeader(),
  });
  expect(response.statusCode).toBe(expected);
  return response;
}

async function download(id: string, fileKey: Uint8Array): Promise<Uint8Array> {
  const response = await app.inject({
    method: "GET",
    url: `/api/files/${id}/data`,
    headers: authHeader(),
  });
  expect(response.statusCode).toBe(200);
  return decryptBytes(new Uint8Array(response.rawPayload), fileKey);
}

async function fileDto(id: string): Promise<{ size: number; uploaded: boolean }> {
  const response = await app.inject({
    method: "GET",
    url: "/api/sync?since=0",
    headers: authHeader(),
  });
  const dto = (response.json().files as Array<{ id: string; size: number; uploaded: boolean }>).find(
    (f) => f.id === id,
  );
  expect(dto).toBeDefined();
  return dto!;
}

/** Splits a buffer into n contiguous parts. */
function split(bytes: Buffer, n: number): Buffer[] {
  const per = Math.ceil(bytes.length / n);
  const parts: Buffer[] = [];
  for (let i = 0; i < bytes.length; i += per) {
    parts.push(bytes.subarray(i, Math.min(i + per, bytes.length)));
  }
  while (parts.length < n) {
    parts.push(Buffer.alloc(0));
  }
  return parts;
}

function payload(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    bytes[i] = (i * 31 + 7) % 251;
  }
  return bytes;
}

beforeAll(async () => {
  await ready();
  dataDir = mkdtempSync(join(tmpdir(), "engramer-parts-test-"));
  app = await buildApp({
    dataDir,
    quotaBytes: QUOTA_BYTES,
    maxVersions: 2,
    webDistDir: null,
  });
  account = generateAccountKeys("parts vault passphrase");
  const registered = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: {
      email: "parts@example.com",
      loginKey: account.loginKey,
      keyAttributes: account.keyAttributes,
    },
  });
  token = registered.json().token as string;
  const other = generateAccountKeys("other parts passphrase");
  const otherRegistered = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: {
      email: "parts-other@example.com",
      loginKey: other.loginKey,
      keyAttributes: other.keyAttributes,
    },
  });
  otherToken = otherRegistered.json().token as string;
});

afterAll(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("part uploads", () => {
  it("assembles parts into a byte-identical blob and commits the row", async () => {
    const { id, fileKey } = await createFileRow("movie.mp4");
    const content = payload(300 * 1024);
    const ciphertext = Buffer.from(encryptBytes(content, fileKey));
    const session = await begin(id, ciphertext.length);
    const parts = split(ciphertext, 3);
    for (const [i, part] of parts.entries()) {
      await putPart(id, session, i + 1, part);
    }
    const done = await complete(id, session);
    expect(done.json().size).toBe(ciphertext.length);
    expect(Buffer.from(await download(id, fileKey)).equals(Buffer.from(content))).toBe(true);
    const dto = await fileDto(id);
    expect(dto.uploaded).toBe(true);
    expect(dto.size).toBe(ciphertext.length);
  });

  it("lets a retried part replace itself", async () => {
    const { id, fileKey } = await createFileRow("retry.mp4");
    const content = payload(96 * 1024);
    const ciphertext = Buffer.from(encryptBytes(content, fileKey));
    const parts = split(ciphertext, 2);
    const session = await begin(id, ciphertext.length);
    await putPart(id, session, 1, parts[0]!);
    // A garbled attempt at part 2, then the retry with the right bytes.
    const garbled = Buffer.from(parts[1]!);
    garbled[0] = garbled[0]! ^ 0xff;
    await putPart(id, session, 2, garbled);
    await putPart(id, session, 2, parts[1]!);
    await complete(id, session);
    expect(Buffer.from(await download(id, fileKey)).equals(Buffer.from(content))).toBe(true);
  });

  it("refuses to complete with a missing part", async () => {
    const { id, fileKey } = await createFileRow("gap.mp4");
    const ciphertext = Buffer.from(encryptBytes(payload(96 * 1024), fileKey));
    const parts = split(ciphertext, 3);
    const session = await begin(id, ciphertext.length);
    await putPart(id, session, 1, parts[0]!);
    await putPart(id, session, 3, parts[2]!);
    await complete(id, session, 400);
    const dto = await fileDto(id);
    expect(dto.uploaded).toBe(false);
  });

  it("rejects a declared size beyond the quota at begin", async () => {
    const { id } = await createFileRow("huge.mp4");
    await begin(id, QUOTA_BYTES * 2, 413);
  });

  it("rejects parts that overflow the declared size", async () => {
    const { id, fileKey } = await createFileRow("overflow.mp4");
    const ciphertext = Buffer.from(encryptBytes(payload(64 * 1024), fileKey));
    const session = await begin(id, 10 * 1024);
    await putPart(id, session, 1, ciphertext, 413);
  });

  it("hides files and sessions from other accounts", async () => {
    const { id, fileKey } = await createFileRow("private.mp4");
    const ciphertext = Buffer.from(encryptBytes(payload(32 * 1024), fileKey));
    await begin(id, ciphertext.length, 404, otherToken);
    const session = await begin(id, ciphertext.length);
    const foreign = await app.inject({
      method: "PUT",
      url: `/api/files/${id}/data/parts/${session}/1`,
      headers: { authorization: `Bearer ${otherToken}`, "content-type": "application/octet-stream" },
      payload: ciphertext,
    });
    expect(foreign.statusCode).toBe(404);
  });

  it("aborts a session and forgets it", async () => {
    const { id, fileKey } = await createFileRow("aborted.mp4");
    const ciphertext = Buffer.from(encryptBytes(payload(32 * 1024), fileKey));
    const session = await begin(id, ciphertext.length);
    await putPart(id, session, 1, ciphertext);
    const aborted = await app.inject({
      method: "DELETE",
      url: `/api/files/${id}/data/parts/${session}`,
      headers: authHeader(),
    });
    expect(aborted.statusCode).toBe(204);
    await putPart(id, session, 2, ciphertext, 404);
    await complete(id, session, 404);
  });

  it("supersedes a stale session when a new one begins", async () => {
    const { id, fileKey } = await createFileRow("superseded.mp4");
    const content = payload(64 * 1024);
    const ciphertext = Buffer.from(encryptBytes(content, fileKey));
    const first = await begin(id, ciphertext.length);
    await putPart(id, first, 1, split(ciphertext, 2)[0]!);
    const second = await begin(id, ciphertext.length);
    await complete(id, first, 404);
    for (const [i, part] of split(ciphertext, 2).entries()) {
      await putPart(id, second, i + 1, part);
    }
    await complete(id, second);
    expect(Buffer.from(await download(id, fileKey)).equals(Buffer.from(content))).toBe(true);
  });

  it("yields 409 and keeps the other writer's bytes on generation conflict", async () => {
    const { id, fileKey } = await createFileRow("conflict.mp4");
    // Initial content arrives whole.
    const original = payload(24 * 1024);
    await app.inject({
      method: "PUT",
      url: `/api/files/${id}/data`,
      headers: { ...authHeader(), "content-type": "application/octet-stream" },
      payload: Buffer.from(encryptBytes(original, fileKey)),
    });
    // A part session begins against that generation...
    const mine = Buffer.from(encryptBytes(payload(48 * 1024), fileKey));
    const session = await begin(id, mine.length);
    await putPart(id, session, 1, mine);
    // ...but another writer replaces the content first.
    const winner = payload(12 * 1024);
    await app.inject({
      method: "PUT",
      url: `/api/files/${id}/data`,
      headers: { ...authHeader(), "content-type": "application/octet-stream" },
      payload: Buffer.from(encryptBytes(winner, fileKey)),
    });
    await complete(id, session, 409);
    expect(Buffer.from(await download(id, fileKey)).equals(Buffer.from(winner))).toBe(true);
  });

  it("snapshots the displaced generation as a version", async () => {
    const { id, fileKey } = await createFileRow("versioned.mp4");
    const first = payload(16 * 1024);
    await app.inject({
      method: "PUT",
      url: `/api/files/${id}/data`,
      headers: { ...authHeader(), "content-type": "application/octet-stream" },
      payload: Buffer.from(encryptBytes(first, fileKey)),
    });
    const second = payload(32 * 1024);
    const ciphertext = Buffer.from(encryptBytes(second, fileKey));
    const session = await begin(id, ciphertext.length);
    for (const [i, part] of split(ciphertext, 2).entries()) {
      await putPart(id, session, i + 1, part);
    }
    await complete(id, session);
    expect(Buffer.from(await download(id, fileKey)).equals(Buffer.from(second))).toBe(true);
    const versions = await app.inject({
      method: "GET",
      url: `/api/files/${id}/versions`,
      headers: authHeader(),
    });
    expect((versions.json().versions as unknown[]).length).toBe(1);
  });
});

describe("ranged content downloads", () => {
  async function uploaded(): Promise<{ id: string; ciphertext: Buffer }> {
    const { id, fileKey } = await createFileRow("ranged.mp4");
    const ciphertext = Buffer.from(encryptBytes(payload(64 * 1024), fileKey));
    await app.inject({
      method: "PUT",
      url: `/api/files/${id}/data`,
      headers: { ...authHeader(), "content-type": "application/octet-stream" },
      payload: ciphertext,
    });
    return { id, ciphertext };
  }

  async function ranged(id: string, range: string) {
    return app.inject({
      method: "GET",
      url: `/api/files/${id}/data`,
      headers: { ...authHeader(), range },
    });
  }

  it("serves an inner range with 206 and correct bytes", async () => {
    const { id, ciphertext } = await uploaded();
    const response = await ranged(id, "bytes=100-299");
    expect(response.statusCode).toBe(206);
    expect(response.headers["content-range"]).toBe(`bytes 100-299/${ciphertext.length}`);
    expect(response.headers["accept-ranges"]).toBe("bytes");
    expect(Buffer.from(response.rawPayload).equals(ciphertext.subarray(100, 300))).toBe(true);
  });

  it("serves open-ended and suffix ranges", async () => {
    const { id, ciphertext } = await uploaded();
    const open = await ranged(id, `bytes=${ciphertext.length - 50}-`);
    expect(open.statusCode).toBe(206);
    expect(Buffer.from(open.rawPayload).equals(ciphertext.subarray(ciphertext.length - 50))).toBe(true);
    const suffix = await ranged(id, "bytes=-32");
    expect(suffix.statusCode).toBe(206);
    expect(Buffer.from(suffix.rawPayload).equals(ciphertext.subarray(ciphertext.length - 32))).toBe(true);
  });

  it("clamps an overlong end and rejects an unsatisfiable start", async () => {
    const { id, ciphertext } = await uploaded();
    const clamped = await ranged(id, `bytes=0-${ciphertext.length * 2}`);
    expect(clamped.statusCode).toBe(206);
    expect(clamped.rawPayload.length).toBe(ciphertext.length);
    const beyond = await ranged(id, `bytes=${ciphertext.length}-`);
    expect(beyond.statusCode).toBe(416);
    expect(beyond.headers["content-range"]).toBe(`bytes */${ciphertext.length}`);
  });

  it("still serves the whole blob without a range header", async () => {
    const { id, ciphertext } = await uploaded();
    const whole = await app.inject({
      method: "GET",
      url: `/api/files/${id}/data`,
      headers: authHeader(),
    });
    expect(whole.statusCode).toBe(200);
    expect(Buffer.from(whole.rawPayload).equals(ciphertext)).toBe(true);
  });
});
