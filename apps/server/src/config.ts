import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface S3Settings {
  endpoint?: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
  /** Request-budget knobs for rate-limited backing stores; 0 = unlimited. */
  maxTps: number;
  maxConcurrent: number;
  /**
   * When the SDK adds request checksums, in the SDK's own vocabulary.
   * "when-supported" is the AWS default; "when-required" is for
   * third-party S3 implementations, which the default breaks: the SDK
   * rewrites streaming bodies into aws-chunked framing with checksum
   * trailers and drops Content-Length, and strict servers refuse that
   * with 411.
   */
  checksums: "when-supported" | "when-required";
  /** Whether init() may create a missing bucket; hosts that hand out a
   * fixed bucket deny CreateBucket, where trying it fails the boot. */
  createBucket: boolean;
  /**
   * How keys map into the bucket. "sharded" fans them into two directory
   * levels (`ab/cd/abcd-99`), which directory-shaped hosts behind S3
   * gateways need: a large library in one folder makes every listing cost
   * seconds. Choose before the first upload; layouts are not migrated.
   */
  keyLayout: "flat" | "sharded";
}

export interface ServerConfig {
  port: number;
  host: string;
  dataDir: string;
  blobDir: string;
  dbPath: string;
  jwtSecret: string;
  /** Per-user storage quota in bytes. */
  quotaBytes: number;
  /** Hard cap for a single ciphertext blob in bytes. */
  maxBlobBytes: number;
  /** Versions kept per file after a content replacement; 0 disables history. */
  maxVersions: number;
  /** Whether the live-collaboration relay accepts connections. */
  collabRelay: boolean;
  /** Whether the change feed (server-sent events) accepts connections. */
  events: boolean;
  /** Change-feed heartbeat cadence; also how often a held stream
   * re-checks that its session is still valid. */
  eventsHeartbeatMs: number;
  /** Ceiling on a document channel's stored frames, in bytes. */
  channelMaxBytes: number;
  /** Directory of a built web client to serve, if any. */
  webDistDir: string | null;
  /** PostgreSQL connection string; unset means embedded SQLite. */
  databaseUrl: string | null;
  /** Who may create accounts: open (default), invite, or closed. */
  registration: "open" | "invite" | "closed";
  /// Where the Mac app's DMG is hosted, or null when this deployment
  /// offers none; the download route redirects here and the web app
  /// shows its download link only when set.
  macAppDmgUrl: string | null;
  /** Extra browser origins allowed to call the API; empty means same-origin only. */
  corsOrigins: string[];
  /** Send Strict-Transport-Security on HTTPS responses. Off by default,
   * because the terminating proxy usually owns this header. */
  hsts: boolean;
  /**
   * Who is allowed to speak for the client address. Either a hop count
   * ("2") or, preferably, a comma-separated list of proxy addresses and
   * CIDR ranges, which keeps working when a layer is added or removed.
   * Empty means this server is directly exposed and forwarded headers are
   * ignored entirely.
   */
  trustedProxies: string | number | false;
  /**
   * Every origin a browser may reach this server on, when a proxy in front
   * rewrites the Host header. The office editor runs in an opaque origin,
   * whose content policy therefore cannot say 'self' and has to name the
   * origin its own assets come from; behind such a proxy the server sees an
   * internal hostname and would name that one, refusing every asset the
   * editor loads. Deployments reached only at the address the server sees
   * need nothing here.
   */
  publicOrigins: string[];
  /** Lowercased emails that are administrators and may always register. */
  adminEmails: string[];
  /** When set, ciphertext blobs go to an S3-compatible object store. */
  s3: S3Settings | null;
  /** Separate destination for derived blobs (thumbnails, search indexes). */
  s3Derived: S3Settings | null;
  /**
   * Local directory for derived blobs, the other kind of split: originals
   * on the (possibly remote, possibly rate-limited) primary, derived data
   * on the server's own disk where a grid scroll never pays a round trip.
   * Everything here regrows: thumbnails and indexes from client backfill,
   * bookends from the primary on first ranged read.
   */
  derivedFsDir: string | null;
  /** Disk budget for the derived-blob cache in front of S3; 0 disables it. */
  blobCacheBytes: number;
  blobCacheDir: string;
  /** Content blobs at or under this size are cached on local disk too; 0
   * disables it. The lever that makes repeat document opens local when
   * the primary store is seconds away. */
  contentCacheMaxBytes: number;
  /** Disk budget for the content window cache; 0 disables it. */
  mediaCacheBytes: number;
  mediaCacheDir: string;
  /**
   * Tier geometry, tunable per backing store: a high-latency provider
   * wants fewer, larger reads; a fast one the opposite. Defaults are the
   * sizes the tiers shipped with.
   */
  mediaWindowBytes: number;
  bookendHeadBytes: number;
  bookendTailBytes: number;
}

