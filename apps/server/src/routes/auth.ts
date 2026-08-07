import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { loginKeyDigest } from "@engramer/crypto";
import { storageUsed, userQuota, type UserRow } from "../db.js";
import { AuthThrottle } from "../ratelimit.js";
import { generateTotpSecret, otpauthUri, verifyTotp } from "../totp.js";

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
    token: app.jwt.sign({ uid: user.id }),
    keyAttributes: JSON.parse(user.key_attributes) as unknown,
  });

  /** Lets the client adapt its sign-up form to this server's policy. */
  app.get("/api/auth/registration", async () => ({ mode: app.config.registration }));

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
      const token = app.jwt.sign({ uid: created.id });
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

    const totp = verifyTotp(user.totp_secret, body.code, Date.now());
    if (totp.valid && totp.step > user.totp_last_step) {
      await app.db.run("UPDATE users SET totp_last_step = ? WHERE id = ?", totp.step, user.id);
      await throttle.succeed(throttleKey(request, user.email));
      return sessionResponse(user);
    }

    // Recovery codes are one-time: a match consumes the digest.
    const digests = JSON.parse(user.recovery_code_digests ?? "[]") as string[];
    const presented = hashRecoveryCode(body.code);
    const index = digests.findIndex((d) => digestsMatch(d, presented));
    if (index >= 0) {
      digests.splice(index, 1);
      await app.db.run(
        "UPDATE users SET recovery_code_digests = ? WHERE id = ?",
        JSON.stringify(digests),
        user.id,
      );
      await throttle.succeed(throttleKey(request, user.email));
      return { ...sessionResponse(user), recoveryCodesLeft: digests.length };
    }

    await throttle.fail(throttleKey(request, user.email));
    return reply.code(401).send({ error: "that code is not valid" });
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
