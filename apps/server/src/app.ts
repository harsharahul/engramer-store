import { existsSync } from "node:fs";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import fastifyStatic from "@fastify/static";
import type Database from "better-sqlite3";
import { ZodError } from "zod";
import { ready } from "@engramer/crypto";
import { loadConfig, type ConfigOverrides, type ServerConfig } from "./config.js";
import { FsBlobStore, type BlobStore } from "./blobs.js";
import { DiskCachedBlobStore } from "./blobcache.js";
import { S3BlobStore } from "./s3.js";
import { nextSeq, openDatabase, storageUsed } from "./db.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerStorageRoutes } from "./routes/storage.js";
import { registerShareRoutes } from "./routes/shares.js";
import { registerRequestRoutes } from "./routes/requests.js";

declare module "fastify" {
  interface FastifyInstance {
    config: ServerConfig;
    db: Database.Database;
    blobs: BlobStore;
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    nextSeq: (userId: number) => number;
    storageUsed: (userId: number) => number;
  }
}

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: { uid: number; pending?: boolean };
    user: { uid: number; pending?: boolean };
  }
}

export async function buildApp(overrides: ConfigOverrides = {}): Promise<FastifyInstance> {
  await ready();
  const config = loadConfig(overrides);
  const db = openDatabase(config.dbPath);

  const app = Fastify({ bodyLimit: 16 * 1024 * 1024 });

  let blobs: BlobStore;
  if (config.s3) {
    const s3 = new S3BlobStore(config.s3);
    await s3.init();
    // Opt-in hot tier: derived blobs (thumbnails, search indexes) served
    // from local disk instead of a round trip per request. Pointless over
    // the local filesystem store, so it only ever wraps S3.
    blobs =
      config.blobCacheBytes > 0
        ? new DiskCachedBlobStore(s3, config.blobCacheDir, config.blobCacheBytes)
        : s3;
  } else {
    blobs = new FsBlobStore(config.blobDir);
  }

  app.decorate("config", config);
  app.decorate("blobs", blobs);
  app.decorate("db", db);
  app.decorate("nextSeq", (userId: number) => nextSeq(db, userId));
  app.decorate("storageUsed", (userId: number) => storageUsed(db, userId));
  app.decorate("authenticate", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      await request.jwtVerify();
    } catch {
      await reply.code(401).send({ error: "authentication required" });
      return;
    }
    // A pending token only proves the password step of a two-factor login;
    // it must never act as a session.
    if (request.user.pending) {
      await reply.code(401).send({ error: "authentication required" });
    }
  });

  // Ciphertext blobs arrive as raw octet streams and are piped straight to disk.
  app.addContentTypeParser("application/octet-stream", (_request, payload, done) => {
    done(null, payload);
  });

  app.setErrorHandler((error: unknown, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({ error: "invalid request", details: error.issues });
    }
    app.log.error(error);
    const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
    return reply.code(statusCode).send({ error: "internal server error" });
  });

  await app.register(cors, { origin: true });
  await app.register(jwt, { secret: config.jwtSecret, sign: { expiresIn: "30d" } });

  registerAuthRoutes(app);
  registerStorageRoutes(app);
  registerShareRoutes(app);
  registerRequestRoutes(app);

  app.get("/api/health", async () => ({ status: "ok" }));

  if (config.webDistDir && existsSync(config.webDistDir)) {
    await app.register(fastifyStatic, { root: config.webDistDir });
    // Single-page app: unknown non-API paths fall through to the client router.
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) {
        return reply.code(404).send({ error: "not found" });
      }
      return reply.sendFile("index.html");
    });
  }

  return app;
}
