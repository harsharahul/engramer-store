import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { loginKeyDigest } from "@engramer/crypto";
import type { UserRow } from "../db.js";

const secretBoxSchema = z.object({ ciphertext: z.string(), nonce: z.string() });

const keyAttributesSchema = z.object({
  kdf: z.object({
    salt: z.string(),
    opsLimit: z.number().int().positive(),
    memLimit: z.number().int().positive(),
  }),
  encryptedMasterKey: secretBoxSchema,
  masterKeyEncryptedWithRecoveryKey: secretBoxSchema,
  recoveryKeyEncryptedWithMasterKey: secretBoxSchema,
  publicKey: z.string(),
  encryptedPrivateKey: secretBoxSchema,
});

const registerSchema = z.object({
  email: z.string().email().toLowerCase(),
  loginKey: z.string().min(1),
  keyAttributes: keyAttributesSchema,
});

const loginSchema = z.object({
  email: z.string().email().toLowerCase(),
  loginKey: z.string().min(1),
});

function digestsMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

export function registerAuthRoutes(app: FastifyInstance): void {
  app.post("/api/auth/register", async (request, reply) => {
    const body = registerSchema.parse(request.body);
    const existing = app.db
      .prepare("SELECT id FROM users WHERE email = ?")
      .get(body.email);
    if (existing) {
      return reply.code(409).send({ error: "an account with this email already exists" });
    }
    const result = app.db
      .prepare(
        "INSERT INTO users (email, login_key_digest, key_attributes, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(body.email, loginKeyDigest(body.loginKey), JSON.stringify(body.keyAttributes), Date.now());
    const token = app.jwt.sign({ uid: Number(result.lastInsertRowid) });
    return reply.code(201).send({ token });
  });

  // Pre-login: the client needs the KDF salt and parameters to derive its keys.
  app.get("/api/auth/attributes", async (request, reply) => {
    const email = z.string().email().toLowerCase().parse((request.query as { email?: string }).email);
    const user = app.db
      .prepare("SELECT key_attributes FROM users WHERE email = ?")
      .get(email) as Pick<UserRow, "key_attributes"> | undefined;
    if (!user) {
      return reply.code(404).send({ error: "no account with this email" });
    }
    const attributes = JSON.parse(user.key_attributes) as { kdf: unknown };
    return { kdf: attributes.kdf };
  });

  app.post("/api/auth/login", async (request, reply) => {
    const body = loginSchema.parse(request.body);
    const user = app.db
      .prepare("SELECT id, login_key_digest, key_attributes FROM users WHERE email = ?")
      .get(body.email) as Pick<UserRow, "id" | "login_key_digest" | "key_attributes"> | undefined;
    if (!user || !digestsMatch(loginKeyDigest(body.loginKey), user.login_key_digest)) {
      return reply.code(401).send({ error: "invalid email or password" });
    }
    return {
      token: app.jwt.sign({ uid: user.id }),
      keyAttributes: JSON.parse(user.key_attributes) as unknown,
    };
  });

  app.get("/api/user", { preHandler: [app.authenticate] }, async (request) => {
    const user = app.db
      .prepare("SELECT email, created_at FROM users WHERE id = ?")
      .get(request.user.uid) as Pick<UserRow, "email" | "created_at">;
    return {
      email: user.email,
      createdAt: user.created_at,
      usedBytes: app.storageUsed(request.user.uid),
      quotaBytes: app.config.quotaBytes,
    };
  });
}
