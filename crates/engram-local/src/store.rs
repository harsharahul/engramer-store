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

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// A fresh vault path per call. The counter keeps parallel tests apart
    /// when the clock (microseconds on macOS) gives two of them one value.
    fn temp_db() -> PathBuf {
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
        dir.join(DB_FILE)
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
        let store = Store::open(&temp_db()).unwrap();
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
        let store = Store::open(&temp_db()).unwrap();
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
        let store = Store::open(&temp_db()).unwrap();
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
        let store = Store::open(&temp_db()).unwrap();
        let conn = store.conn();
        let a = add_user(&conn, "a@example.com");
        let b = add_user(&conn, "b@example.com");
        assert_eq!(next_seq(&conn, a).unwrap(), 1);
        assert_eq!(next_seq(&conn, a).unwrap(), 2);
        assert_eq!(next_seq(&conn, b).unwrap(), 1);
    }

    #[test]
    fn a_failed_transaction_leaves_nothing_behind() {
        let store = Store::open(&temp_db()).unwrap();
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
