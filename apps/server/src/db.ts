import Database from "better-sqlite3";

export interface UserRow {
  id: number;
  email: string;
  login_key_digest: string;
  key_attributes: string;
  last_seq: number;
  created_at: number;
  /** Base32 TOTP secret once two-factor is enabled, else null. */
  totp_secret: string | null;
  totp_enabled: number;
  /** Highest accepted TOTP step, so a code can never be replayed. */
  totp_last_step: number;
  /** JSON array of BLAKE2b digests of unused one-time recovery codes. */
  recovery_code_digests: string | null;
  /** A disabled account cannot sign in or use its sessions. */
  disabled: number;
  /** Per-user quota override in bytes; null means the server default. */
  quota_bytes: number | null;
}

export interface InviteRow {
  token: string;
  created_by: number;
  created_at: number;
  expires_at: number | null;
  used_by: number | null;
  used_at: number | null;
}

export interface FolderRow {
  id: string;
  user_id: number;
  parent_id: string | null;
  encrypted_key: string;
  encrypted_meta: string;
  deleted: number;
  update_seq: number;
  created_at: number;
  updated_at: number;
}

export interface FileRow {
  id: string;
  user_id: number;
  folder_id: string | null;
  encrypted_key: string;
  encrypted_meta: string;
  size: number;
  thumb_size: number;
  /** Size of the encrypted search-text blob, 0 when none. */
  index_size: number;
  /** Which content blob is current: 0 = `<id>`, N = `<id>.g<N>`. */
  generation: number;
  uploaded: number;
  trashed: number;
  deleted: number;
  update_seq: number;
  created_at: number;
  updated_at: number;
}

export interface FileVersionRow {
  file_id: string;
  user_id: number;
  generation: number;
  size: number;
  /** Snapshot of the file's encrypted metadata when this content was current. */
  encrypted_meta: string;
  created_at: number;
}

export interface ShareRow {
  token: string;
  user_id: number;
  file_id: string;
  created_at: number;
  expires_at: number | null;
  max_downloads: number | null;
  download_count: number;
  password_digest: string | null;
  password_kdf: string | null;
  wrapped_key: string | null;
}

export interface FileRequestRow {
  token: string;
  user_id: number;
  folder_id: string | null;
  encrypted_meta: string;
  expires_at: number | null;
  revoked: number;
  created_at: number;
}

export interface RequestUploadRow {
  id: string;
  request_token: string;
  user_id: number;
  sealed_key: string;
  encrypted_meta: string;
  size: number;
  thumb_size: number;
  index_size: number;
  uploaded: number;
  consumed: number;
  created_at: number;
}

export interface DbRunResult {
  changes: number;
}

/**
 * The metadata database behind an async facade, so the same route code runs
 * on embedded SQLite (the single-binary default) and on PostgreSQL (the
 * shared store for replicated deployments). SQL is written once in SQLite
 * placeholder style; the PostgreSQL implementation translates placeholders.
 *
 * The rule that keeps both implementations honest: a tx() callback must only
 * await database calls on the handle it is given, never I/O. Blob writes
 * happen BEFORE their transaction by design (see routes/storage.ts), which
 * is also what makes the SQLite implementation sound: with no foreign await
 * inside the callback the whole transaction runs in one macrotask turn and
 * no other request's statement can interleave into it.
 */