export interface ConfigOverrides {
  dataDir?: string;
  databaseUrl?: string | null;
  quotaBytes?: number;
  maxBlobBytes?: number;
  maxVersions?: number;
  collabRelay?: boolean;
  events?: boolean;
  eventsHeartbeatMs?: number;
  channelMaxBytes?: number;
  port?: number;
  webDistDir?: string | null;
  macAppDmgUrl?: string | null;
  hsts?: boolean;
}

export function loadConfig(overrides: ConfigOverrides = {}): ServerConfig {
  const dataDir = overrides.dataDir ?? process.env.ENGRAMER_DATA_DIR ?? "data";
  const blobDir = join(dataDir, "blobs");
  mkdirSync(blobDir, { recursive: true });
  const s3 = loadS3Settings();
  const derivedFsDir = loadDerivedFsDir(dataDir);

  return {
    port: overrides.port ?? Number(process.env.ENGRAMER_PORT ?? 3080),
    host: process.env.ENGRAMER_HOST ?? "127.0.0.1",
    dataDir,
    blobDir,
    dbPath: join(dataDir, "engramer.db"),
    jwtSecret: loadOrCreateJwtSecret(dataDir),
    quotaBytes:
      overrides.quotaBytes ?? Number(process.env.ENGRAMER_QUOTA_BYTES ?? 10 * 1024 ** 3),
    maxBlobBytes:
      overrides.maxBlobBytes ?? Number(process.env.ENGRAMER_MAX_BLOB_BYTES ?? 20 * 1024 ** 3),
    maxVersions: Math.max(
      0,
      overrides.maxVersions ?? Number(process.env.ENGRAMER_MAX_VERSIONS ?? 10),
    ),
    collabRelay:
      overrides.collabRelay ?? (process.env.ENGRAMER_COLLAB_RELAY ?? "on") !== "off",
    events: overrides.events ?? (process.env.ENGRAMER_EVENTS ?? "on") !== "off",
    eventsHeartbeatMs:
      overrides.eventsHeartbeatMs ??
      Number(process.env.ENGRAMER_EVENTS_HEARTBEAT_MS ?? 25_000),
    hsts: overrides.hsts ?? ["on", "1", "true"].includes((process.env.ENGRAMER_HSTS ?? "off").toLowerCase()),
    // A ceiling smaller than one checkpoint crossing's worth of typing
    // puts a busy room into a trim-reload spiral no client can follow:
    // stress runs showed refused frames dying with the remounts they
    // cause. 64 KiB is minutes of typing, far above any crossing, and
    // still small enough to test the checkpoint machinery locally. Test
    // code that needs a tiny cap passes it as a programmatic override.
    channelMaxBytes:
      overrides.channelMaxBytes ??
      Math.max(65_536, Number(process.env.ENGRAMER_CHANNEL_MAX_BYTES ?? 8 * 1024 * 1024)),
    webDistDir:
      overrides.webDistDir !== undefined
        ? overrides.webDistDir
        : (process.env.ENGRAMER_WEB_DIST ?? null),
    databaseUrl:
      overrides.databaseUrl !== undefined
        ? overrides.databaseUrl
        : (process.env.ENGRAMER_DATABASE_URL ?? null),
    registration: registrationMode(process.env.ENGRAMER_REGISTRATION),
    macAppDmgUrl:
      overrides.macAppDmgUrl !== undefined
        ? overrides.macAppDmgUrl
        : (process.env.ENGRAMER_MAC_DMG_URL ?? "").trim() || null,
    trustedProxies: parseTrustedProxies(process.env.ENGRAMER_TRUSTED_PROXIES),
    corsOrigins: (process.env.ENGRAMER_CORS_ORIGINS ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
    publicOrigins: (process.env.ENGRAMER_PUBLIC_ORIGINS ?? "")
      .split(",")
      .map((origin) => origin.trim().replace(/\/+$/, ""))
      // A malformed entry would land verbatim in a security header, so only
      // well-formed scheme://host[:port] values are kept.
      .filter((origin) => /^https?:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(origin)),
    adminEmails: (process.env.ENGRAMER_ADMIN_EMAILS ?? "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
    s3,
    s3Derived: derivedFsDir ? null : loadDerivedS3Settings(s3),
    derivedFsDir,
    blobCacheBytes: positiveOrZero(process.env.ENGRAMER_BLOB_CACHE_BYTES),
    blobCacheDir: process.env.ENGRAMER_BLOB_CACHE_DIR || join(dataDir, "blob-cache"),
    contentCacheMaxBytes: positiveOrZero(process.env.ENGRAMER_CONTENT_CACHE_MAX_BYTES),
    mediaCacheBytes: positiveOrZero(process.env.ENGRAMER_MEDIA_CACHE_BYTES),
    mediaCacheDir: process.env.ENGRAMER_MEDIA_CACHE_DIR || join(dataDir, "media-cache"),
    mediaWindowBytes:
      positiveOrZero(process.env.ENGRAMER_MEDIA_WINDOW_BYTES) || 32 * 1024 * 1024,
    bookendHeadBytes:
      positiveOrZero(process.env.ENGRAMER_BOOKEND_HEAD_BYTES) || 32 * 1024 * 1024,
    bookendTailBytes:
      positiveOrZero(process.env.ENGRAMER_BOOKEND_TAIL_BYTES) || 64 * 1024 * 1024,
  };
}

function loadS3Settings(): S3Settings | null {
  const bucket = process.env.ENGRAMER_S3_BUCKET;
  if (!bucket) {
    return null;
  }
  const accessKeyId = process.env.ENGRAMER_S3_ACCESS_KEY;
  const secretAccessKey = process.env.ENGRAMER_S3_SECRET_KEY;
  if (!accessKeyId || !secretAccessKey) {
    throw new Error("ENGRAMER_S3_BUCKET is set but access credentials are missing");
  }
  return {
    endpoint: process.env.ENGRAMER_S3_ENDPOINT || undefined,
    region: process.env.ENGRAMER_S3_REGION ?? "us-east-1",
    bucket,
    accessKeyId,
    secretAccessKey,
    forcePathStyle: process.env.ENGRAMER_S3_FORCE_PATH_STYLE !== "false",
    maxTps: positiveOrZero(process.env.ENGRAMER_S3_MAX_TPS),
    maxConcurrent: positiveOrZero(process.env.ENGRAMER_S3_MAX_CONCURRENT),
    checksums: checksumMode(process.env.ENGRAMER_S3_CHECKSUMS),
    createBucket: process.env.ENGRAMER_S3_CREATE_BUCKET !== "false",
    keyLayout: keyLayout(process.env.ENGRAMER_S3_KEY_LAYOUT),
  };
}

function keyLayout(raw: string | undefined): "flat" | "sharded" {
  const value = (raw ?? "").trim();
  if (value === "" || value === "flat") {
    return "flat";
  }
  if (value === "sharded") {
    return "sharded";
  }
  throw new Error(`ENGRAMER_S3_KEY_LAYOUT must be "flat" or "sharded", not "${value}"`);
}

function checksumMode(raw: string | undefined): "when-supported" | "when-required" {
  const value = (raw ?? "").trim();
  if (value === "" || value === "when-supported") {
    return "when-supported";
  }
  if (value === "when-required") {
    return "when-required";
  }
  throw new Error(
    `ENGRAMER_S3_CHECKSUMS must be "when-supported" or "when-required", not "${value}"`,
  );
}

/**
 * A forwarded client address is only as trustworthy as the hop that set
 * it, so this is opt-in: unset means every request is attributed to its
 * direct peer. A numeric value trusts that many hops; anything else is
 * passed through as a proxy allowlist (addresses, CIDRs, or the shorthands
 * the underlying parser understands, such as "loopback" or "uniquelocal").
 */
function parseTrustedProxies(raw: string | undefined): string | number | false {
  const value = raw?.trim();
  if (!value) {
    return false;
  }
  const hops = Number(value);
  if (Number.isInteger(hops)) {
    return hops > 0 ? hops : false;
  }
  return value;
}

function registrationMode(raw: string | undefined): "open" | "invite" | "closed" {
  return raw === "invite" || raw === "closed" ? raw : "open";
}

/** Opt-in numeric knob: absent, empty, or non-positive all mean "off". */
function positiveOrZero(raw: string | undefined): number {
  const value = Number(raw ?? 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * The filesystem flavor of the derived split, chosen explicitly with
 * ENGRAMER_DERIVED_BACKEND=fs. Refuses to coexist with a derived S3
 * bucket: two destinations for the same blobs is a configuration
 * mistake, not a preference, and half the derived data quietly landing
 * in each would look like random cache misses forever.
 */
function loadDerivedFsDir(dataDir: string): string | null {
  const backend = (process.env.ENGRAMER_DERIVED_BACKEND ?? "").trim();
  if (backend === "" || backend === "s3") {
    return null;
  }
  if (backend !== "fs") {
    throw new Error(`ENGRAMER_DERIVED_BACKEND must be "fs" or "s3", not "${backend}"`);
  }
  if (process.env.ENGRAMER_S3_DERIVED_BUCKET) {
    throw new Error(
      "choose one derived destination: ENGRAMER_DERIVED_BACKEND=fs or ENGRAMER_S3_DERIVED_BUCKET, not both",
    );
  }
  return process.env.ENGRAMER_DERIVED_DIR?.trim() || join(dataDir, "derived");
}

/**
 * Derived blobs (thumbnails, search indexes) can live on their own backend:
 * request-heavy tiny objects want a fast unmetered store while the
 * originals sit on cheap, possibly rate-limited storage. Setting
 * ENGRAMER_S3_DERIVED_BUCKET enables the split; connection settings fall
 * back to the primary's so a second bucket on the same store is one
 * variable. The request budget deliberately does NOT fall back: the whole
 * point is that the derived store is usually the one WITHOUT a rate limit.
 */
function loadDerivedS3Settings(primary: S3Settings | null): S3Settings | null {
  const bucket = process.env.ENGRAMER_S3_DERIVED_BUCKET;
  if (!bucket || !primary) {
    return null;
  }
  return {
    endpoint: process.env.ENGRAMER_S3_DERIVED_ENDPOINT || primary.endpoint,
    region: process.env.ENGRAMER_S3_DERIVED_REGION ?? primary.region,
    bucket,
    accessKeyId: process.env.ENGRAMER_S3_DERIVED_ACCESS_KEY ?? primary.accessKeyId,
    secretAccessKey: process.env.ENGRAMER_S3_DERIVED_SECRET_KEY ?? primary.secretAccessKey,
    forcePathStyle:
      process.env.ENGRAMER_S3_DERIVED_FORCE_PATH_STYLE !== undefined
        ? process.env.ENGRAMER_S3_DERIVED_FORCE_PATH_STYLE !== "false"
        : primary.forcePathStyle,
    maxTps: positiveOrZero(process.env.ENGRAMER_S3_DERIVED_MAX_TPS),
    maxConcurrent: positiveOrZero(process.env.ENGRAMER_S3_DERIVED_MAX_CONCURRENT),
    // Same implementation family as the primary in practice, so the
    // compatibility posture carries over.
    checksums: primary.checksums,
    createBucket: primary.createBucket,
    keyLayout: primary.keyLayout,
  };
}

function loadOrCreateJwtSecret(dataDir: string): string {
  // An explicit secret wins: replicas must share one signing key, and in
  // Kubernetes that means a Secret in the environment, not a per-pod file.
  const fromEnv = process.env.ENGRAMER_JWT_SECRET?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  const path = join(dataDir, "jwt-secret");
  if (existsSync(path)) {
    return readFileSync(path, "utf8").trim();
  }
  const secret = randomBytes(32).toString("base64url");
  writeFileSync(path, secret, { mode: 0o600 });
  return secret;
}
