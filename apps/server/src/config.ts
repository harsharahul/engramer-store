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
  /** When set, ciphertext blobs go to an S3-compatible object store. */
  s3: S3Settings | null;
}

export interface ConfigOverrides {
  dataDir?: string;
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
    s3: loadS3Settings(),
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
  };
}

function loadOrCreateJwtSecret(dataDir: string): string {
  const path = join(dataDir, "jwt-secret");
  if (existsSync(path)) {
    return readFileSync(path, "utf8").trim();
  }
  const secret = randomBytes(32).toString("base64url");
  writeFileSync(path, secret, { mode: 0o600 });
  return secret;
}
