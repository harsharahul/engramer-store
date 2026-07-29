import { existsSync } from "node:fs";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import fastifyStatic from "@fastify/static";
import { ZodError } from "zod";
import { ready } from "@engramer/crypto";
import { loadConfig, type ConfigOverrides, type ServerConfig } from "./config.js";
import { FsBlobStore, type BlobStore } from "./blobs.js";
import { DiskCachedBlobStore } from "./blobcache.js";
import { RoutedBlobStore } from "./routed.js";
import { S3BlobStore } from "./s3.js";
import { openDatabase, type Db } from "./db.js";
import { PostgresDb } from "./pgdb.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerStorageRoutes } from "./routes/storage.js";
import { registerShareRoutes } from "./routes/shares.js";
import { registerRequestRoutes } from "./routes/requests.js";

declare module "fastify" {
  interface FastifyInstance {
    config: ServerConfig;
    db: Db;
    blobs: BlobStore;
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
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
  // Embedded SQLite is the single-binary default; a connection string moves
  // the metadata to PostgreSQL so replicated deployments share one store.
  let db: Db;
  if (config.databaseUrl) {
    const postgres = new PostgresDb(config.databaseUrl);
    await postgres.migrate();
    db = postgres;
  } else {
    db = openDatabase(config.dbPath);
  }

  const app = Fastify({ bodyLimit: 16 * 1024 * 1024 });

  let blobs: BlobStore;
  if (config.s3) {
    const primary = new S3BlobStore(config.s3);
    await primary.init();
    let store: BlobStore = primary;
    // Opt-in split: derived blobs on their own backend (fast, unmetered)
    // while originals stay on the primary (cheap, possibly rate-limited).
    if (config.s3Derived) {
      const derived = new S3BlobStore(config.s3Derived);
      await derived.init();
      store = new RoutedBlobStore(primary, derived);
    }
    // Opt-in hot tier: derived blobs (thumbnails, search indexes) served
    // from local disk instead of a round trip per request. Pointless over
    // the local filesystem store, so it only ever wraps S3.
    blobs =
      config.blobCacheBytes > 0
        ? new DiskCachedBlobStore(store, config.blobCacheDir, config.blobCacheBytes)
        : store;
  } else {
    blobs = new FsBlobStore(config.blobDir);
  }

  app.decorate("config", config);
  app.decorate("blobs", blobs);
  app.decorate("db", db);
  app.addHook("onClose", async () => {
    await db.close();
  });
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
