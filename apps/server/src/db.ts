import Database from "better-sqlite3";

export interface UserRow {
  id: number;
  email: string;
  login_key_digest: string;
  key_attributes: string;
  last_seq: number;
  created_at: number;
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
  uploaded: number;
  trashed: number;
  deleted: number;
  update_seq: number;
  created_at: number;
  updated_at: number;
}

export interface ShareRow {
  token: string;
  user_id: number;
  file_id: string;
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
  `);
  return db;
}

/** Monotonic per-user sequence number; every mutation gets the next value. */
export function nextSeq(db: Database.Database, userId: number): number {
  const row = db
    .prepare("UPDATE users SET last_seq = last_seq + 1 WHERE id = ? RETURNING last_seq")
    .get(userId) as { last_seq: number };
  return row.last_seq;
}

/** Bytes of ciphertext currently stored for a user (uploaded, not permanently deleted). */
export function storageUsed(db: Database.Database, userId: number): number {
  const row = db
    .prepare(
      "SELECT COALESCE(SUM(size + thumb_size), 0) AS used FROM files WHERE user_id = ? AND deleted = 0",
    )
    .get(userId) as { used: number };
  return row.used;
}
