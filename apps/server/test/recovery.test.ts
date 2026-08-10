import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ready,
  generateAccountKeys,
  proveRecoveryPossession,
  rewrapMasterKey,
  rewrapRecoveryKey,
  unlockWithRecoveryKey,
  type AccountKeys,
  type KeyAttributes,
} from "@engramer/crypto";
import { buildApp } from "../src/app.js";
import { totpAt } from "../src/totp.js";

/**
 * The logged-out recovery flow end to end, with the real crypto: begin
 * hands out the recovery-wrapped material and a sealed challenge, prove
 * opens the challenge, finish installs a re-wrapped password. The server
 * must reveal nothing that distinguishes a real account from a decoy, and
 * nothing that a password cracker could grind offline.
 */

const B64URL = /^[A-Za-z0-9_-]+$/;
const b64len = (value: string) => Buffer.from(value, "base64url").length;

describe("account recovery", () => {
  let app: FastifyInstance;
  let dataDir: string;
  let account: AccountKeys;
  let registerToken: string;
  let recoveredToken = "";

  const begin = (email: string) =>
    app.inject({ method: "POST", url: "/api/auth/recovery/begin", payload: { email } });

  const proveFor = async (email: string, recoveryKeyHex: string) => {
    const opened = (await begin(email)).json() as {
      challengeId: string;
      publicKey: string;
      masterKeyEncryptedWithRecoveryKey: { ciphertext: string; nonce: string };
      encryptedPrivateKey: { ciphertext: string; nonce: string };
      sealedChallenge: string;
    };
    const attrs = {
      publicKey: opened.publicKey,
      masterKeyEncryptedWithRecoveryKey: opened.masterKeyEncryptedWithRecoveryKey,
      encryptedPrivateKey: opened.encryptedPrivateKey,
    } as KeyAttributes;
    const proof = proveRecoveryPossession(recoveryKeyHex, attrs, opened.sealedChallenge);
    const nonce = new TextDecoder().decode(proof.nonce);
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/recovery/prove",
      payload: { challengeId: opened.challengeId, nonce },
    });
    return { response, masterKey: proof.masterKey, attrs };
  };

  beforeAll(async () => {
    await ready();
    dataDir = mkdtempSync(join(tmpdir(), "engramer-recovery-test-"));
    app = await buildApp({ dataDir, webDistDir: null });
    account = generateAccountKeys("the original password");
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        email: "lost@example.com",
        loginKey: account.loginKey,
        keyAttributes: account.keyAttributes,
      },
    });
    expect(response.statusCode).toBe(201);
    registerToken = (response.json() as { token: string }).token;
  });

  afterAll(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("begins with the recovery material and no password material", async () => {
    const response = await begin("lost@example.com");
    expect(response.statusCode).toBe(200);
    const body = response.json() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      "challengeId",
      "encryptedPrivateKey",
      "masterKeyEncryptedWithRecoveryKey",
      "publicKey",
      "sealedChallenge",
    ]);
    // Nothing here may help a password guesser: no kdf, no
    // password-wrapped master key.
    expect(body.kdf).toBeUndefined();
    expect(body.encryptedMasterKey).toBeUndefined();
  });

  it("hands an unknown email a stable decoy of the same shape", async () => {
    const first = (await begin("ghost@example.com")).json() as Record<string, unknown>;
    const second = (await begin("ghost@example.com")).json() as Record<string, unknown>;
    expect(Object.keys(first).sort()).toEqual([
      "challengeId",
      "encryptedPrivateKey",
      "masterKeyEncryptedWithRecoveryKey",
      "publicKey",
      "sealedChallenge",
    ]);
    // The wrapped material is stable per email, like a real account's.
    expect(first["publicKey"]).toBe(second["publicKey"]);
    expect(first["masterKeyEncryptedWithRecoveryKey"]).toEqual(
      second["masterKeyEncryptedWithRecoveryKey"],
    );
    // Fresh challenge each call, like a real account's.
    expect(first["challengeId"]).not.toBe(second["challengeId"]);
    // The right sizes to be real ciphertext.
    const wrapped = first["masterKeyEncryptedWithRecoveryKey"] as {
      ciphertext: string;
      nonce: string;
    };
    expect(B64URL.test(wrapped.ciphertext)).toBe(true);
    expect(b64len(wrapped.ciphertext)).toBe(48);
    expect(b64len(wrapped.nonce)).toBe(24);
    expect(b64len(first["publicKey"] as string)).toBe(32);
  });

  it("rations recovery begins per address, like failed logins", async () => {
    // The throttle blocks after six failures; every begin counts as one,
    // so an attacker cannot mint challenge rows or probe timing freely.
    let lastStatus = 200;
    for (let i = 0; i < 8; i++) {
      lastStatus = (await begin("rationed@example.com")).statusCode;
    }
    expect(lastStatus).toBe(429);
  });

  it("refuses a wrong nonce", async () => {
    const opened = (await begin("lost@example.com")).json() as { challengeId: string };
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/recovery/prove",
      payload: { challengeId: opened.challengeId, nonce: "not-the-nonce" },
    });
    expect(response.statusCode).toBe(401);
  });

  it("refuses a decoy proof identically", async () => {
    const opened = (await begin("ghost@example.com")).json() as { challengeId: string };
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/recovery/prove",
      payload: { challengeId: opened.challengeId, nonce: "anything" },
    });
    expect(response.statusCode).toBe(401);
  });

  it("recovers the vault and signs old sessions out", async () => {
    const { response, masterKey } = await proveFor("lost@example.com", account.recoveryKeyHex);
    expect(response.statusCode).toBe(200);
    const proved = response.json() as { resetToken: string; twoFactorRequired: boolean };
    expect(proved.twoFactorRequired).toBe(false);
    expect(masterKey).toEqual(account.masterKey);

    const rewrapped = rewrapMasterKey("a fresh password", masterKey, account.keyAttributes);
    const finish = await app.inject({
      method: "POST",
      url: "/api/auth/recovery/finish",
      payload: {
        resetToken: proved.resetToken,
        loginKey: rewrapped.loginKey,
        kdf: rewrapped.keyAttributes.kdf,
        encryptedMasterKey: rewrapped.keyAttributes.encryptedMasterKey,
      },
    });
    expect(finish.statusCode).toBe(200);
    const session = finish.json() as { token: string; keyAttributes: KeyAttributes };
    expect(session.token).toBeTruthy();
    recoveredToken = session.token;
    // The recovery wrapping survived, so the same recovery key still works.
    expect(unlockWithRecoveryKey(account.recoveryKeyHex, session.keyAttributes)).toEqual(
      account.masterKey,
    );

    // The new password signs in; the old one is gone.
    const newLogin = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "lost@example.com", loginKey: rewrapped.loginKey },
    });
    expect(newLogin.statusCode).toBe(200);
    const oldLogin = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "lost@example.com", loginKey: account.loginKey },
    });
    expect(oldLogin.statusCode).toBe(401);

    // Sessions issued before the reset are dead.
    const stale = await app.inject({
      method: "GET",
      url: "/api/user",
      headers: { authorization: `Bearer ${registerToken}` },
    });
    expect(stale.statusCode).toBe(401);
    const fresh = await app.inject({
      method: "GET",
      url: "/api/user",
      headers: { authorization: `Bearer ${session.token}` },
    });
    expect(fresh.statusCode).toBe(200);

    // The reset token is spent.
    const replay = await app.inject({
      method: "POST",
      url: "/api/auth/recovery/finish",
      payload: {
        resetToken: proved.resetToken,
        loginKey: rewrapped.loginKey,
        kdf: rewrapped.keyAttributes.kdf,
        encryptedMasterKey: rewrapped.keyAttributes.encryptedMasterKey,
      },
    });
    expect(replay.statusCode).toBe(401);
  });

  it("rejects a finish that tries to smuggle other key fields", async () => {
    const { response } = await proveFor("lost@example.com", account.recoveryKeyHex);
    const proved = response.json() as { resetToken: string };
    const rewrapped = rewrapMasterKey("another password", account.masterKey, account.keyAttributes);
    const finish = await app.inject({
      method: "POST",
      url: "/api/auth/recovery/finish",
      payload: {
        resetToken: proved.resetToken,
        loginKey: rewrapped.loginKey,
        kdf: rewrapped.keyAttributes.kdf,
        encryptedMasterKey: rewrapped.keyAttributes.encryptedMasterKey,
        publicKey: "attacker-key",
      },
    });
    expect(finish.statusCode).toBe(400);
  });

  it("keeps a fetchable copy of the key attributes for a signed-in session", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/user/key-attributes",
      headers: { authorization: `Bearer ${recoveredToken}` },
    });
    expect(response.statusCode).toBe(200);
    const { keyAttributes } = response.json() as { keyAttributes: KeyAttributes };
    // The same object a login would hand back, recovery wrapping intact.
    expect(unlockWithRecoveryKey(account.recoveryKeyHex, keyAttributes)).toEqual(
      account.masterKey,
    );
  });
});