export interface Db {
  get<T = unknown>(sql: string, ...params: unknown[]): Promise<T | undefined>;
  all<T = unknown>(sql: string, ...params: unknown[]): Promise<T[]>;
  run(sql: string, ...params: unknown[]): Promise<DbRunResult>;
  tx<T>(fn: (t: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** Additive column migrations, shared by both backends. BIGINT is accepted
 * by SQLite (INTEGER affinity) and exact in PostgreSQL. */
export const COLUMN_MIGRATIONS: Array<{ table: string; column: string; type: string }> = [
  { table: "files", column: "generation", type: "BIGINT NOT NULL DEFAULT 0" },
  { table: "files", column: "index_size", type: "BIGINT NOT NULL DEFAULT 0" },
  { table: "request_uploads", column: "index_size", type: "BIGINT NOT NULL DEFAULT 0" },
  { table: "users", column: "totp_secret", type: "TEXT" },
  { table: "users", column: "totp_enabled", type: "BIGINT NOT NULL DEFAULT 0" },
  { table: "users", column: "totp_last_step", type: "BIGINT NOT NULL DEFAULT 0" },
  { table: "users", column: "recovery_code_digests", type: "TEXT" },
  { table: "users", column: "disabled", type: "BIGINT NOT NULL DEFAULT 0" },
  { table: "users", column: "quota_bytes", type: "BIGINT" },
  { table: "shares", column: "expires_at", type: "BIGINT" },
  { table: "shares", column: "max_downloads", type: "BIGINT" },
  { table: "shares", column: "download_count", type: "BIGINT NOT NULL DEFAULT 0" },
  { table: "shares", column: "password_digest", type: "TEXT" },
  { table: "shares", column: "password_kdf", type: "TEXT" },
  { table: "shares", column: "wrapped_key", type: "TEXT" },
];

/** Tables shared verbatim between the two dialects. */
export const COMMON_SCHEMA = `
    CREATE TABLE IF NOT EXISTS folders (
      id TEXT PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id),
      parent_id TEXT,
      encrypted_key TEXT NOT NULL,
      encrypted_meta TEXT NOT NULL,
      deleted BIGINT NOT NULL DEFAULT 0,
      update_seq BIGINT NOT NULL,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS folders_user_seq ON folders(user_id, update_seq);
    CREATE INDEX IF NOT EXISTS folders_parent ON folders(user_id, parent_id);
    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id),
      folder_id TEXT,
      encrypted_key TEXT NOT NULL,
      encrypted_meta TEXT NOT NULL,
      size BIGINT NOT NULL DEFAULT 0,
      thumb_size BIGINT NOT NULL DEFAULT 0,
      uploaded BIGINT NOT NULL DEFAULT 0,
      trashed BIGINT NOT NULL DEFAULT 0,
      deleted BIGINT NOT NULL DEFAULT 0,
      update_seq BIGINT NOT NULL,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS files_user_seq ON files(user_id, update_seq);
    CREATE INDEX IF NOT EXISTS files_folder ON files(user_id, folder_id);
    CREATE TABLE IF NOT EXISTS shares (
      token TEXT PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id),
      file_id TEXT NOT NULL REFERENCES files(id),
      created_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS shares_owner ON shares(user_id);
    CREATE INDEX IF NOT EXISTS shares_file ON shares(file_id);
    CREATE TABLE IF NOT EXISTS file_requests (
      token TEXT PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id),
      folder_id TEXT,
      encrypted_meta TEXT NOT NULL,
      expires_at BIGINT,
      revoked BIGINT NOT NULL DEFAULT 0,
      created_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS file_requests_owner ON file_requests(user_id);
    CREATE TABLE IF NOT EXISTS request_uploads (
      id TEXT PRIMARY KEY,
      request_token TEXT NOT NULL REFERENCES file_requests(token),
      user_id BIGINT NOT NULL REFERENCES users(id),
      sealed_key TEXT NOT NULL,
      encrypted_meta TEXT NOT NULL,
      size BIGINT NOT NULL DEFAULT 0,
      thumb_size BIGINT NOT NULL DEFAULT 0,
      uploaded BIGINT NOT NULL DEFAULT 0,
      consumed BIGINT NOT NULL DEFAULT 0,
      created_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS request_uploads_owner ON request_uploads(user_id, uploaded, consumed);
    CREATE TABLE IF NOT EXISTS file_versions (
      file_id TEXT NOT NULL REFERENCES files(id),
      user_id BIGINT NOT NULL REFERENCES users(id),
      generation BIGINT NOT NULL,
      size BIGINT NOT NULL,
      encrypted_meta TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      PRIMARY KEY (file_id, generation)
    );
    CREATE INDEX IF NOT EXISTS file_versions_owner ON file_versions(user_id);
    CREATE TABLE IF NOT EXISTS auth_throttle (
      key TEXT PRIMARY KEY,
      failures BIGINT NOT NULL DEFAULT 0,
      blocked_until BIGINT NOT NULL DEFAULT 0,
      last_failure BIGINT NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS invites (
      token TEXT PRIMARY KEY,
      created_by BIGINT NOT NULL REFERENCES users(id),
      created_at BIGINT NOT NULL,
      expires_at BIGINT,
      used_by BIGINT,
      used_at BIGINT
    );
`;

/** Embedded SQLite behind the async facade; every call is synchronous
 * underneath, which is exactly what makes it safe (see the Db contract). */
export class SqliteDb implements Db {
  /** Serializes transactions; two tx() calls never interleave. */
  private txQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly db: Database.Database) {}

  async get<T = unknown>(sql: string, ...params: unknown[]): Promise<T | undefined> {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  async all<T = unknown>(sql: string, ...params: unknown[]): Promise<T[]> {
    return this.db.prepare(sql).all(...params) as T[];
  }

  async run(sql: string, ...params: unknown[]): Promise<DbRunResult> {
    const result = this.db.prepare(sql).run(...params);
    return { changes: result.changes };
  }

  tx<T>(fn: (t: Db) => Promise<T>): Promise<T> {
    const task = this.txQueue.then(async () => {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const result = await fn(this);
        this.db.exec("COMMIT");
        return result;
      } catch (err) {
        this.db.exec("ROLLBACK");
        throw err;
      }
    });
    this.txQueue = task.catch(() => {});
    return task;
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

export function openDatabase(path: string): SqliteDb {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      login_key_digest TEXT NOT NULL,
      key_attributes TEXT NOT NULL,
      last_seq BIGINT NOT NULL DEFAULT 0,
      created_at BIGINT NOT NULL
    );
    ${COMMON_SCHEMA}
  `);
  // Additive migrations for databases created before these columns existed.
  const existingColumns = (table: string) =>
    new Set((db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((c) => c.name));
  const byTable = new Map<string, Set<string>>();
  for (const migration of COLUMN_MIGRATIONS) {
    let existing = byTable.get(migration.table);
    if (!existing) {
      existing = existingColumns(migration.table);
      byTable.set(migration.table, existing);
    }
    if (!existing.has(migration.column)) {
      db.exec(`ALTER TABLE ${migration.table} ADD COLUMN ${migration.column} ${migration.type}`);
    }
  }
  return new SqliteDb(db);
}

/** Monotonic per-user sequence number; every mutation gets the next value.
 * The single-row UPDATE serializes writers per user on both backends. */
export async function nextSeq(db: Db, userId: number): Promise<number> {
  const row = await db.get<{ last_seq: number }>(
    "UPDATE users SET last_seq = last_seq + 1 WHERE id = ? RETURNING last_seq",
    userId,
  );
  return row!.last_seq;
}

/** The user's effective quota: their override, or the server default. */
export async function userQuota(db: Db, userId: number, defaultQuota: number): Promise<number> {
  const row = await db.get<{ quota_bytes: number | null }>(
    "SELECT quota_bytes FROM users WHERE id = ?",
    userId,
  );
  return row?.quota_bytes ?? defaultQuota;
}

/**
 * Bytes of ciphertext currently stored for a user (uploaded, not permanently
 * deleted), including file-request uploads waiting to be filed: those blobs
 * already occupy the owner's storage even before they are accepted.
 */
export async function storageUsed(db: Db, userId: number): Promise<number> {
  const files = await db.get<{ used: number }>(
    "SELECT COALESCE(SUM(size + thumb_size + index_size), 0) AS used FROM files WHERE user_id = ? AND deleted = 0",
    userId,
  );
  const pending = await db.get<{ used: number }>(
    "SELECT COALESCE(SUM(size + thumb_size + index_size), 0) AS used FROM request_uploads WHERE user_id = ? AND consumed = 0",
    userId,
  );
  const versions = await db.get<{ used: number }>(
    "SELECT COALESCE(SUM(size), 0) AS used FROM file_versions WHERE user_id = ?",
    userId,
  );
  return files!.used + pending!.used + versions!.used;
}
