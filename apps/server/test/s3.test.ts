import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeleteObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import {
  ready,
  generateAccountKeys,
  generateKey,
  secretBoxSeal,
  encryptBytes,
  decryptBytes,
  encryptFileMetadata,
} from "@engramer/crypto";
import { buildApp } from "../src/app.js";

/**
 * Exercises the S3-compatible blob backend against a real object store.
 * Gated behind ENGRAMER_TEST_S3 (an endpoint URL, e.g. a local MinIO) so the
 * default suite needs no external services:
 *
 *   docker run -d -p 9000:9000 minio/minio server /data
 *   ENGRAMER_TEST_S3=http://127.0.0.1:9000 pnpm --filter @engramer/server test
 */
const endpoint = process.env.ENGRAMER_TEST_S3;

describe.skipIf(!endpoint)("s3 blob store", () => {
  it("round-trips ciphertext through the object store", async () => {
    await ready();
    process.env.ENGRAMER_S3_ENDPOINT = endpoint;
    process.env.ENGRAMER_S3_BUCKET = `engramer-test-${Date.now()}`;
    process.env.ENGRAMER_S3_ACCESS_KEY = process.env.ENGRAMER_TEST_S3_KEY ?? "minioadmin";
    process.env.ENGRAMER_S3_SECRET_KEY = process.env.ENGRAMER_TEST_S3_SECRET ?? "minioadmin";

    const dataDir = mkdtempSync(join(tmpdir(), "engramer-s3-"));
    const app = await buildApp({ dataDir, webDistDir: null });
    try {
      const keys = generateAccountKeys("an s3 test password");
      const registered = await app.inject({
        method: "POST",
        url: "/api/auth/register",
        payload: { email: "s3@example.com", loginKey: keys.loginKey, keyAttributes: keys.keyAttributes },
      });
      const token = registered.json().token as string;
      const auth = { authorization: `Bearer ${token}` };

      const fileKey = generateKey();
      const content = crypto.getRandomValues(new Uint8Array(64 * 1024));
      const created = await app.inject({
        method: "POST",
        url: "/api/files",
        headers: auth,
        payload: {
          encryptedKey: secretBoxSeal(fileKey, keys.masterKey),
          encryptedMeta: encryptFileMetadata(
            { name: "s3.bin", mime: "application/octet-stream", size: content.length, mtime: 0 },
            fileKey,
          ),
        },
      });
      const id = created.json().id as string;

      const uploaded = await app.inject({
        method: "PUT",
        url: `/api/files/${id}/data`,
        headers: { ...auth, "content-type": "application/octet-stream" },
        payload: Buffer.from(encryptBytes(content, fileKey)),
      });
      expect(uploaded.statusCode).toBe(200);

      const download = await app.inject({
        method: "GET",
        url: `/api/files/${id}/data`,
        headers: auth,
      });
      expect(download.statusCode).toBe(200);
      expect(decryptBytes(new Uint8Array(download.rawPayload), fileKey)).toEqual(content);

      // Versioning against the object store: replace, then restore, and both
      // generations serve their exact bytes through S3-backed blobs.
      const replacement = crypto.getRandomValues(new Uint8Array(32 * 1024));
      const replaced = await app.inject({
        method: "PUT",
        url: `/api/files/${id}/data`,
        headers: { ...auth, "content-type": "application/octet-stream" },
        payload: Buffer.from(encryptBytes(replacement, fileKey)),
      });
      expect(replaced.statusCode).toBe(200);
      const current = await app.inject({ method: "GET", url: `/api/files/${id}/data`, headers: auth });
      expect(decryptBytes(new Uint8Array(current.rawPayload), fileKey)).toEqual(replacement);

      const versions = await app.inject({
        method: "GET",
        url: `/api/files/${id}/versions`,
        headers: auth,
      });
      const versionList = versions.json().versions as Array<{ generation: number; size: number }>;
      expect(versionList).toHaveLength(1);
      const version = versionList[0]!;
      const versionData = await app.inject({
        method: "GET",
        url: `/api/files/${id}/versions/${version.generation}/data`,
        headers: auth,
      });
      expect(decryptBytes(new Uint8Array(versionData.rawPayload), fileKey)).toEqual(content);

      const restored = await app.inject({
        method: "POST",
        url: `/api/files/${id}/versions/${version.generation}/restore`,
        headers: auth,
        payload: {
          encryptedMeta: encryptFileMetadata(
            { name: "s3.bin", mime: "application/octet-stream", size: version.size, mtime: 0 },
            fileKey,
          ),
        },
      });
      expect(restored.statusCode).toBe(200);
      const reverted = await app.inject({ method: "GET", url: `/api/files/${id}/data`, headers: auth });
      expect(decryptBytes(new Uint8Array(reverted.rawPayload), fileKey)).toEqual(content);

      // Permanent delete removes every generation's object as well.
      await app.inject({ method: "DELETE", url: `/api/files/${id}`, headers: auth });
      const gone = await app.inject({ method: "DELETE", url: `/api/trash/${id}`, headers: auth });
      expect(gone.statusCode).toBe(204);
    } finally {
      await app.close();
      rmSync(dataDir, { recursive: true, force: true });
      delete process.env.ENGRAMER_S3_ENDPOINT;
      delete process.env.ENGRAMER_S3_BUCKET;
      delete process.env.ENGRAMER_S3_ACCESS_KEY;
      delete process.env.ENGRAMER_S3_SECRET_KEY;
    }
  });

  it("serves cached derived blobs without the object store and paces requests to budget", async () => {
    await ready();
    process.env.ENGRAMER_S3_ENDPOINT = endpoint;
    process.env.ENGRAMER_S3_BUCKET = `engramer-cache-test-${Date.now()}`;
    process.env.ENGRAMER_S3_ACCESS_KEY = process.env.ENGRAMER_TEST_S3_KEY ?? "minioadmin";
    process.env.ENGRAMER_S3_SECRET_KEY = process.env.ENGRAMER_TEST_S3_SECRET ?? "minioadmin";
    process.env.ENGRAMER_BLOB_CACHE_BYTES = String(16 * 1024 * 1024);
    process.env.ENGRAMER_S3_MAX_TPS = "5";

    const dataDir = mkdtempSync(join(tmpdir(), "engramer-s3-cache-"));
    const app = await buildApp({ dataDir, webDistDir: null });
    try {
      const keys = generateAccountKeys("an s3 cache test password");
      const registered = await app.inject({
        method: "POST",
        url: "/api/auth/register",
        payload: { email: "s3cache@example.com", loginKey: keys.loginKey, keyAttributes: keys.keyAttributes },
      });
      const token = registered.json().token as string;
      const auth = { authorization: `Bearer ${token}` };

      const fileKey = generateKey();
      const thumb = crypto.getRandomValues(new Uint8Array(2 * 1024));
      const created = await app.inject({
        method: "POST",
        url: "/api/files",
        headers: auth,
        payload: {
          encryptedKey: secretBoxSeal(fileKey, keys.masterKey),
          encryptedMeta: encryptFileMetadata(
            { name: "cached.jpg", mime: "image/jpeg", size: 4, mtime: 0 },
            fileKey,
          ),
        },
      });
      const id = created.json().id as string;
      await app.inject({
        method: "PUT",
        url: `/api/files/${id}/data`,
        headers: { ...auth, "content-type": "application/octet-stream" },
        payload: Buffer.from(encryptBytes(new Uint8Array([1, 2, 3, 4]), fileKey)),
      });
      const thumbCipher = Buffer.from(encryptBytes(thumb, fileKey));
      await app.inject({
        method: "PUT",
        url: `/api/files/${id}/thumbnail`,
        headers: { ...auth, "content-type": "application/octet-stream" },
        payload: thumbCipher,
      });

      // First read warms the cache; then delete the object OUT OF BAND from
      // the bucket (raw client, bypassing the cache wrapper), and the
      // thumbnail must still be served: proof the bytes came from the local
      // hot tier, not the object store.
      const first = await app.inject({ method: "GET", url: `/api/files/${id}/thumbnail`, headers: auth });
      expect(first.statusCode).toBe(200);
      const raw = new S3Client({
        endpoint,
        region: "us-east-1",
        forcePathStyle: true,
        credentials: {
          accessKeyId: process.env.ENGRAMER_S3_ACCESS_KEY!,
          secretAccessKey: process.env.ENGRAMER_S3_SECRET_KEY!,
        },
      });
      await raw.send(
        new DeleteObjectCommand({ Bucket: process.env.ENGRAMER_S3_BUCKET, Key: `${id}.thumb` }),
      );
      const cached = await app.inject({ method: "GET", url: `/api/files/${id}/thumbnail`, headers: auth });
      expect(cached.statusCode).toBe(200);
      expect(decryptBytes(new Uint8Array(cached.rawPayload), fileKey)).toEqual(thumb);

      // Budget: at 5 TPS, six content downloads (cache never touches data
      // blobs) must spread across at least ~1 second.
      const started = Date.now();
      for (let i = 0; i < 6; i++) {
        const download = await app.inject({ method: "GET", url: `/api/files/${id}/data`, headers: auth });
        expect(download.statusCode).toBe(200);
      }
      expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    } finally {
      await app.close();
      rmSync(dataDir, { recursive: true, force: true });
      delete process.env.ENGRAMER_S3_ENDPOINT;
      delete process.env.ENGRAMER_S3_BUCKET;
      delete process.env.ENGRAMER_S3_ACCESS_KEY;
      delete process.env.ENGRAMER_S3_SECRET_KEY;
      delete process.env.ENGRAMER_BLOB_CACHE_BYTES;
      delete process.env.ENGRAMER_S3_MAX_TPS;
    }
  });
});
