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
  /** Disk budget for the derived-blob cache in front of S3; 0 disables it. */
  blobCacheBytes: number;
  blobCacheDir: string;
  /** Disk budget for the content window cache; 0 disables it. */
  mediaCacheBytes: number;
  mediaCacheDir: string;
}

export interface ConfigOverrides {
  dataDir?: string;
  databaseUrl?: string | null;
  quotaBytes?: number;
  maxBlobBytes?: number;
  maxVersions?: number;
  collabRelay?: boolean;
  channelMaxBytes?: number;
  port?: number;
  webDistDir?: string | null;
  macAppDmgUrl?: string | null;
}

export function loadConfig(overrides: ConfigOverrides = {}): ServerConfig {
  const dataDir = overrides.dataDir ?? process.env.ENGRAMER_DATA_DIR ?? "data";
  const blobDir = join(dataDir, "blobs");
  mkdirSync(blobDir, { recursive: true });
  const s3 = loadS3Settings();

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
    s3Derived: loadDerivedS3Settings(s3),
    blobCacheBytes: positiveOrZero(process.env.ENGRAMER_BLOB_CACHE_BYTES),
    blobCacheDir: process.env.ENGRAMER_BLOB_CACHE_DIR || join(dataDir, "blob-cache"),
    mediaCacheBytes: positiveOrZero(process.env.ENGRAMER_MEDIA_CACHE_BYTES),
    mediaCacheDir: process.env.ENGRAMER_MEDIA_CACHE_DIR || join(dataDir, "media-cache"),
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
  };
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
