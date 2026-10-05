//! The vault database: the server's SQLite schema, opened and migrated the
//! way the Node server opens it, so a vault and a server account have the
//! same shape.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::{Mutex, MutexGuard};

use rusqlite::{params, Connection, Transaction};
use serde::Deserialize;

/// The server's tables and indexes, exported from apps/server/src/db.ts.
pub const SCHEMA: &str = include_str!("../schema/sqlite-schema.sql");
const MIGRATIONS: &str = include_str!("../schema/column-migrations.json");

/// The database file name the Node server uses inside its data directory.
pub const DB_FILE: &str = "engramer.db";

/// One additive column, applied when an older database lacks it.
#[derive(Debug, Deserialize)]
pub struct ColumnMigration {
    pub table: String,
    pub column: String,
    #[serde(rename = "type")]
    pub kind: String,
}

/// The server's additive column migrations, in the server's order.
pub fn column_migrations() -> Vec<ColumnMigration> {
    serde_json::from_str(MIGRATIONS).expect("column-migrations.json is valid")
}

/// The table names the schema creates, in order.
pub fn schema_tables() -> Vec<String> {
    SCHEMA
        .split("CREATE TABLE IF NOT EXISTS ")
        .skip(1)
        .filter_map(|rest| rest.split_whitespace().next())
        .map(|name| name.trim_end_matches('(').to_string())
        .collect()
}

/// One SQLite connection behind a lock: an on-device vault has one writer.
pub struct Store {
    conn: Mutex<Connection>,
}

impl Store {
    /// Opens (or creates) the vault at `path`: WAL journal, foreign keys
    /// on, every table and index, then the column migrations.
    pub fn open(path: &Path) -> rusqlite::Result<Store> {
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.execute_batch(SCHEMA)?;
        apply_migrations(&conn)?;
        Ok(Store {
            conn: Mutex::new(conn),
        })
    }

