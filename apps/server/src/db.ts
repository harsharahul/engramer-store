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

export function openDatabase(path: string): Database.Database {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      login_key_digest TEXT NOT NULL,
      key_attributes TEXT NOT NULL,
      last_seq INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS folders (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      parent_id TEXT,
      encrypted_key TEXT NOT NULL,
      encrypted_meta TEXT NOT NULL,
      deleted INTEGER NOT NULL DEFAULT 0,
      update_seq INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS folders_user_seq ON folders(user_id, update_seq);
    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      folder_id TEXT,
      encrypted_key TEXT NOT NULL,
      encrypted_meta TEXT NOT NULL,
      size INTEGER NOT NULL DEFAULT 0,
      thumb_size INTEGER NOT NULL DEFAULT 0,
      uploaded INTEGER NOT NULL DEFAULT 0,
      trashed INTEGER NOT NULL DEFAULT 0,
      deleted INTEGER NOT NULL DEFAULT 0,
      update_seq INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS files_user_seq ON files(user_id, update_seq);
    CREATE TABLE IF NOT EXISTS shares (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      file_id TEXT NOT NULL REFERENCES files(id),
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS file_requests (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      folder_id TEXT,
      encrypted_meta TEXT NOT NULL,
      expires_at INTEGER,
      revoked INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS request_uploads (
      id TEXT PRIMARY KEY,
      request_token TEXT NOT NULL REFERENCES file_requests(token),
      user_id INTEGER NOT NULL REFERENCES users(id),
      sealed_key TEXT NOT NULL,
      encrypted_meta TEXT NOT NULL,
      size INTEGER NOT NULL DEFAULT 0,
      thumb_size INTEGER NOT NULL DEFAULT 0,
      uploaded INTEGER NOT NULL DEFAULT 0,
      consumed INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS request_uploads_owner ON request_uploads(user_id, uploaded, consumed);
    CREATE TABLE IF NOT EXISTS file_versions (
      file_id TEXT NOT NULL REFERENCES files(id),
      user_id INTEGER NOT NULL REFERENCES users(id),
      generation INTEGER NOT NULL,
      size INTEGER NOT NULL,
      encrypted_meta TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (file_id, generation)
    );
    CREATE INDEX IF NOT EXISTS file_versions_owner ON file_versions(user_id);
  `);
  // Additive migrations for databases created before these columns existed.
  ensureColumns(db, "files", {
    generation: "INTEGER NOT NULL DEFAULT 0",
    index_size: "INTEGER NOT NULL DEFAULT 0",
  });
  ensureColumns(db, "request_uploads", {
    index_size: "INTEGER NOT NULL DEFAULT 0",
  });
  ensureColumns(db, "users", {
    totp_secret: "TEXT",
    totp_enabled: "INTEGER NOT NULL DEFAULT 0",
    totp_last_step: "INTEGER NOT NULL DEFAULT 0",
    recovery_code_digests: "TEXT",
  });
  ensureColumns(db, "shares", {
    expires_at: "INTEGER",
    max_downloads: "INTEGER",
    download_count: "INTEGER NOT NULL DEFAULT 0",
    password_digest: "TEXT",
    password_kdf: "TEXT",
    wrapped_key: "TEXT",
  });
  return db;
}

function ensureColumns(
  db: Database.Database,
  table: string,
  columns: Record<string, string>,
): void {
  const existing = new Set(
    (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((c) => c.name),
  );
  for (const [name, type] of Object.entries(columns)) {
    if (!existing.has(name)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
    }
  }
}

/** Monotonic per-user sequence number; every mutation gets the next value. */
export function nextSeq(db: Database.Database, userId: number): number {
  const row = db
    .prepare("UPDATE users SET last_seq = last_seq + 1 WHERE id = ? RETURNING last_seq")
    .get(userId) as { last_seq: number };
  return row.last_seq;
}

/**
 * Bytes of ciphertext currently stored for a user (uploaded, not permanently
 * deleted), including file-request uploads waiting to be filed: those blobs
 * already occupy the owner's storage even before they are accepted.
 */
export function storageUsed(db: Database.Database, userId: number): number {
  const files = db
    .prepare(
      "SELECT COALESCE(SUM(size + thumb_size + index_size), 0) AS used FROM files WHERE user_id = ? AND deleted = 0",
    )
    .get(userId) as { used: number };
  const pending = db
    .prepare(
      "SELECT COALESCE(SUM(size + thumb_size + index_size), 0) AS used FROM request_uploads WHERE user_id = ? AND consumed = 0",
    )
    .get(userId) as { used: number };
  const versions = db
    .prepare("SELECT COALESCE(SUM(size), 0) AS used FROM file_versions WHERE user_id = ?")
    .get(userId) as { used: number };
  return files.used + pending.used + versions.used;
}
