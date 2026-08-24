import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import fastifyStatic from "@fastify/static";
import { ZodError } from "zod";
import { ready } from "@engramer/crypto";
import { loadConfig, type ConfigOverrides, type ServerConfig } from "./config.js";
import { FsBlobStore, type BlobStore } from "./blobs.js";
import { DiskCachedBlobStore } from "./blobcache.js";
import { MediaWindowCache } from "./mediacache.js";
import { RoutedBlobStore } from "./routed.js";
import { S3BlobStore } from "./s3.js";
import { ShardedKeyStore } from "./sharded.js";
import { openDatabase, type Db } from "./db.js";
import { PostgresDb } from "./pgdb.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerAuthRoutes } from "./routes/auth.js";
import websocket from "@fastify/websocket";
import { registerStorageRoutes } from "./routes/storage.js";
import { registerShareRoutes } from "./routes/shares.js";
import { registerRequestRoutes } from "./routes/requests.js";
import { registerCollabRoutes } from "./routes/collab.js";
import { registerChannelRoutes } from "./routes/channel.js";
import { registerEventsRoutes } from "./routes/events.js";
import { InProcessHub, type ChannelHub } from "./collabhub.js";
import { SeqEvents } from "./events.js";

declare module "fastify" {
  interface FastifyInstance {
    config: ServerConfig;
    db: Db;
    blobs: BlobStore;
    hub: ChannelHub;
    seqEvents: SeqEvents;
    /** Identifies this process in shared presence rows. */
    podId: string;
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: { uid: number; pending?: boolean; ep?: number };
    user: { uid: number; pending?: boolean; ep?: number };
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
  // per account (a stranger could then lock a user out) and blinds any
  // per-address limiting. Trust is opt-in and explicit, because believing
  // a forwarded header from just anyone is worse than ignoring it: an
  // untrusted caller could otherwise claim any address it likes.
  const app = Fastify({
    bodyLimit: 16 * 1024 * 1024,
    trustProxy: config.trustedProxies,
    // Structured request logs to stdout for whatever ships container logs
    // off the node. Off by default; even when on, entries carry only what
    // the server already sees: method, path (opaque ids), status, timing.
    logger:
      process.env.ENGRAMER_LOG_REQUESTS === "true"
        ? { level: "info" }
        : false,
    disableRequestLogging: process.env.ENGRAMER_LOG_REQUESTS !== "true",
  });

  let blobs: BlobStore;
  if (config.s3) {
    const s3Primary = new S3BlobStore(config.s3);
    await s3Primary.init();
    // Sharding is a key mapping over the bucket, applied directly around
    // the S3 client so every derived suffix shards with its blob.
    const primary: BlobStore =
      config.s3.keyLayout === "sharded" ? new ShardedKeyStore(s3Primary) : s3Primary;
    let store: BlobStore = primary;
    let derivedIsLocal = false;
    // Opt-in split: derived blobs on their own backend (fast, unmetered)
    // while originals stay on the primary (cheap, possibly rate-limited).
    // The derived side is either a second object store or the server's
    // own disk; on disk, every derived read is already local.
    if (config.derivedFsDir) {
      mkdirSync(config.derivedFsDir, { recursive: true });
      store = new RoutedBlobStore(primary, new FsBlobStore(config.derivedFsDir), {
        headBytes: config.bookendHeadBytes,
        tailBytes: config.bookendTailBytes,
      });
      derivedIsLocal = true;
    } else if (config.s3Derived) {
      const s3Derived = new S3BlobStore(config.s3Derived);
      await s3Derived.init();
      store = new RoutedBlobStore(
        primary,
        config.s3Derived.keyLayout === "sharded" ? new ShardedKeyStore(s3Derived) : s3Derived,
        { headBytes: config.bookendHeadBytes, tailBytes: config.bookendTailBytes },
      );
    }
    // Opt-in hot tier: derived blobs served from local disk instead of a
    // round trip per request, and, by its own knob, small content blobs
    // too. With the derived split already on local disk only the content
    // class is worth caching, so derived caching switches off there.
    const wantCache =
      config.blobCacheBytes > 0 && (!derivedIsLocal || config.contentCacheMaxBytes > 0);
    blobs = wantCache
      ? new DiskCachedBlobStore(store, config.blobCacheDir, config.blobCacheBytes, {
          cacheDerived: !derivedIsLocal,
          contentMaxBytes: config.contentCacheMaxBytes,
        })
      : store;
    // Opt-in content tier: media windows cached on local disk, so range
    // cycling, replays, and just-uploaded playback stop reaching the
    // backing store. Outermost so it fronts everything below.
    if (config.mediaCacheBytes > 0) {
      blobs = new MediaWindowCache(
        blobs,
        config.mediaCacheDir,
        config.mediaCacheBytes,
        config.mediaWindowBytes,
      );
    }
  } else {
    blobs = new FsBlobStore(config.blobDir);
  }