    /// The connection, for statements outside a transaction.
    pub fn conn(&self) -> MutexGuard<'_, Connection> {
        self.conn
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Runs `f` in one transaction: committed when it returns Ok, rolled
    /// back when it returns Err.
    pub fn tx<T, E>(&self, f: impl FnOnce(&Transaction<'_>) -> Result<T, E>) -> Result<T, E>
    where
        E: From<rusqlite::Error>,
    {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let out = f(&tx)?;
        tx.commit()?;
        Ok(out)
    }
}

fn apply_migrations(conn: &Connection) -> rusqlite::Result<()> {
    let mut known: HashMap<String, HashSet<String>> = HashMap::new();
    for migration in column_migrations() {
        if !known.contains_key(&migration.table) {
            let columns = table_columns(conn, &migration.table)?;
            known.insert(migration.table.clone(), columns);
        }
        let columns = known.get_mut(&migration.table).expect("inserted above");
        if !columns.contains(&migration.column) {
            conn.execute_batch(&format!(
                "ALTER TABLE {} ADD COLUMN {} {}",
                migration.table, migration.column, migration.kind
            ))?;
            columns.insert(migration.column.clone());
        }
    }
    Ok(())
}

/// The column names of `table`.
pub fn table_columns(conn: &Connection, table: &str) -> rusqlite::Result<HashSet<String>> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let names = stmt
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<rusqlite::Result<HashSet<String>>>()?;
    Ok(names)
}

/// The next position in the user's change sequence. The single-row UPDATE
/// serializes writers per user, as on the server.
pub fn next_seq(conn: &Connection, user_id: i64) -> rusqlite::Result<i64> {
    conn.query_row(
        "UPDATE users SET last_seq = last_seq + 1 WHERE id = ?1 RETURNING last_seq",
        params![user_id],
        |row| row.get(0),
    )
}

/// Milliseconds since the Unix epoch, the server's timestamp unit.
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Bytes the account holds, as the server counts them: live files with
/// their thumbnails and indexes, unconsumed file-request uploads, and
/// stored versions.
pub fn storage_used(conn: &Connection, user_id: i64) -> rusqlite::Result<i64> {
    let sum = |sql: &str| conn.query_row(sql, params![user_id], |row| row.get::<_, i64>(0));
    Ok(sum("SELECT COALESCE(SUM(size + thumb_size + index_size), 0) FROM files WHERE user_id = ?1 AND deleted = 0")?
        + sum("SELECT COALESCE(SUM(size + thumb_size + index_size), 0) FROM request_uploads WHERE user_id = ?1 AND consumed = 0")?
        + sum("SELECT COALESCE(SUM(size), 0) FROM file_versions WHERE user_id = ?1")?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// A vault path whose directory is removed when the test ends.
    struct TempVault(PathBuf);

    impl std::ops::Deref for TempVault {
        type Target = Path;
        fn deref(&self) -> &Path {
            &self.0
        }
    }

    impl AsRef<Path> for TempVault {
        fn as_ref(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempVault {
        fn drop(&mut self) {
            if let Some(dir) = self.0.parent() {
                let _ = std::fs::remove_dir_all(dir);
            }
        }
    }

    /// A fresh vault path per call. The counter keeps parallel tests apart
    /// when the clock (microseconds on macOS) gives two of them one value.
    fn temp_db() -> TempVault {
        static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "engram-local-store-{}-{n}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        TempVault(dir.join(DB_FILE))
    }

    fn add_user(conn: &Connection, email: &str) -> i64 {
        conn.query_row(
            "INSERT INTO users (email, login_key_digest, key_attributes, created_at) VALUES (?1, 'd', '{}', 0) RETURNING id",
            params![email],
            |row| row.get(0),
        )
        .unwrap()
    }

    #[test]
    fn the_schema_names_the_server_tables() {
        let tables = schema_tables();
        assert_eq!(tables.first().map(String::as_str), Some("users"));
        for name in [
            "folders",
            "files",
            "file_versions",
            "session_keys",
            "auth_throttle",
            "pods",
        ] {
            assert!(tables.iter().any(|t| t == name), "missing {name}");
        }
    }

    #[test]
    fn open_creates_every_table() {
        let vault = temp_db();
        let store = Store::open(&vault).unwrap();
        let conn = store.conn();
        for table in schema_tables() {
            let found: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                    params![table],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(found, 1, "table {table}");
        }
    }

    #[test]
    fn every_migration_column_exists() {
        let vault = temp_db();
        let store = Store::open(&vault).unwrap();
        let conn = store.conn();
        let migrations = column_migrations();
        assert!(!migrations.is_empty());
        for m in migrations {
            assert!(
                table_columns(&conn, &m.table).unwrap().contains(&m.column),
                "{}.{}",
                m.table,
                m.column
            );
        }
    }

    #[test]
    fn opening_an_older_vault_adds_the_missing_columns_and_keeps_its_rows() {
        let path = temp_db();
        {
            // A vault from before any column migration: the base users table only.
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE users (
                   id INTEGER PRIMARY KEY,
                   email TEXT NOT NULL UNIQUE,
                   login_key_digest TEXT NOT NULL,
                   key_attributes TEXT NOT NULL,
                   last_seq BIGINT NOT NULL DEFAULT 0,
                   created_at BIGINT NOT NULL
                 );
                 INSERT INTO users (email, login_key_digest, key_attributes, last_seq, created_at)
                   VALUES ('old@example.com', 'd', '{}', 7, 1);",
            )
            .unwrap();
        }
        let store = Store::open(&path).unwrap();
        let conn = store.conn();
        let columns = table_columns(&conn, "users").unwrap();
        for m in column_migrations().iter().filter(|m| m.table == "users") {
            assert!(columns.contains(&m.column), "users.{}", m.column);
        }
        let row: (String, i64, i64, i64) = conn
            .query_row(
                "SELECT email, last_seq, token_epoch, disabled FROM users",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert_eq!(row, ("old@example.com".to_string(), 7, 0, 0));
    }

    #[test]
    fn reopening_an_existing_vault_is_harmless() {
        let path = temp_db();
        {
            let store = Store::open(&path).unwrap();
            add_user(&store.conn(), "a@example.com");
        }
        let store = Store::open(&path).unwrap();
        let users: i64 = store
            .conn()
            .query_row("SELECT COUNT(*) FROM users", [], |row| row.get(0))
            .unwrap();
        assert_eq!(users, 1);
    }

    #[test]
    fn wal_and_foreign_keys_are_on() {
        let vault = temp_db();
        let store = Store::open(&vault).unwrap();
        let conn = store.conn();
        let mode: String = conn
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))
            .unwrap();
        assert_eq!(mode.to_lowercase(), "wal");
        let fk: i64 = conn
            .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
            .unwrap();
        assert_eq!(fk, 1);
    }

    #[test]
    fn next_seq_counts_from_one_per_user() {
        let vault = temp_db();
        let store = Store::open(&vault).unwrap();
        let conn = store.conn();
        let a = add_user(&conn, "a@example.com");
        let b = add_user(&conn, "b@example.com");
        assert_eq!(next_seq(&conn, a).unwrap(), 1);
        assert_eq!(next_seq(&conn, a).unwrap(), 2);
        assert_eq!(next_seq(&conn, b).unwrap(), 1);
    }

    #[test]
    fn a_failed_transaction_leaves_nothing_behind() {
        let vault = temp_db();
        let store = Store::open(&vault).unwrap();
        let user = add_user(&store.conn(), "a@example.com");
        let result: Result<(), rusqlite::Error> = store.tx(|tx| {
            next_seq(tx, user)?;
            Err(rusqlite::Error::QueryReturnedNoRows)
        });
        assert!(result.is_err());
        let seq: i64 = store
            .conn()
            .query_row(
                "SELECT last_seq FROM users WHERE id = ?1",
                params![user],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(seq, 0);
    }
}
