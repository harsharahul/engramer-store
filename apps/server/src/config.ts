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
  /** Directory of a built web client to serve, if any. */
  webDistDir: string | null;
  /** PostgreSQL connection string; unset means embedded SQLite. */
  databaseUrl: string | null;
  /** Who may create accounts: open (default), invite, or closed. */
  registration: "open" | "invite" | "closed";
  /** Extra browser origins allowed to call the API; empty means same-origin only. */
  corsOrigins: string[];
  /** Reverse proxies in front of this server; 0 means it is directly exposed. */
  trustedProxyHops: number;
  /** Lowercased emails that are administrators and may always register. */
  adminEmails: string[];
  /** When set, ciphertext blobs go to an S3-compatible object store. */
  s3: S3Settings | null;
  /** Separate destination for derived blobs (thumbnails, search indexes). */
  s3Derived: S3Settings | null;
  /** Disk budget for the derived-blob cache in front of S3; 0 disables it. */
  blobCacheBytes: number;
  blobCacheDir: string;
}

export interface ConfigOverrides {
  dataDir?: string;
  databaseUrl?: string | null;
  quotaBytes?: number;
  maxBlobBytes?: number;
  maxVersions?: number;
  port?: number;
  webDistDir?: string | null;
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
    webDistDir:
      overrides.webDistDir !== undefined
        ? overrides.webDistDir
        : (process.env.ENGRAMER_WEB_DIST ?? null),
    databaseUrl:
      overrides.databaseUrl !== undefined
        ? overrides.databaseUrl
        : (process.env.ENGRAMER_DATABASE_URL ?? null),
    registration: registrationMode(process.env.ENGRAMER_REGISTRATION),
    trustedProxyHops: positiveOrZero(process.env.ENGRAMER_TRUSTED_PROXY_HOPS),
    corsOrigins: (process.env.ENGRAMER_CORS_ORIGINS ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
    adminEmails: (process.env.ENGRAMER_ADMIN_EMAILS ?? "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
    s3,
    s3Derived: loadDerivedS3Settings(s3),
    blobCacheBytes: positiveOrZero(process.env.ENGRAMER_BLOB_CACHE_BYTES),
    blobCacheDir: process.env.ENGRAMER_BLOB_CACHE_DIR || join(dataDir, "blob-cache"),
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
