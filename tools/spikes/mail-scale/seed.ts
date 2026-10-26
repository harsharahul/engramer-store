/**
 * Seeds a throwaway local server with synthetic mail through the real API
 * and the real crypto, for the mail scale spike. Three ways to store the
 * search text:
 *   A  one index blob per message (today's mechanism)
 *   B  one shared shard blob per 1,000 messages
 *   C  text inline in the metadata (the legacy path the client still reads)
 *
 * Run: pnpm --dir apps/server exec tsx ../../tools/spikes/mail-scale/seed.ts \
 *        --base http://127.0.0.1:3182 --count 200 --mode A --seed 7 [--verify]
 */

import {
  chunkedEncrypt,
  contentDigest,
  decryptFileMetadata,
  deriveKeyEncryptionKey,
  deriveLoginKey,
  encryptBytes,
  encryptFileMetadata,
  encryptFolderMetadata,
  generateAccountKeys,
  generateKey,
  ready,
  secretBoxOpen,
  secretBoxSeal,
  utf8Encode,
} from "../../../packages/crypto/src/index.ts";
import { makeCorpus } from "./corpus.mjs";

const EMAIL = "spike-mail@example.com";
const PASSWORD = "spike lantern velvet harbor";
const SHARD_SIZE = 1_000;
const CONCURRENCY = 6;

function arg(name: string, fallback?: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at === -1 || at + 1 >= process.argv.length) {
    if (fallback === undefined) {
      throw new Error(`missing --${name}`);
    }
    return fallback;
  }
  return process.argv[at + 1]!;
}

const BASE = arg("base", "http://127.0.0.1:3182");
const COUNT = Number(arg("count"));
const MODE = arg("mode", "A") as "A" | "B" | "C";
const SEED = Number(arg("seed", "7"));
const VERIFY = process.argv.includes("--verify");

let token = "";

/** One request, retried on 429 after the server's Retry-After. */
async function call(method: string, path: string, body?: unknown, raw?: Uint8Array): Promise<Response> {
  for (;;) {
    const headers: Record<string, string> = {};
    if (token) {
      headers.authorization = `Bearer ${token}`;
    }
    let payload: BodyInit | undefined;
    if (raw) {
      headers["content-type"] = "application/octet-stream";
      payload = raw;
    } else if (body !== undefined) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const response = await fetch(BASE + path, { method, headers, body: payload });
    if (response.status === 429) {
      const wait = Number(response.headers.get("retry-after") ?? "1");
      await new Promise((resolve) => setTimeout(resolve, Math.max(1, wait) * 1_000));
      continue;
    }
    return response;
  }
}

async function ok(response: Response, what: string): Promise<any> {
  if (!response.ok) {
    throw new Error(`${what}: HTTP ${response.status} ${await response.text()}`);
  }
  const text = await response.text();
  return text ? JSON.parse(text) : {};
}

/** Registers the spike account, or signs in when it already exists. */
async function signIn(): Promise<Uint8Array> {
  const keys = generateAccountKeys(PASSWORD);
  const registered = await call("POST", "/api/auth/register", {
    email: EMAIL,
    loginKey: keys.loginKey,
    keyAttributes: keys.keyAttributes,
  });
  if (registered.ok) {
    token = (await registered.json()).token;
    return keys.masterKey;
  }
  const { kdf } = await ok(await call("GET", `/api/auth/attributes?email=${encodeURIComponent(EMAIL)}`), "attributes");
  const { kek } = deriveKeyEncryptionKey(PASSWORD, kdf);
  const session = await ok(
    await call("POST", "/api/auth/login", { email: EMAIL, loginKey: deriveLoginKey(kek) }),
    "login",
  );
  token = session.token;
  return secretBoxOpen(session.keyAttributes.encryptedMasterKey, kek);
}