describe("change password while signed in", () => {
  let app: FastifyInstance;
  let dataDir: string;
  let account: AccountKeys;
  let token: string;

  const currentLoginKey = () => account.loginKey;

  beforeAll(async () => {
    await ready();
    dataDir = mkdtempSync(join(tmpdir(), "engramer-changepw-"));
    app = await buildApp({ dataDir, webDistDir: null });
    account = generateAccountKeys("first password");
    const registered = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        email: "changer@example.com",
        loginKey: account.loginKey,
        keyAttributes: account.keyAttributes,
      },
    });
    token = (registered.json() as { token: string }).token;
  });

  afterAll(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const change = (
    currentKey: string,
    next: ReturnType<typeof rewrapMasterKey>,
    bearer = token,
  ) =>
    app.inject({
      method: "POST",
      url: "/api/auth/password",
      headers: { authorization: `Bearer ${bearer}` },
      payload: {
        currentLoginKey: currentKey,
        loginKey: next.loginKey,
        kdf: next.keyAttributes.kdf,
        encryptedMasterKey: next.keyAttributes.encryptedMasterKey,
      },
    });

  it("refuses without a session", async () => {
    const next = rewrapMasterKey("second password", account.masterKey, account.keyAttributes);
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/password",
      payload: {
        currentLoginKey: currentLoginKey(),
        loginKey: next.loginKey,
        kdf: next.keyAttributes.kdf,
        encryptedMasterKey: next.keyAttributes.encryptedMasterKey,
      },
    });
    expect(response.statusCode).toBe(401);
  });

  it("refuses a wrong current password", async () => {
    const next = rewrapMasterKey("second password", account.masterKey, account.keyAttributes);
    // A well-formed login key (43 base64url chars) that is simply not theirs.
    const response = await change("A".repeat(43), next);
    expect(response.statusCode).toBe(401);
  });

  it("refuses smuggled identity-key changes", async () => {
    const next = rewrapMasterKey("second password", account.masterKey, account.keyAttributes);
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/password",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        currentLoginKey: currentLoginKey(),
        loginKey: next.loginKey,
        kdf: next.keyAttributes.kdf,
        encryptedMasterKey: next.keyAttributes.encryptedMasterKey,
        publicKey: "attacker-key",
      },
    });
    expect(response.statusCode).toBe(400);
  });

  it("changes the password, signs old tokens out, and keeps the returned one alive", async () => {
    const next = rewrapMasterKey("second password", account.masterKey, account.keyAttributes);
    const response = await change(currentLoginKey(), next);
    expect(response.statusCode).toBe(200);
    const fresh = (response.json() as { token: string }).token;

    // The new password signs in; the old one no longer does.
    const newLogin = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "changer@example.com", loginKey: next.loginKey },
    });
    expect(newLogin.statusCode).toBe(200);
    const oldLogin = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "changer@example.com", loginKey: account.loginKey },
    });
    expect(oldLogin.statusCode).toBe(401);

    // The pre-change token is dead; the returned one works.
    const stale = await app.inject({
      method: "GET",
      url: "/api/user",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(stale.statusCode).toBe(401);
    const live = await app.inject({
      method: "GET",
      url: "/api/user",
      headers: { authorization: `Bearer ${fresh}` },
    });
    expect(live.statusCode).toBe(200);
  });
});

