import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  S3Client,
  ListBucketsCommand,
  ListObjectsV2Command,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import {
  ready,
  generateAccountKeys,
  generateKey,
  secretBoxSeal,
  encryptBytes,
  encryptFileMetadata,
  encryptFolderMetadata,
  utf8Encode,
} from "@engramer/crypto";
import { buildApp } from "../../server/src/app.js";
import { Vault } from "../src/vault.js";
import { buildBridge } from "../src/server.js";

/**
 * End to end: a real Engram Store server holds only ciphertext; the bridge logs
 * in, and an ordinary AWS S3 client reads the vault back through the bridge.
 */

const EMAIL = "bridge@example.com";
const PASSWORD = "correct horse battery staple";
const CONTENT = "quarterly numbers ARDENT-MERIDIAN plus a long tail ".repeat(40);

let serverApp: Awaited<ReturnType<typeof buildApp>>;
let bridgeApp: Awaited<ReturnType<typeof buildBridge>>;
let dataDir: string;
let s3: S3Client;
let bridgeUrl: string;

beforeAll(async () => {
  await ready();
  dataDir = mkdtempSync(join(tmpdir(), "engram-bridge-"));
  serverApp = await buildApp({ dataDir, webDistDir: null });
  const serverUrl = await serverApp.listen({ port: 0, host: "127.0.0.1" });

  // Provision an account with one folder ("Documents") and one file in it.
  const keys = generateAccountKeys(PASSWORD);
  const reg = await serverApp.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { email: EMAIL, loginKey: keys.loginKey, keyAttributes: keys.keyAttributes },
  });
  const token = reg.json().token as string;
  const auth = { authorization: `Bearer ${token}` };

  const folderKey = generateKey();
  const folder = await serverApp.inject({
    method: "POST",
    url: "/api/folders",
    headers: auth,
    payload: {
      encryptedKey: secretBoxSeal(folderKey, keys.masterKey),
      encryptedMeta: encryptFolderMetadata({ name: "Documents" }, folderKey),
    },
  });
  const folderId = folder.json().id as string;

  const fileKey = generateKey();
  const bytes = utf8Encode(CONTENT);
  const created = await serverApp.inject({
    method: "POST",
    url: "/api/files",
    headers: auth,
    payload: {
      folderId,
      encryptedKey: secretBoxSeal(fileKey, keys.masterKey),
      encryptedMeta: encryptFileMetadata(
        { name: "report.txt", mime: "text/plain", size: bytes.length, mtime: 1700000000000 },
        fileKey,
      ),
    },
  });
  const fileId = created.json().id as string;
  await serverApp.inject({
    method: "PUT",
    url: `/api/files/${fileId}/data`,
    headers: { ...auth, "content-type": "application/octet-stream" },
    payload: Buffer.from(encryptBytes(bytes, fileKey)),
  });

  // The bridge connects to the server as this user and serves S3.
  const vault = new Vault(serverUrl, EMAIL, PASSWORD);
  await vault.connect();
  bridgeApp = buildBridge(vault, { accessKeyId: "AKIABRIDGE", secretAccessKey: "bridge-secret-key" });
  bridgeUrl = await bridgeApp.listen({ port: 0, host: "127.0.0.1" });

  s3 = new S3Client({
    endpoint: bridgeUrl,
    region: "us-east-1",
    forcePathStyle: true,
    credentials: { accessKeyId: "AKIABRIDGE", secretAccessKey: "bridge-secret-key" },
  });
});

afterAll(async () => {
  await bridgeApp?.close();
  await serverApp?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

async function streamToString(body: unknown): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

describe("local S3 bridge, read path", () => {
  it("lists the top-level folder as a bucket", async () => {
    const out = await s3.send(new ListBucketsCommand({}));
    expect(out.Buckets?.map((b) => b.Name)).toContain("Documents");
  });

  it("lists objects in a bucket", async () => {
    const out = await s3.send(new ListObjectsV2Command({ Bucket: "Documents" }));
    const keys = out.Contents?.map((o) => o.Key) ?? [];
    expect(keys).toContain("report.txt");
    expect(out.Contents?.find((o) => o.Key === "report.txt")?.Size).toBe(
      utf8Encode(CONTENT).length,
    );
  });

  it("downloads and decrypts an object to the original plaintext", async () => {
    const out = await s3.send(new GetObjectCommand({ Bucket: "Documents", Key: "report.txt" }));
    expect(await streamToString(out.Body)).toBe(CONTENT);
  });

  it("serves a byte range", async () => {
    const out = await s3.send(
      new GetObjectCommand({ Bucket: "Documents", Key: "report.txt", Range: "bytes=0-9" }),
    );
    expect(out.ContentRange).toBe(`bytes 0-9/${utf8Encode(CONTENT).length}`);
    expect(await streamToString(out.Body)).toBe(CONTENT.slice(0, 10));
  });

  it("rejects a client using the wrong secret", async () => {
    const bad = new S3Client({
      endpoint: bridgeUrl,
      region: "us-east-1",
      forcePathStyle: true,
      credentials: { accessKeyId: "AKIABRIDGE", secretAccessKey: "wrong-secret" },
    });
    await expect(bad.send(new ListBucketsCommand({}))).rejects.toThrow();
  });
});