  app.decorate("config", config);
  app.decorate("blobs", blobs);
  app.decorate("db", db);
  app.decorate("hub", new InProcessHub());
  app.decorate("seqEvents", new SeqEvents());
  // The allocator sees every sequence advance, including the ones a
  // mutation makes on other accounts; the change feed watches it there.
  db.onSeq = (userId, seq) => app.seqEvents.note(userId, seq);
  app.decorate("podId", randomUUID());
  // Held event streams would otherwise keep close() waiting forever;
  // the websocket plugin drains its own clients the same way.
  app.addHook("preClose", async () => {
    app.seqEvents.closeAll();
  });
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
    const state = await db.get<{ disabled: number; token_epoch: number }>(
      "SELECT disabled, token_epoch FROM users WHERE id = ?",
      request.user.uid,
    );
    if (!state || state.disabled === 1) {
      await reply.code(403).send({ error: "this account is disabled" });
      return;
    }
    // A credential change advances the epoch; every token minted before it
    // is dead, so "I lost my password" also means "sign my old devices out".
    if ((request.user.ep ?? 0) !== (state.token_epoch ?? 0)) {
      await reply.code(401).send({ error: "authentication required" });
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
  // connect-src names the WebSocket schemes explicitly rather than leaning
  // on 'self' covering same-origin ws under CSP3 — cheap, and it removes a
  // class of works-in-one-browser-silently-dead-in-another failures for
  // the collaboration relay. Host-dependent, so the header is per request.
  //
  // upgrade-insecure-requests is included only when the page really did
  // arrive over TLS. On a plain-HTTP deployment it has nothing to upgrade
  // to, and browsers apply it to WebSockets as well: ws:// becomes wss://
  // against a server with no TLS, the handshake dies, and live editing
  // silently degrades to working alone. Behind a TLS-terminating proxy the
  // forwarded scheme is what counts, which is why this reads the request's
  // protocol rather than the socket's.
  const cspFor = (host: string, secure: boolean) =>
    [
      "default-src 'self'",
      `script-src 'self' 'wasm-unsafe-eval'${inlineScriptHashes.map((h) => ` '${h}'`).join("")}`,
      "worker-src 'self' blob:",
      `connect-src 'self' ${secure ? `wss://${host}` : `ws://${host}`}`,
      "img-src 'self' blob: data:",
      // stream: is the desktop shell's native media protocol; browsers
      // without it simply never reference such URLs.
      "media-src 'self' blob: stream:",
      "font-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "frame-src 'self' blob:",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      ...(secure ? ["upgrade-insecure-requests"] : []),
    ].join("; ");

  /**
   * The office editors are vendored third-party code that runs in a
   * sandboxed frame with no access to this origin's storage, cookies or
   * the page holding the master key. That frame is a separate, opaque
   * origin, which has three consequences for these responses and these
   * only: the assets are cross-origin to their own host, their fetches
   * arrive with a null origin, and framing checks that name an origin
   * cannot match an opaque one. The app's own documents and every API
   * route keep the strict policy above.
   *
   * The relaxed script policy is what the editors require to run at all;
   * it buys nothing for an attacker here, because the frame holds no key,
   * no session and no storage to reach.
   */
  const OFFICE_PREFIX = "/office/";
  /**
   * Built per request from the host it arrived on, because 'self' is
   * useless here: the editor runs in an opaque origin, and 'self'
   * resolves through the document's own origin, so it matches nothing.
   * Naming the origin explicitly lets the editor fetch its own assets
   * while still refusing every other destination, which matters because
   * this frame holds the decrypted document.
   *
   * Both schemes are named for that one host rather than trusting a
   * forwarded-protocol header: a terminator that does not set one would
   * otherwise have the editor refuse its own assets, and the host is ours
   * either way.
   */
  const officeCsp = (host: string): string => {
    // The host as this server sees it, plus any the deployment is reached on
    // that a proxy has rewritten away. Naming only the former is how the
    // editor ends up refusing every one of its own assets.
    const self = [`https://${host}`, `http://${host}`, ...config.publicOrigins].join(" ");
    return [
      `default-src ${self}`,
      `script-src ${self} 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'`,
      `worker-src ${self} blob:`,
      // blob: is how the document reaches the editor: it arrives as bytes
      // over a message and the frame mints its own URL, because a blob: URL
      // is readable only by the origin that made it.
      `connect-src ${self} blob:`,
      `img-src ${self} blob: data:`,
      `media-src ${self} blob:`,
      `font-src ${self} data:`,
      `style-src ${self} 'unsafe-inline'`,
      `frame-src ${self} blob:`,
      "object-src 'none'",
      `base-uri ${self}`,
      "form-action 'none'",
      // The editor's only ancestor is this application's own page, which has
      // a real origin, so framing can be restricted normally. It could not be
      // while a second sandboxed document sat in between: an opaque ancestor
      // matches no source expression, and this protection had to be dropped.
      "frame-ancestors 'self'",
    ].join("; ");
  };

  app.addHook("onSend", async (request, reply) => {
    if (request.url.startsWith(OFFICE_PREFIX)) {
      reply.header("content-security-policy", officeCsp(request.host));
      reply.header("x-content-type-options", "nosniff");
      reply.header("referrer-policy", "no-referrer");
      reply.header("cross-origin-resource-policy", "cross-origin");
      reply.header("access-control-allow-origin", "*");
      reply.removeHeader("x-frame-options");
      return;
    }
    reply.header("content-security-policy", cspFor(request.host, request.protocol === "https"));
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "DENY");
    // Share links carry the file key in the URL fragment; fragments are
    // never sent in Referer, but a blank referrer keeps tokens out of any
    // downstream log as well.
    reply.header("referrer-policy", "no-referrer");
    reply.header("permissions-policy", "camera=(), microphone=(), geolocation=()");
    reply.header("cross-origin-opener-policy", "same-origin");
    reply.header("cross-origin-resource-policy", "same-origin");
    // Only on a response that really travelled over TLS: sent on plain
    // HTTP the header is ignored by browsers and misleading in a log.
    if (config.hsts && request.protocol === "https") {
      reply.header("strict-transport-security", "max-age=31536000; includeSubDomains");
    }
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

  // Frames beyond this size are a protocol violation, not a big document:
  // real content travels through the blob store, never the relay.
  await app.register(websocket, { options: { maxPayload: 256 * 1024 } });

  registerAuthRoutes(app);
  registerAdminRoutes(app);
  registerStorageRoutes(app);
  registerShareRoutes(app);
  registerRequestRoutes(app);
  registerCollabRoutes(app);
  if (config.collabRelay) {
    registerChannelRoutes(app);
  }
  if (config.events) {
    registerEventsRoutes(app);
  }

  app.get("/api/health", async () => ({ status: "ok" }));

  if (config.webDistDir && existsSync(config.webDistDir)) {
    /**
     * The vendored editor ships a pre-compressed sibling for most of its
     * bulk, so a client that accepts brotli gets roughly a fifth of the
     * bytes for free. Served ahead of the general static handler, with the
     * original path's content type preserved.
     */
    app.addHook("onRequest", async (request, reply) => {
      if (!request.url.startsWith(OFFICE_PREFIX) || request.method !== "GET") {
        return;
      }
      const accepts = String(request.headers["accept-encoding"] ?? "").includes("br");
      if (!accepts) {
        return;
      }
      const path = request.url.split("?")[0] ?? "";
      // The office tree is generated, but a request path is not: refuse any
      // traversal before it reaches the filesystem.
      if (path.includes("..") || path.endsWith(".br")) {
        return;
      }
      const compressed = join(config.webDistDir!, `${path}.br`);
      if (!existsSync(compressed)) {
        return;
      }
      // Same validators the static handler would have sent: without them the
      // editor's tens of megabytes are re-fetched on every open instead of
      // being revalidated. The vendored tree is immutable for a given build,
      // so its identity is (size, mtime) of the compressed file.
      const info = statSync(compressed);
      reply.header("content-encoding", "br");
      reply.header("vary", "accept-encoding");
      reply.header("content-length", info.size);
      reply.header("last-modified", info.mtime.toUTCString());
      reply.header("etag", `"${info.size.toString(16)}-${info.mtimeMs.toString(16)}"`);
      // Revalidate rather than expire: these paths carry no build id, so a
      // freshness window would let a client hold some editor files across an
      // upgrade while others refresh, mixing two builds. The validators
      // above still make the second open a set of 304s wherever a cache
      // applies at all.
      reply.header("cache-control", "public, max-age=0, must-revalidate");
      reply.type(mimeFor(path));
      if (request.headers["if-none-match"] === reply.getHeader("etag")) {
        return reply.code(304).send();
      }
      return reply.send(createReadStream(compressed));
    });
    await app.register(fastifyStatic, {
      root: config.webDistDir,
      // The ML runtimes (onnx wasm, tesseract cores, barcode reader) are
      // tens of megabytes under versioned paths; the default max-age=0
      // makes Safari refuse to keep entries that large, so every upload
      // session re-downloads and re-compiles them. Versioned paths are
      // immutable by construction, and the language data file only ever
      // changes by being renamed.
      setHeaders: (reply: FastifyReply, filepath: string) => {
        const rel = relative(config.webDistDir!, filepath).split(sep).join("/");
        if (/^(ort|ocr|zxing|gliner-ort)\//.test(rel)) {
          reply.header("cache-control", "public, max-age=31536000, immutable");
        }
      },
    });
    // Single-page app: unknown non-API paths fall through to the client router.
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) {
        return reply.code(404).send({ error: "not found" });
      }
      // The office prefix answers with vendored files or with nothing. Falling
      // through would serve the app's own shell under the relaxed policy that
      // prefix carries, which is the one place this app must never run.
      if (request.url.startsWith(OFFICE_PREFIX)) {
        return reply.code(404).type("text/plain").send("not found");
      }
      return reply.sendFile("index.html");
    });
  }

  return app;
}

/** Content types for the file kinds the vendored editor serves compressed. */
const MIME_BY_EXT: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
};

function mimeFor(path: string): string {
  return MIME_BY_EXT[extname(path)] ?? "application/octet-stream";
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