describe("rotate the recovery key while signed in", () => {
  let app: FastifyInstance;
  let dataDir: string;
  let account: AccountKeys;
  let token: string;

  beforeAll(async () => {
    await ready();
    dataDir = mkdtempSync(join(tmpdir(), "engramer-rotatekey-"));
    app = await buildApp({ dataDir, webDistDir: null });
    account = generateAccountKeys("rotate my recovery key");
    const registered = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        email: "rotator@example.com",
        loginKey: account.loginKey,
        keyAttributes: account.keyAttributes,
      },
    });
    token = (registered.json() as { token: string }).token;
  });

  afterAll(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("refuses without a session", async () => {
    const rotated = rewrapRecoveryKey(account.masterKey, account.keyAttributes);
    const response = await app.inject({
      method: "POST",
      url: "/api/user/recovery-key",
      payload: {
        currentLoginKey: account.loginKey,
        masterKeyEncryptedWithRecoveryKey:
          rotated.keyAttributes.masterKeyEncryptedWithRecoveryKey,
        recoveryKeyEncryptedWithMasterKey:
          rotated.keyAttributes.recoveryKeyEncryptedWithMasterKey,
      },
    });
    expect(response.statusCode).toBe(401);
  });

  it("refuses a wrong current password", async () => {
    const rotated = rewrapRecoveryKey(account.masterKey, account.keyAttributes);
    const response = await app.inject({
      method: "POST",
      url: "/api/user/recovery-key",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        currentLoginKey: "A".repeat(43),
        masterKeyEncryptedWithRecoveryKey:
          rotated.keyAttributes.masterKeyEncryptedWithRecoveryKey,
        recoveryKeyEncryptedWithMasterKey:
          rotated.keyAttributes.recoveryKeyEncryptedWithMasterKey,
      },
    });
    expect(response.statusCode).toBe(401);
  });

  it("refuses to smuggle a password-wrapping change through this route", async () => {
    const rotated = rewrapRecoveryKey(account.masterKey, account.keyAttributes);
    const response = await app.inject({
      method: "POST",
      url: "/api/user/recovery-key",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        currentLoginKey: account.loginKey,
        masterKeyEncryptedWithRecoveryKey:
          rotated.keyAttributes.masterKeyEncryptedWithRecoveryKey,
        recoveryKeyEncryptedWithMasterKey:
          rotated.keyAttributes.recoveryKeyEncryptedWithMasterKey,
        encryptedMasterKey: { ciphertext: "attacker", nonce: "attacker" },
      },
    });
    // The strict schema rejects the extra field outright.
    expect(response.statusCode).toBe(400);
  });

  it("rotates the stored recovery wrapping and keeps the session and password", async () => {
    const rotated = rewrapRecoveryKey(account.masterKey, account.keyAttributes);
    const response = await app.inject({
      method: "POST",
      url: "/api/user/recovery-key",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        currentLoginKey: account.loginKey,
        masterKeyEncryptedWithRecoveryKey:
          rotated.keyAttributes.masterKeyEncryptedWithRecoveryKey,
        recoveryKeyEncryptedWithMasterKey:
          rotated.keyAttributes.recoveryKeyEncryptedWithMasterKey,
      },
    });
    expect(response.statusCode).toBe(200);

    // The new recovery key now recovers this account; the old one does not.
    const begin = (
      await app.inject({
        method: "POST",
        url: "/api/auth/recovery/begin",
        payload: { email: "rotator@example.com" },
      })
    ).json() as {
      publicKey: string;
      masterKeyEncryptedWithRecoveryKey: { ciphertext: string; nonce: string };
      encryptedPrivateKey: { ciphertext: string; nonce: string };
    };
    const attrs = {
      publicKey: begin.publicKey,
      masterKeyEncryptedWithRecoveryKey: begin.masterKeyEncryptedWithRecoveryKey,
      encryptedPrivateKey: begin.encryptedPrivateKey,
    } as KeyAttributes;
    expect(unlockWithRecoveryKey(rotated.recoveryKeyHex, attrs)).toEqual(account.masterKey);
    expect(() => unlockWithRecoveryKey(account.recoveryKeyHex, attrs)).toThrow();

    // The session token still works (rotation does not bump the epoch), and
    // the password is unchanged.
    const stillIn = await app.inject({
      method: "GET",
      url: "/api/user",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(stillIn.statusCode).toBe(200);
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "rotator@example.com", loginKey: account.loginKey },
    });
    expect(login.statusCode).toBe(200);
  });
});

