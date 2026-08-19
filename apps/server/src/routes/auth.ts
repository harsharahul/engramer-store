import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { loginKeyDigest, sealToPublicKey, type KeyAttributes } from "@engramer/crypto";
import { storageUsed, userQuota, type UserRow } from "../db.js";
import { AuthThrottle } from "../ratelimit.js";
import { generateTotpSecret, otpauthUri, verifyTotp } from "../totp.js";
import { consumeChallenge, issueChallenge, peekChallenge } from "../challenges.js";
import { ForbiddenKeyChange, mergeKeyAttributes } from "../keyattrs.js";

const secretBoxSchema = z.object({ ciphertext: z.string(), nonce: z.string() });

/** Base64url, so a malformed value fails validation instead of throwing
 * inside the digest helper and surfacing as a server error. */
const base64Key = z.string().min(1).max(512).regex(/^[A-Za-z0-9_-]+={0,2}$/);


// Mirrors the client-side floor: an account must never be created with
// password-hashing parameters weaker than the OWASP minimum, whatever the
// client claims.
const kdfSchema = z.object({
  salt: z.string().min(16),
  opsLimit: z.number().int().min(2),
  memLimit: z.number().int().min(19 * 1024 * 1024),
});

const keyAttributesSchema = z.object({
  kdf: kdfSchema,
  encryptedMasterKey: secretBoxSchema,
  masterKeyEncryptedWithRecoveryKey: secretBoxSchema,
  recoveryKeyEncryptedWithMasterKey: secretBoxSchema,
  publicKey: z.string(),
  encryptedPrivateKey: secretBoxSchema,
});

const registerSchema = z.object({
  email: z.string().email().toLowerCase(),
  loginKey: base64Key,
  keyAttributes: keyAttributesSchema,
  inviteToken: z.string().min(1).optional(),
});

const loginSchema = z.object({
  email: z.string().email().toLowerCase(),
  loginKey: base64Key,
});

const twoFactorSchema = z.object({
  pendingToken: z.string().min(1),
  code: z.string().min(1).max(64),
});

const codeSchema = z.object({ code: z.string().min(1).max(64) });

const RECOVERY_CODE_COUNT = 10;

/** The presented invite was missing, used, expired, or revoked. */
class InviteInvalidError extends Error {}

/** Argon2id parameters for an email with no account: indistinguishable
 * from a real one, stable across calls, and derived so no state is kept. */
function decoyKdf(email: string, serverSecret: string): {
  salt: string;
  opsLimit: number;
  memLimit: number;
} {
  const salt = createHash("sha256")
    .update(`engram-decoy-kdf|${serverSecret}|${email}`)
    .digest()
    .subarray(0, 16)
    .toString("base64");
  // The MODERATE profile every account is created with.
  return { salt, opsLimit: 3, memLimit: 268435456 };
}

function digestsMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

function hashRecoveryCode(code: string): string {
  return createHash("sha256").update(code.trim().toLowerCase()).digest("hex");
}

function generateRecoveryCodes(): { codes: string[]; digests: string[] } {
  const codes: string[] = [];
  for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
    // 128 bits: a stolen digest list must not be searchable offline.
    const raw = randomBytes(16).toString("hex");
    codes.push(`${raw.slice(0, 8)}-${raw.slice(8, 16)}-${raw.slice(16, 24)}-${raw.slice(24)}`);
  }
  return { codes, digests: codes.map(hashRecoveryCode) };
}

