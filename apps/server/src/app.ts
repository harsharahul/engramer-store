import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
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
import { registerAdminRoutes } from "./routes/admin.js";
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

  // Behind a reverse proxy every request otherwise carries the proxy's
  // address, which collapses the failure throttle into one global bucket
  // per account (a stranger could lock a user out) and blinds any per-IP
  // limiting. Enabled only when the operator declares the hop count, since
  // trusting a forwarded header unconditionally is worse than not trusting
  // it at all.
  const app = Fastify({
    bodyLimit: 16 * 1024 * 1024,
    trustProxy: config.trustedProxyHops > 0 ? config.trustedProxyHops : false,
  });

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
      return;
    }
    // Disabling an account must cut off its existing sessions too, not just
    // future logins; a token alone is never enough.
    const state = await db.get<{ disabled: number }>(
      "SELECT disabled FROM users WHERE id = ?",
      request.user.uid,
    );
    if (!state || state.disabled === 1) {
      await reply.code(403).send({ error: "this account is disabled" });
    }
  });

  // Ciphertext blobs arrive as raw octet streams and are piped straight to disk.
  app.addContentTypeParser("application/octet-stream", (_request, payload, done) => {
    done(null, payload);
  });

  /**
   * Security headers for a browser client whose master key lives in the
   * page: any script execution in this origin is total compromise, so the
   * policy is deny-by-default and allows only what the app actually uses.
   * 'wasm-unsafe-eval' is required by the on-device OCR engine; blob: URLs
   * carry decrypted previews; data: URIs carry inline placeholders and QR
   * codes. No external origin is reachable, which also means a compromised
   * dependency cannot exfiltrate plaintext.
   */
  // The client ships a tiny inline script that applies the saved theme
  // before first paint. Rather than weakening the policy with
  // 'unsafe-inline', its hash is computed from the served index.html at
  // startup, so editing that script never silently breaks the page.
  const inlineScriptHashes = config.webDistDir
    ? hashInlineScripts(join(config.webDistDir, "index.html"))
    : [];
  const CSP = [
    "default-src 'self'",
    `script-src 'self' 'wasm-unsafe-eval'${inlineScriptHashes.map((h) => ` '${h}'`).join("")}`,
    "worker-src 'self' blob:",
    "connect-src 'self'",
    "img-src 'self' blob: data:",
    "media-src 'self' blob:",
    "font-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "frame-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "upgrade-insecure-requests",
  ].join("; ");

  app.addHook("onSend", async (_request, reply) => {
    reply.header("content-security-policy", CSP);
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "DENY");
    // Share links carry the file key in the URL fragment; fragments are
    // never sent in Referer, but a blank referrer keeps tokens out of any
    // downstream log as well.
    reply.header("referrer-policy", "no-referrer");
    reply.header("permissions-policy", "camera=(), microphone=(), geolocation=()");
    reply.header("cross-origin-opener-policy", "same-origin");
    reply.header("cross-origin-resource-policy", "same-origin");
  });

  app.setErrorHandler((error: unknown, _request, reply) => {
    if (error instanceof ZodError) {
      // The shape of a rejected payload is not the caller's business.
      return reply.code(400).send({ error: "invalid request" });
    }
    app.log.error(error);
    const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
    return reply.code(statusCode).send({ error: "internal server error" });
  });

  // Cross-origin access is off by default: the web client is served from
  // this same origin, so nothing legitimate needs it. Deployments that put
  // a client on another origin can list it explicitly.
  await app.register(cors, {
    origin: config.corsOrigins.length > 0 ? config.corsOrigins : false,
  });
  await app.register(jwt, { secret: config.jwtSecret, sign: { expiresIn: "30d" } });

  registerAuthRoutes(app);
  registerAdminRoutes(app);
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

/** sha256 CSP hashes of every inline <script> in the served page. */
function hashInlineScripts(indexPath: string): string[] {
  if (!existsSync(indexPath)) {
    return [];
  }
  const html = readFileSync(indexPath, "utf8");
  const hashes: string[] = [];
  for (const match of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) {
    const body = match[1] ?? "";
    if (body.trim().length > 0) {
      hashes.push(`sha256-${createHash("sha256").update(body, "utf8").digest("base64")}`);
    }
  }
  return hashes;
}