describe("account recovery with two-factor", () => {
  let app: FastifyInstance;
  let dataDir: string;
  let account: AccountKeys;
  let totpSecret: string;

  beforeAll(async () => {
    await ready();
    dataDir = mkdtempSync(join(tmpdir(), "engramer-recovery-2fa-"));
    app = await buildApp({ dataDir, webDistDir: null });
    account = generateAccountKeys("guarded by a second factor");
    const registered = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        email: "guarded@example.com",
        loginKey: account.loginKey,
        keyAttributes: account.keyAttributes,
      },
    });
    const token = (registered.json() as { token: string }).token;
    const setup = await app.inject({
      method: "POST",
      url: "/api/auth/totp/setup",
      headers: { authorization: `Bearer ${token}` },
    });
    totpSecret = (setup.json() as { secret: string }).secret;
    const confirm = await app.inject({
      method: "POST",
      url: "/api/auth/totp/confirm",
      headers: { authorization: `Bearer ${token}` },
      payload: { code: totpAt(totpSecret, Date.now()) },
    });
    expect(confirm.statusCode).toBe(200);
  });

  afterAll(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("withholds the reset until the second factor passes", async () => {
    const opened = (
      await app.inject({
        method: "POST",
        url: "/api/auth/recovery/begin",
        payload: { email: "guarded@example.com" },
      })
    ).json() as {
      challengeId: string;
      publicKey: string;
      masterKeyEncryptedWithRecoveryKey: { ciphertext: string; nonce: string };
      encryptedPrivateKey: { ciphertext: string; nonce: string };
      sealedChallenge: string;
    };
    const proof = proveRecoveryPossession(
      account.recoveryKeyHex,
      {
        publicKey: opened.publicKey,
        masterKeyEncryptedWithRecoveryKey: opened.masterKeyEncryptedWithRecoveryKey,
        encryptedPrivateKey: opened.encryptedPrivateKey,
      } as KeyAttributes,
      opened.sealedChallenge,
    );
    const proved = await app.inject({
      method: "POST",
      url: "/api/auth/recovery/prove",
      payload: { challengeId: opened.challengeId, nonce: new TextDecoder().decode(proof.nonce) },
    });
    const pending = proved.json() as { resetToken: string; twoFactorRequired: boolean };
    expect(pending.twoFactorRequired).toBe(true);

    const rewrapped = rewrapMasterKey("recovered anyway", proof.masterKey, account.keyAttributes);
    // The pending token cannot finish directly.
    const early = await app.inject({
      method: "POST",
      url: "/api/auth/recovery/finish",
      payload: {
        resetToken: pending.resetToken,
        loginKey: rewrapped.loginKey,
        kdf: rewrapped.keyAttributes.kdf,
        encryptedMasterKey: rewrapped.keyAttributes.encryptedMasterKey,
      },
    });
    expect(early.statusCode).toBe(401);

    // A wrong code does not burn the pending step.
    const wrong = await app.inject({
      method: "POST",
      url: "/api/auth/recovery/2fa",
      payload: { resetToken: pending.resetToken, code: "000000" },
    });
    expect(wrong.statusCode).toBe(401);

    const right = await app.inject({
      method: "POST",
      url: "/api/auth/recovery/2fa",
      payload: { resetToken: pending.resetToken, code: totpAt(totpSecret, Date.now() + 30_000) },
    });
    expect(right.statusCode).toBe(200);
    const upgraded = right.json() as { resetToken: string };

    const finish = await app.inject({
      method: "POST",
      url: "/api/auth/recovery/finish",
      payload: {
        resetToken: upgraded.resetToken,
        loginKey: rewrapped.loginKey,
        kdf: rewrapped.keyAttributes.kdf,
        encryptedMasterKey: rewrapped.keyAttributes.encryptedMasterKey,
      },
    });
    expect(finish.statusCode).toBe(200);
  });
});