export function registerAuthRoutes(app: FastifyInstance): void {
  const auth = { preHandler: [app.authenticate] };
  const throttle = new AuthThrottle(app.db);

  const throttleKey = (request: FastifyRequest, identity: string) =>
    `${request.ip}|${identity.toLowerCase()}`;

  /** 429 with Retry-After when the caller has been failing too often. */
  const gate = async (request: FastifyRequest, identity: string) => {
    const { allowed, retryAfterMs } = await throttle.check(throttleKey(request, identity));
    return allowed ? null : Math.ceil(retryAfterMs / 1000);
  };

  const getUser = async (id: number): Promise<UserRow> =>
    (await app.db.get<UserRow>("SELECT * FROM users WHERE id = ?", id))!;

  /** The full session response; only ever issued after every factor passed. */
  const sessionResponse = (user: UserRow) => ({
    token: app.jwt.sign({ uid: user.id, ep: user.token_epoch ?? 0 }),
    keyAttributes: JSON.parse(user.key_attributes) as unknown,
  });

  /** A valid TOTP code or an unused one-time recovery code; used by both
   * the login second step and the recovery flow, so the logic exists once. */
  const verifySecondFactor = async (
    user: UserRow,
    code: string,
  ): Promise<{ ok: boolean; recoveryCodesLeft?: number }> => {
    if (user.totp_enabled !== 1 || !user.totp_secret) {
      return { ok: false };
    }
    const totp = verifyTotp(user.totp_secret, code, Date.now());
    if (totp.valid && totp.step > user.totp_last_step) {
      await app.db.run("UPDATE users SET totp_last_step = ? WHERE id = ?", totp.step, user.id);
      return { ok: true };
    }
    // Recovery codes are one-time: a match consumes the digest.
    const digests = JSON.parse(user.recovery_code_digests ?? "[]") as string[];
    const presented = hashRecoveryCode(code);
    const index = digests.findIndex((d) => digestsMatch(d, presented));
    if (index >= 0) {
      digests.splice(index, 1);
      await app.db.run(
        "UPDATE users SET recovery_code_digests = ? WHERE id = ?",
        JSON.stringify(digests),
        user.id,
      );
      return { ok: true, recoveryCodesLeft: digests.length };
    }
    return { ok: false };
  };

  /**
   * Pseudo-ciphertext for an email with no account, stable per email like
   * a real account's wrapped keys would be. Under a key nobody holds, real
   * ciphertext and expanded hashes are indistinguishable; a client fails
   * at the same step, with the same error, either way.
   */
  const decoyBytes = (email: string, field: string, length: number): string => {
    const out = Buffer.alloc(length);
    let offset = 0;
    let counter = 0;
    while (offset < length) {
      const block = createHash("sha256")
        .update(`engram-decoy-attrs|${app.config.jwtSecret}|${email}|${field}|${counter}`)
        .digest();
      counter += 1;
      block.copy(out, offset);
      offset += block.length;
    }
    return out.toString("base64url");
  };

  /** Reset tokens travel as "id.secret"; only the digest of the secret is stored. */
  const parseResetToken = (token: string): { id: string; secret: string } | null => {
    const dot = token.indexOf(".");
    if (dot <= 0 || dot === token.length - 1) {
      return null;
    }
    return { id: token.slice(0, dot), secret: token.slice(dot + 1) };
  };

  /** Lets the client adapt its sign-up form to this server's policy. */
  app.get("/api/auth/registration", async () => ({
    mode: app.config.registration,
    // Where this deployment hosts its Mac app, or null when it offers
    // none. Deployment configuration, not product code: the web app
    // links wherever the operator says and hides the row otherwise.
    macAppUrl: app.config.macAppDmgUrl,
  }));

  app.post("/api/auth/register", async (request, reply) => {
    const body = registerSchema.parse(request.body);
    const retryAfter = await gate(request, body.email);
    if (retryAfter !== null) {
      return reply.code(429).header("retry-after", retryAfter).send({ error: "too many attempts" });
    }
    // Operator-declared administrators may always register; everyone else is
    // subject to the server's registration policy.
    const isAdminEmail = app.config.adminEmails.includes(body.email);
    if (!isAdminEmail && app.config.registration === "closed") {
      return reply.code(403).send({ error: "registration is disabled on this server" });
    }
    if (!isAdminEmail && app.config.registration === "invite" && !body.inviteToken) {
      return reply.code(403).send({ error: "registration requires an invite" });
    }
    const existing = await app.db.get("SELECT id FROM users WHERE email = ?", body.email);
    if (existing) {
      await throttle.fail(throttleKey(request, body.email));
      return reply.code(409).send({ error: "an account with this email already exists" });
    }
    try {
      const created = await app.db.tx(async (t) => {
        const user = await t.get<{ id: number }>(
          "INSERT INTO users (email, login_key_digest, key_attributes, created_at) VALUES (?, ?, ?, ?) RETURNING id",
          body.email,
          loginKeyDigest(body.loginKey),
          JSON.stringify(body.keyAttributes),
          Date.now(),
        );
        if (!isAdminEmail && app.config.registration === "invite") {
          // One invite, one account: the conditional update wins exactly once.
          const consumed = await t.run(
            `UPDATE invites SET used_by = ?, used_at = ?
             WHERE token = ? AND used_by IS NULL AND (expires_at IS NULL OR expires_at > ?)`,
            user!.id,
            Date.now(),
            body.inviteToken,
            Date.now(),
          );
          if (consumed.changes === 0) {
            throw new InviteInvalidError();
          }
        }
        return user!;
      });
      const token = app.jwt.sign({ uid: created.id, ep: 0 });
      return reply.code(201).send({ token });
    } catch (err) {
      if (err instanceof InviteInvalidError) {
        await throttle.fail(throttleKey(request, body.email));
        return reply.code(403).send({ error: "that invite is not valid" });
      }
      throw err;
    }
  });

  /**
   * Pre-login: the client needs the KDF salt and parameters to derive its
   * keys. An unknown email gets a stable decoy instead of an error, so this
   * endpoint cannot be used to discover who has an account on a public
   * server. The decoy salt is derived from the email under the server's
   * secret, so it is deterministic per email (a real account's salt is
   * stable too) and reveals nothing. The login attempt that follows fails
   * on the digest either way, at the same cost.
   */
  app.get("/api/auth/attributes", async (request, reply) => {
    const parsed = z
      .string()
      .email()
      .toLowerCase()
      .safeParse((request.query as { email?: string }).email);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid request" });
    }
    const email = parsed.data;
    const retryAfter = await gate(request, email);
    if (retryAfter !== null) {
      return reply.code(429).header("retry-after", retryAfter).send({ error: "too many attempts" });
    }
    const user = await app.db.get<Pick<UserRow, "key_attributes">>(
      "SELECT key_attributes FROM users WHERE email = ?",
      email,
    );
    if (!user) {
      return { kdf: decoyKdf(email, app.config.jwtSecret) };
    }
    const attributes = JSON.parse(user.key_attributes) as { kdf: unknown };
    return { kdf: attributes.kdf };
  });

  app.post("/api/auth/login", async (request, reply) => {
    const body = loginSchema.parse(request.body);
    const retryAfter = await gate(request, body.email);
    if (retryAfter !== null) {
      return reply.code(429).header("retry-after", retryAfter).send({ error: "too many attempts" });
    }
    const user = await app.db.get<UserRow>("SELECT * FROM users WHERE email = ?", body.email);
    if (!user || !digestsMatch(loginKeyDigest(body.loginKey), user.login_key_digest)) {
      await throttle.fail(throttleKey(request, body.email));
      return reply.code(401).send({ error: "invalid email or password" });
    }
    if (user.disabled === 1) {
      return reply.code(403).send({ error: "this account is disabled" });
    }
    await throttle.succeed(throttleKey(request, body.email));
    if (user.totp_enabled === 1) {
      // The password checked out, but key material stays withheld until the
      // second factor passes; the pending token can only be used for that.
      return {
        twoFactorRequired: true,
        pendingToken: app.jwt.sign({ uid: user.id, pending: true }, { expiresIn: "5m" }),
      };
    }
    return sessionResponse(user);
  });

  /** Second step: a valid TOTP code or an unused recovery code. */
  app.post("/api/auth/2fa", async (request, reply) => {
    const body = twoFactorSchema.parse(request.body);
    let payload: { uid: number; pending?: boolean };
    try {
      payload = app.jwt.verify(body.pendingToken);
    } catch {
      return reply.code(401).send({ error: "sign in again" });
    }
    if (!payload.pending) {
      return reply.code(401).send({ error: "sign in again" });
    }
    const user = await getUser(payload.uid);
    const retryAfter = await gate(request, user.email);
    if (retryAfter !== null) {
      return reply.code(429).header("retry-after", retryAfter).send({ error: "too many attempts" });
    }
    if (user.totp_enabled !== 1 || !user.totp_secret) {
      return reply.code(401).send({ error: "sign in again" });
    }

    const second = await verifySecondFactor(user, body.code);
    if (second.ok) {
      await throttle.succeed(throttleKey(request, user.email));
      return second.recoveryCodesLeft === undefined
        ? sessionResponse(user)
        : { ...sessionResponse(user), recoveryCodesLeft: second.recoveryCodesLeft };
    }

    await throttle.fail(throttleKey(request, user.email));
    return reply.code(401).send({ error: "that code is not valid" });
  });

  // ----- recovery (a lost password, redeemed with the recovery key) -----

  /**
   * Hands out what a recovery attempt needs: the recovery-wrapped master
   * key, the sealed private key, and a challenge sealed to the account's
   * public key. Deliberately absent: the kdf and the password-wrapped
   * master key, which would hand any caller an offline password-cracking
   * target. The recovery wrapping is sealed under a 256-bit random key,
   * so disclosing it is safe; an unknown email gets a stable decoy of the
   * same shape, so this is not an enumeration oracle either.
   */
  app.post("/api/auth/recovery/begin", async (request, reply) => {
    const body = z.object({ email: z.string().email().toLowerCase() }).parse(request.body);
    const retryAfter = await gate(request, body.email);
    if (retryAfter !== null) {
      return reply.code(429).header("retry-after", retryAfter).send({ error: "too many attempts" });
    }
    // Every begin spends throttle budget: an attacker must not mint
    // challenge rows or probe response timing at leisure. A successful
    // prove clears it, so a real recovery never feels this.
    await throttle.fail(throttleKey(request, body.email));
    const user = await app.db.get<UserRow>("SELECT * FROM users WHERE email = ?", body.email);
    if (!user) {
      return {
        challengeId: randomUUID(),
        publicKey: decoyBytes(body.email, "pub", 32),
        masterKeyEncryptedWithRecoveryKey: {
          ciphertext: decoyBytes(body.email, "mkr", 48),
          nonce: decoyBytes(body.email, "mkr-nonce", 24),
        },
        encryptedPrivateKey: {
          ciphertext: decoyBytes(body.email, "epk", 48),
          nonce: decoyBytes(body.email, "epk-nonce", 24),
        },
        // Fresh per call, like a real challenge; 91 bytes is the sealed
        // size of a real challenge secret.
        sealedChallenge: randomBytes(91).toString("base64url"),
      };
    }
    const attrs = JSON.parse(user.key_attributes) as KeyAttributes;
    const challenge = await issueChallenge(app.db, user.id, "recovery-proof", 10 * 60_000);
    return {
      challengeId: challenge.id,
      publicKey: attrs.publicKey,
      masterKeyEncryptedWithRecoveryKey: attrs.masterKeyEncryptedWithRecoveryKey,
      encryptedPrivateKey: attrs.encryptedPrivateKey,
      sealedChallenge: sealToPublicKey(new TextEncoder().encode(challenge.secret), attrs.publicKey),
    };
  });

  /** Returning the opened nonce proves the caller holds the private key. */
  app.post("/api/auth/recovery/prove", async (request, reply) => {
    const body = z
      .object({ challengeId: z.string().min(1).max(128), nonce: z.string().min(1).max(128) })
      .parse(request.body);
    const retryAfter = await gate(request, "recovery-prove");
    if (retryAfter !== null) {
      return reply.code(429).header("retry-after", retryAfter).send({ error: "too many attempts" });
    }
    const uid = await consumeChallenge(app.db, body.challengeId, body.nonce, "recovery-proof");
    if (uid === null) {
      await throttle.fail(throttleKey(request, "recovery-prove"));
      return reply.code(401).send({ error: "that recovery attempt is not valid" });
    }
    await throttle.succeed(throttleKey(request, "recovery-prove"));
    const user = await getUser(uid);
    // The proof also clears the begin budget for this address.
    await throttle.succeed(throttleKey(request, user.email));
    if (user.disabled === 1) {
      return reply.code(403).send({ error: "this account is disabled" });
    }
    // Only after possession is proven does the response say whether a
    // second factor stands in the way; before that it would be a probe.
    if (user.totp_enabled === 1) {
      const pending = await issueChallenge(app.db, uid, "reset-pending-2fa", 15 * 60_000);
      return { resetToken: `${pending.id}.${pending.secret}`, twoFactorRequired: true };
    }
    const reset = await issueChallenge(app.db, uid, "reset", 15 * 60_000);
    return { resetToken: `${reset.id}.${reset.secret}`, twoFactorRequired: false };
  });

  /** The second factor still guards a recovery, exactly as it guards a login. */
  app.post("/api/auth/recovery/2fa", async (request, reply) => {
    const body = z
      .object({ resetToken: z.string().min(3).max(256), code: z.string().min(1).max(64) })
      .parse(request.body);
    const parsed = parseResetToken(body.resetToken);
    if (!parsed) {
      return reply.code(401).send({ error: "sign in again" });
    }
    // Peeked, not spent: a mistyped code must not burn the proven step.
    const uid = await peekChallenge(app.db, parsed.id, parsed.secret, "reset-pending-2fa");
    if (uid === null) {
      return reply.code(401).send({ error: "sign in again" });
    }
    const user = await getUser(uid);
    const retryAfter = await gate(request, user.email);
    if (retryAfter !== null) {
      return reply.code(429).header("retry-after", retryAfter).send({ error: "too many attempts" });
    }
    const second = await verifySecondFactor(user, body.code);
    if (!second.ok) {
      await throttle.fail(throttleKey(request, user.email));
      return reply.code(401).send({ error: "that code is not valid" });
    }
    await throttle.succeed(throttleKey(request, user.email));
    // The pending step is spent exactly once; a parallel attempt that
    // lost this race gets nothing, not a second reset token.
    const spent = await consumeChallenge(app.db, parsed.id, parsed.secret, "reset-pending-2fa");
    if (spent === null) {
      return reply.code(401).send({ error: "sign in again" });
    }
    const reset = await issueChallenge(app.db, uid, "reset", 15 * 60_000);
    return { resetToken: `${reset.id}.${reset.secret}` };
  });

  /**
   * Installs the re-wrapped password. Only the kdf and the password
   * wrapping may change; the identity keys and the recovery wrapping are
   * merged from what is stored, never from the request. The token epoch
   * advances, so every session issued before the reset is signed out.
   */
  app.post("/api/auth/recovery/finish", async (request, reply) => {
    const body = z
      .object({
        resetToken: z.string().min(3).max(256),
        loginKey: base64Key,
        kdf: kdfSchema,
        encryptedMasterKey: secretBoxSchema,
      })
      .strict()
      .parse(request.body);
    const parsed = parseResetToken(body.resetToken);
    if (!parsed) {
      return reply.code(401).send({ error: "sign in again" });
    }
    const uid = await consumeChallenge(app.db, parsed.id, parsed.secret, "reset");
    if (uid === null) {
      return reply.code(401).send({ error: "that reset is no longer valid" });
    }
    const user = await getUser(uid);
    const stored = JSON.parse(user.key_attributes) as KeyAttributes;
    let merged: KeyAttributes;
    try {
      merged = mergeKeyAttributes(
        stored,
        { ...stored, kdf: body.kdf, encryptedMasterKey: body.encryptedMasterKey },
        ["kdf", "encryptedMasterKey"],
      );
    } catch (err) {
      if (err instanceof ForbiddenKeyChange) {
        return reply.code(400).send({ error: err.message });
      }
      throw err;
    }
    await app.db.run(
      "UPDATE users SET login_key_digest = ?, key_attributes = ?, token_epoch = token_epoch + 1 WHERE id = ?",
      loginKeyDigest(body.loginKey),
      JSON.stringify(merged),
      uid,
    );
    return sessionResponse(await getUser(uid));
  });

  /** The stored attributes, for flows that re-wrap them while signed in. */
  app.get("/api/user/key-attributes", auth, async (request) => {
    const user = await getUser(request.user.uid);
    return { keyAttributes: JSON.parse(user.key_attributes) as unknown };
  });

  /**
   * Changes the vault password from a signed-in session. The current
   * password is proven by its login-key digest before anything changes;
   * only the kdf and the password wrapping may move, and the token epoch
   * advances so other devices are signed out. The client keeps the
   * returned token so the calling tab survives its own epoch bump.
   */
  app.post("/api/auth/password", auth, async (request, reply) => {
    const body = z
      .object({
        currentLoginKey: base64Key,
        loginKey: base64Key,
        kdf: kdfSchema,
        encryptedMasterKey: secretBoxSchema,
      })
      .strict()
      .parse(request.body);
    const user = await getUser(request.user.uid);
    const retryAfter = await gate(request, user.email);
    if (retryAfter !== null) {
      return reply.code(429).header("retry-after", retryAfter).send({ error: "too many attempts" });
    }
    if (!digestsMatch(loginKeyDigest(body.currentLoginKey), user.login_key_digest)) {
      await throttle.fail(throttleKey(request, user.email));
      return reply.code(401).send({ error: "that password is not correct" });
    }
    await throttle.succeed(throttleKey(request, user.email));
    const stored = JSON.parse(user.key_attributes) as KeyAttributes;
    let merged: KeyAttributes;
    try {
      merged = mergeKeyAttributes(
        stored,
        { ...stored, kdf: body.kdf, encryptedMasterKey: body.encryptedMasterKey },
        ["kdf", "encryptedMasterKey"],
      );
    } catch (err) {
      if (err instanceof ForbiddenKeyChange) {
        return reply.code(400).send({ error: err.message });
      }
      throw err;
    }
    await app.db.run(
      "UPDATE users SET login_key_digest = ?, key_attributes = ?, token_epoch = token_epoch + 1 WHERE id = ?",
      loginKeyDigest(body.loginKey),
      JSON.stringify(merged),
      user.id,
    );
    return sessionResponse(await getUser(user.id));
  });

  /**
   * Rotates the recovery key from a signed-in session. The current
   * password is proven, then only the two recovery wraps are re-sealed;
   * the password wrapping and the keypair are untouched, so the session
   * and password both survive and the token epoch does not move. The old
   * recovery key stops working the moment this returns.
   */
  app.post("/api/user/recovery-key", auth, async (request, reply) => {
    const body = z
      .object({
        currentLoginKey: base64Key,
        masterKeyEncryptedWithRecoveryKey: secretBoxSchema,
        recoveryKeyEncryptedWithMasterKey: secretBoxSchema,
      })
      .strict()
      .parse(request.body);
    const user = await getUser(request.user.uid);
    const retryAfter = await gate(request, user.email);
    if (retryAfter !== null) {
      return reply.code(429).header("retry-after", retryAfter).send({ error: "too many attempts" });
    }
    if (!digestsMatch(loginKeyDigest(body.currentLoginKey), user.login_key_digest)) {
      await throttle.fail(throttleKey(request, user.email));
      return reply.code(401).send({ error: "that password is not correct" });
    }
    await throttle.succeed(throttleKey(request, user.email));
    const stored = JSON.parse(user.key_attributes) as KeyAttributes;
    const merged = mergeKeyAttributes(
      stored,
      {
        ...stored,
        masterKeyEncryptedWithRecoveryKey: body.masterKeyEncryptedWithRecoveryKey,
        recoveryKeyEncryptedWithMasterKey: body.recoveryKeyEncryptedWithMasterKey,
      },
      ["masterKeyEncryptedWithRecoveryKey", "recoveryKeyEncryptedWithMasterKey"],
    );
    await app.db.run(
      "UPDATE users SET key_attributes = ? WHERE id = ?",
      JSON.stringify(merged),
      user.id,
    );
    return reply.code(200).send({ ok: true });
  });

  // ----- enrollment (an authenticated session manages its own 2FA) -----

  app.post("/api/auth/totp/setup", auth, async (request, reply) => {
    const user = await getUser(request.user.uid);
    // Enrolment must never be a way to turn two-factor OFF: a session token
    // alone would otherwise strip it silently. Disabling has its own route
    // and demands a current code.
    if (user.totp_enabled === 1) {
      return reply
        .code(409)
        .send({ error: "two-factor is already enabled; disable it first" });
    }
    const secret = generateTotpSecret();
    // Stored but not enabled until a code proves the authenticator has it.
    await app.db.run(
      "UPDATE users SET totp_secret = ?, totp_enabled = 0, totp_last_step = 0 WHERE id = ?",
      secret,
      user.id,
    );
    return { secret, otpauthUri: otpauthUri(secret, user.email) };
  });

  app.post("/api/auth/totp/confirm", auth, async (request, reply) => {
    const body = codeSchema.parse(request.body);
    const user = await getUser(request.user.uid);
    if (!user.totp_secret || user.totp_enabled === 1) {
      return reply.code(400).send({ error: "two-factor setup is not in progress" });
    }
    const totp = verifyTotp(user.totp_secret, body.code, Date.now());
    if (!totp.valid) {
      return reply.code(401).send({ error: "that code is not valid" });
    }
    const { codes, digests } = generateRecoveryCodes();
    await app.db.run(
      "UPDATE users SET totp_enabled = 1, totp_last_step = ?, recovery_code_digests = ? WHERE id = ?",
      totp.step,
      JSON.stringify(digests),
      user.id,
    );
    // The only time recovery codes ever exist in plaintext on the wire.
    return { recoveryCodes: codes };
  });

  app.post("/api/auth/totp/disable", auth, async (request, reply) => {
    const body = codeSchema.parse(request.body);
    const user = await getUser(request.user.uid);
    if (user.totp_enabled !== 1 || !user.totp_secret) {
      return reply.code(400).send({ error: "two-factor is not enabled" });
    }
    const totp = verifyTotp(user.totp_secret, body.code, Date.now());
    const digests = JSON.parse(user.recovery_code_digests ?? "[]") as string[];
    const presented = hashRecoveryCode(body.code);
    const recoveryMatch = digests.some((d) => digestsMatch(d, presented));
    if (!(totp.valid && totp.step > user.totp_last_step) && !recoveryMatch) {
      return reply.code(401).send({ error: "that code is not valid" });
    }
    await app.db.run(
      "UPDATE users SET totp_secret = NULL, totp_enabled = 0, totp_last_step = 0, recovery_code_digests = NULL WHERE id = ?",
      user.id,
    );
    return { disabled: true };
  });

  app.patch("/api/user", auth, async (request, reply) => {
    const body = z
      .object({ displayName: z.string().trim().max(64).nullable() })
      .parse(request.body);
    // Empty means "no name": fall back to the address rather than storing
    // a blank that would show as nothing at all beside someone's cursor.
    const name = body.displayName && body.displayName.length > 0 ? body.displayName : null;
    await app.db.run("UPDATE users SET display_name = ? WHERE id = ?", name, request.user.uid);
    return reply.code(200).send({ displayName: name });
  });

  // Account settings: one client-sealed blob, so preferences follow the
  // account instead of living and dying with one device's local storage.
  // The server stores and stamps it; the content is ciphertext to it.
  app.get("/api/settings", auth, async (request) => {
    const row = await app.db.get<{ settings_blob: string | null; settings_updated_ms: number }>(
      "SELECT settings_blob, settings_updated_ms FROM users WHERE id = ?",
      request.user.uid,
    );
    return {
      blob: row?.settings_blob ?? null,
      updatedAt: Number(row?.settings_updated_ms ?? 0),
    };
  });

  app.put("/api/settings", auth, async (request) => {
    const body = z.object({ blob: z.string().max(16_384) }).parse(request.body);
    const updatedAt = Date.now();
    await app.db.run(
      "UPDATE users SET settings_blob = ?, settings_updated_ms = ? WHERE id = ?",
      body.blob,
      updatedAt,
      request.user.uid,
    );
    return { updatedAt };
  });

  app.get("/api/user", auth, async (request) => {
    const user = await getUser(request.user.uid);
    const digests = JSON.parse(user.recovery_code_digests ?? "[]") as string[];
    return {
      email: user.email,
      createdAt: user.created_at,
      usedBytes: await storageUsed(app.db, request.user.uid),
      quotaBytes: await userQuota(app.db, request.user.uid, app.config.quotaBytes),
      isAdmin: app.config.adminEmails.includes(user.email),
      displayName: user.display_name,
      totpEnabled: user.totp_enabled === 1,
      recoveryCodesLeft: user.totp_enabled === 1 ? digests.length : 0,
      // Clients read this before ever dialing the relay, so a deployment
      // with the relay off degrades cleanly to turn-based editing.
      collab: { relay: app.config.collabRelay },
    };
  });
}
