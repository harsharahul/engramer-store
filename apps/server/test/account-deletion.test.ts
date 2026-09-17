import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  encryptBytes,
  encryptFileMetadata,
  generateAccountKeys,
  generateKey,
  ready,
  secretBoxSeal,
  utf8Encode,
  type AccountKeys,
} from "@engramer/crypto";
import { buildApp } from "../src/app.js";
import { blobKey } from "../src/blobs.js";
import { totpAt } from "../src/totp.js";

/**
 * An account deletes itself: the password is proved again, a second
 * factor when one is on, and then every row and every blob goes. There
 * is nothing soft about it, so the checks are on what remains: nothing
 * for the account, everything for its neighbours.
 */

let app: FastifyInstance;
let dataDir: string;

interface Account {
  keys: AccountKeys;
  token: string;
  email: string;
}

async function register(email: string, phrase: string): Promise<Account> {
  const keys = generateAccountKeys(phrase);
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { email, loginKey: keys.loginKey, keyAttributes: keys.keyAttributes },
  });
  expect(response.statusCode).toBe(201);
  return { keys, token: response.json().token as string, email };
}

const auth = (account: Account) => ({ authorization: `Bearer ${account.token}` });

/** Whether the store still holds a blob: it streams, or it refuses. */
async function blobPresent(key: string): Promise<boolean> {
  try {
    const stream = await app.blobs.get(key);
    stream.destroy();
    return true;
  } catch {
    return false;
  }
}

async function uploadOne(account: Account, name: string): Promise<{ id: string; generation: number }> {
  const fileKey = generateKey();
  const content = utf8Encode(`${name} body`);
  const created = await app.inject({
    method: "POST",
    url: "/api/files",
    headers: auth(account),
    payload: {
      folderId: null,
      encryptedKey: secretBoxSeal(fileKey, account.keys.masterKey),
      encryptedMeta: encryptFileMetadata(
        { name, mime: "application/octet-stream", size: content.length, mtime: 1 },
        fileKey,
      ),
    },
  });
  expect(created.statusCode).toBe(201);
  const id = created.json().id as string;
  const put = await app.inject({
    method: "PUT",
    url: `/api/files/${id}/data`,
    headers: { ...auth(account), "content-type": "application/octet-stream" },
    payload: Buffer.from(encryptBytes(content, fileKey)),
  });
  expect(put.statusCode).toBe(200);
  return { id, generation: (put.json().generation as number) ?? 0 };
}

beforeAll(async () => {
  await ready();
  dataDir = mkdtempSync(join(tmpdir(), "engramer-delete-test-"));
  app = await buildApp({ dataDir, quotaBytes: 512 * 1024, webDistDir: null });
});

afterAll(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("deleting your own account", () => {
  it("refuses without the right password, and the account is untouched", async () => {
    const owner = await register("leaving@example.com", "orchid lantern velvet");
    const wrong = generateAccountKeys("not the password");
    const denied = await app.inject({
      method: "DELETE",
      url: "/api/user",
      headers: auth(owner),
      payload: { loginKey: wrong.loginKey },
    });
    expect(denied.statusCode).toBe(401);
    const still = await app.inject({ method: "GET", url: "/api/user", headers: auth(owner) });
    expect(still.statusCode).toBe(200);
  });

  it("removes every row and blob of the account and leaves the neighbours alone", async () => {
    const owner = await register("gone@example.com", "cedar mosaic thimble");
    const neighbour = await register("stays@example.com", "harbor quill sonnet");
    const mine = await uploadOne(owner, "mine.bin");
    const theirs = await uploadOne(neighbour, "theirs.bin");
    expect(await blobPresent(blobKey(mine.id, "data", mine.generation))).toBe(true);

    const deleted = await app.inject({
      method: "DELETE",
      url: "/api/user",
      headers: auth(owner),
      payload: { loginKey: owner.keys.loginKey },
    });
    expect(deleted.statusCode).toBe(204);

    // The token is dead, the rows are gone, the blob is gone.
    const afterwards = await app.inject({ method: "GET", url: "/api/user", headers: auth(owner) });
    // A token for an account that no longer exists is refused; which
    // refusal the auth hook chooses is its business.
    expect([401, 403]).toContain(afterwards.statusCode);
    const rows = await app.db.get<{ n: number }>(
      "SELECT count(*) AS n FROM files WHERE id = ?",
      mine.id,
    );
    expect(rows?.n).toBe(0);
    const users = await app.db.get<{ n: number }>(
      "SELECT count(*) AS n FROM users WHERE email = ?",
      owner.email,
    );
    expect(users?.n).toBe(0);
    expect(await blobPresent(blobKey(mine.id, "data", mine.generation))).toBe(false);

    // The neighbour's world is as it was.
    const theirRows = await app.db.get<{ n: number }>("SELECT count(*) AS n FROM files WHERE id = ?", theirs.id);
    expect(theirRows?.n).toBe(1);
    expect(await blobPresent(blobKey(theirs.id, "data", theirs.generation))).toBe(true);
    const theirUser = await app.inject({ method: "GET", url: "/api/user", headers: auth(neighbour) });
    expect(theirUser.statusCode).toBe(200);

    // The email is free again.
    const again = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        email: owner.email,
        loginKey: generateAccountKeys("a new start").loginKey,
        keyAttributes: generateAccountKeys("a new start").keyAttributes,
      },
    });
    expect(again.statusCode).toBe(201);
  });

  it("asks for the second factor when two-factor is on", async () => {
    const owner = await register("careful@example.com", "granite lantern quiver");
    const setup = await app.inject({ method: "POST", url: "/api/auth/totp/setup", headers: auth(owner) });
    expect(setup.statusCode).toBe(200);
    const secret = setup.json().secret as string;
    const confirm = await app.inject({
      method: "POST",
      url: "/api/auth/totp/confirm",
      headers: auth(owner),
      payload: { code: totpAt(secret, Date.now()) },
    });
    expect(confirm.statusCode).toBe(200);

    const withoutCode = await app.inject({
      method: "DELETE",
      url: "/api/user",
      headers: auth(owner),
      payload: { loginKey: owner.keys.loginKey },
    });
    expect(withoutCode.statusCode).toBe(401);
    expect(withoutCode.json().twoFactorRequired).toBe(true);

    const wrongCode = await app.inject({
      method: "DELETE",
      url: "/api/user",
      headers: auth(owner),
      payload: { loginKey: owner.keys.loginKey, code: "000000" },
    });
    expect(wrongCode.statusCode).toBe(401);

    // The enrolment consumed this step's code, and a code from the future
    // is outside the window, so the second factor here is one of the
    // recovery codes the enrolment handed out, accepted exactly once.
    const recovery = (confirm.json().recoveryCodes as string[])[0]!;
    const rightCode = await app.inject({
      method: "DELETE",
      url: "/api/user",
      headers: auth(owner),
      payload: { loginKey: owner.keys.loginKey, code: recovery },
    });
    expect(rightCode.statusCode).toBe(204);
  });
});