async function createFile(folderId: string, meta: Record<string, unknown>, masterKey: Uint8Array) {
  const fileKey = generateKey();
  const created = await ok(
    await call("POST", "/api/files", {
      folderId,
      encryptedKey: secretBoxSeal(fileKey, masterKey),
      encryptedMeta: encryptFileMetadata(meta as never, fileKey),
    }),
    "create file",
  );
  return { id: created.id as string, fileKey };
}

async function putBlob(id: string, kind: "data" | "index", bytes: Uint8Array) {
  await ok(await call("PUT", `/api/files/${id}/${kind}`, undefined, bytes), `put ${kind}`);
}

function indexBlob(body: unknown, key: Uint8Array): Uint8Array {
  return encryptBytes(utf8Encode("EIDX1:" + JSON.stringify(body)), key);
}

/** Runs `work` over `items` with a fixed number in flight. */
async function pool<T>(items: T[], work: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < items.length) {
        await work(items[next++]!);
      }
    }),
  );
}

async function main() {
  await ready();
  const started = Date.now();
  const masterKey = await signIn();
  const folderKey = generateKey();
  const folder = await ok(
    await call("POST", "/api/folders", {
      parentId: null,
      encryptedKey: secretBoxSeal(folderKey, masterKey),
      encryptedMeta: encryptFolderMetadata({ name: "Mail" }, folderKey),
    }),
    "create folder",
  );
  const corpus = makeCorpus(COUNT, SEED);
  let shards = 0;
  for (let start = 0; start < corpus.length; start += SHARD_SIZE) {
    const group = corpus.slice(start, start + SHARD_SIZE);
    let shard: { id: string; fileKey: Uint8Array } | null = null;
    if (MODE === "B") {
      shard = await createFile(
        folder.id,
        {
          name: `.mail-index-${shards}`,
          mime: "application/x-engram-mail-index",
          size: 0,
          mtime: Date.now(),
          category: "Mail",
          tags: [],
          hasText: false,
        },
        masterKey,
      );
      shards++;
    }
    const texts: Record<string, string> = {};
    await pool(group, async (message) => {
      const bytes = utf8Encode(message.raw);
      const meta: Record<string, unknown> = {
        name: `${message.subject}.eml`,
        mime: "message/rfc822",
        size: bytes.length,
        mtime: message.date,
        category: "Mail",
        tags: [],
        digest: contentDigest(bytes),
        hasText: MODE === "A",
      };
      if (MODE === "B") {
        meta.shard = shard!.id;
      } else if (MODE === "C") {
        meta.text = message.text;
      }
      const { id, fileKey } = await createFile(folder.id, meta, masterKey);
      await putBlob(id, "data", chunkedEncrypt(bytes, fileKey));
      if (MODE === "A") {
        await putBlob(id, "index", indexBlob({ text: message.text }, fileKey));
      } else if (MODE === "B") {
        texts[id] = message.text;
      }
    });
    if (shard) {
      await putBlob(shard.id, "data", chunkedEncrypt(utf8Encode("mail index shard"), shard.fileKey));
      await putBlob(shard.id, "index", indexBlob({ texts }, shard.fileKey));
    }
  }
  const seconds = Math.round((Date.now() - started) / 100) / 10;
  console.log(JSON.stringify({ mode: MODE, count: COUNT, shards, files: COUNT + shards, seconds }));

  if (VERIFY) {
    const sync = await ok(await call("GET", "/api/sync?since=0"), "sync");
    const files = (sync.files as Array<{ deleted?: boolean; encryptedKey: never; encryptedMeta: never }>).filter(
      (f) => !f.deleted,
    );
    const sample = files[0]!;
    const meta = decryptFileMetadata(sample.encryptedMeta, secretBoxOpen(sample.encryptedKey, masterKey)) as {
      mime: string;
    };
    if (files.length < COUNT + shards || (meta.mime !== "message/rfc822" && meta.mime !== "application/x-engram-mail-index")) {
      console.error(`VERIFY FAILED: ${files.length} files, first mime ${meta.mime}`);
      process.exit(1);
    }
    console.log(`VERIFY OK: ${files.length} files, first mime ${meta.mime}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
