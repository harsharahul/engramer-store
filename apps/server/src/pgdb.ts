import { randomUUID } from "node:crypto";
import pg from "pg";
import {
  COLUMN_MIGRATIONS,
  COMMON_SCHEMA,
  HeldSeqs,
  type Db,
  type DbRunResult,
} from "./db.js";

/**
 * PostgreSQL backend for replicated deployments: N server pods share one
 * database (for example a CloudNativePG cluster) and one object store, and
 * every correctness mechanism carries over unchanged because it was designed
 * on single-row atomics: the per-user update_seq is a single-row
 * UPDATE...RETURNING that PostgreSQL serializes with a row lock, and the
 * versioning generation re-check runs inside a real transaction here.
 *
 * SQL is written once in SQLite placeholder style; this backend translates
 * `?` to `$n`. Timestamps and sizes are BIGINT (int8) and sums are numeric,
 * both of which node-postgres returns as strings by default, so the pool
 * parses them to numbers; every value we store this way is far below 2^53.
 */
/**
 * The per-user bump, with the notification that carries the poke to the
 * other instances inside the same statement: PostgreSQL delivers it when
 * the surrounding transaction commits and drops it on rollback, the exact
 * guarantee HeldSeqs gives the local observer. The payload names the
 * account, the new sequence and the instance that made the change, so
 * the receiver can skip its own.
 */
const ALLOCATE_SEQ_SQL = `UPDATE users SET last_seq = last_seq + 1 WHERE id = $1
  RETURNING last_seq, pg_notify('engram_seq', id::text || ':' || last_seq::text || ':' || $2::text)`;

/** Serializes schema migrations across instances starting at once. */
const MIGRATE_LOCK_KEY = 7_231_001;
const MIGRATE_ATTEMPTS = 5;

/** The one table whose spelling differs between the dialects. */
const USERS_TABLE = `CREATE TABLE IF NOT EXISTS users (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  login_key_digest TEXT NOT NULL,
  key_attributes TEXT NOT NULL,
  last_seq BIGINT NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL,
  totp_secret TEXT,
  totp_enabled BIGINT NOT NULL DEFAULT 0,
  totp_last_step BIGINT NOT NULL DEFAULT 0,
  recovery_code_digests TEXT
)`;

export class PostgresDb implements Db {
  onSeq?: (userId: number, seq: number) => void;
  private readonly pool: pg.Pool;
  /** This instance's id, named in every notification it sends. */
  private readonly origin: string;

  constructor(connectionString: string, options: { origin?: string } = {}) {
    this.origin = options.origin ?? randomUUID();
    this.pool = new pg.Pool({
      connectionString,
      max: 10,
      // A request must not wait forever for a connection while the
      // database fails over; five seconds is longer than any switchover
      // the operator performs, short enough to surface as an error.
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
      keepAlive: true,
      types: {
        getTypeParser: (oid: number, format?: string) => {
          if (oid === 20 || oid === 1700) {
            return (value: string) => Number(value);
          }
          return pg.types.getTypeParser(
            oid as Parameters<typeof pg.types.getTypeParser>[0],
            format as never,
          );
        },
      } as unknown as pg.CustomTypesConfig,
    });
    // An idle connection dropped by a failover or a restart raises an error
    // on the pool; without a listener Node treats it as uncaught and the
    // whole process dies with it. The next checkout simply opens a new one.
    this.pool.on("error", (err) => {
      console.warn(`postgres: idle connection error, reconnecting on next use: ${err.message}`);
    });
  }

  /**
   * Creates the schema and applies the shared additive migrations.
   *
   * Instances start together during a rollout, so the whole run holds an
   * advisory lock inside one transaction (DDL is transactional here) and
   * the second instance simply finds everything present. Only columns
   * that are actually missing are added: ALTER TABLE takes its exclusive
   * lock before it checks IF NOT EXISTS, and taking that lock on a busy
   * table at every boot would queue live traffic behind it. When a long
   * transaction does hold a table, the lock wait times out and the run
   * is retried, so a boot never stalls behind someone's upload.
   */
  async migrate(): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL lock_timeout = '3s'");
        await client.query("SELECT pg_advisory_xact_lock($1)", [MIGRATE_LOCK_KEY]);
        // What exists already, read once: IF NOT EXISTS is not free here,
        // CREATE INDEX and ALTER TABLE lock the table before they look.
        const tables = new Set(
          (
            await client.query<{ table_name: string }>(
              "SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema()",
            )
          ).rows.map((row) => row.table_name),
        );
        const indexes = new Set(
          (
            await client.query<{ indexname: string }>(
              "SELECT indexname FROM pg_indexes WHERE schemaname = current_schema()",
            )
          ).rows.map((row) => row.indexname),
        );
        const columns = new Set(
          (
            await client.query<{ table_name: string; column_name: string }>(
              "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = current_schema()",
            )
          ).rows.map((row) => `${row.table_name}.${row.column_name}`),
        );
        for (const statement of [USERS_TABLE, ...COMMON_SCHEMA.split(";")]) {
          const ddl = statement.trim();
          if (!ddl) {
            continue;
          }
          const table = /^CREATE TABLE IF NOT EXISTS (\w+)/i.exec(ddl)?.[1];
          if (table && tables.has(table)) {
            continue;
          }
          const index = /^CREATE INDEX IF NOT EXISTS (\w+)/i.exec(ddl)?.[1];
          if (index && indexes.has(index)) {
            continue;
          }
          await client.query(ddl);
        }
        for (const migration of COLUMN_MIGRATIONS) {
          if (columns.has(`${migration.table}.${migration.column}`)) {
            continue;
          }
          await client.query(
            `ALTER TABLE ${migration.table} ADD COLUMN IF NOT EXISTS ${migration.column} ${migration.type}`,
          );
        }
        await client.query("COMMIT");
        return;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        // 55P03: lock_not_available, the lock_timeout above firing.
        if ((err as { code?: string }).code === "55P03" && attempt < MIGRATE_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
          continue;
        }
        throw err;
      } finally {
        client.release();
      }
    }
  }

  async allocateSeq(userId: number): Promise<number> {
    const result = await this.pool.query<{ last_seq: number }>(ALLOCATE_SEQ_SQL, [userId, this.origin]);
    return Number(result.rows[0]!.last_seq);
  }

  async get<T = unknown>(sql: string, ...params: unknown[]): Promise<T | undefined> {
    const result = await this.pool.query(translate(sql), params);
    return result.rows[0] as T | undefined;
  }

  async all<T = unknown>(sql: string, ...params: unknown[]): Promise<T[]> {
    const result = await this.pool.query(translate(sql), params);
    return result.rows as T[];
  }

  async run(sql: string, ...params: unknown[]): Promise<DbRunResult> {
    const result = await this.pool.query(translate(sql), params);
    return { changes: result.rowCount ?? 0 };
  }

  async tx<T>(fn: (t: Db) => Promise<T>): Promise<T> {
    try {
      return await this.runTx(fn);
    } catch (err) {
      // Two writers that lock the same user rows in different orders
      // deadlock, and PostgreSQL aborts one of them (40P01). The callback
      // only touched the database, and the rollback undid all of it, so
      // running it once more is the right answer, not a 500.
      if ((err as { code?: string }).code === "40P01") {
        return await this.runTx(fn);
      }
      throw err;
    }
  }

  private async runTx<T>(fn: (t: Db) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Bumps made inside the transaction are announced only once it
      // has committed; a pull triggered by an earlier announcement
      // would read the old state and never hear about the row again.
      const held = new HeldSeqs();
      const handle = new PgClientDb(client, this.origin);
      handle.onSeq = (userId, seq) => held.note(userId, seq);
      const result = await fn(handle);
      await client.query("COMMIT");
      held.release(this.onSeq);
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/** The transaction handle: same facade, pinned to one client connection. */
class PgClientDb implements Db {
  onSeq?: (userId: number, seq: number) => void;

  constructor(
    private readonly client: pg.PoolClient,
    private readonly origin: string,
  ) {}

  async allocateSeq(userId: number): Promise<number> {
    const result = await this.client.query<{ last_seq: number }>(ALLOCATE_SEQ_SQL, [userId, this.origin]);
    return Number(result.rows[0]!.last_seq);
  }

  async get<T = unknown>(sql: string, ...params: unknown[]): Promise<T | undefined> {
    const result = await this.client.query(translate(sql), params);
    return result.rows[0] as T | undefined;
  }

  async all<T = unknown>(sql: string, ...params: unknown[]): Promise<T[]> {
    const result = await this.client.query(translate(sql), params);
    return result.rows as T[];
  }

  async run(sql: string, ...params: unknown[]): Promise<DbRunResult> {
    const result = await this.client.query(translate(sql), params);
    return { changes: result.rowCount ?? 0 };
  }

  async tx<T>(fn: (t: Db) => Promise<T>): Promise<T> {
    // Already inside a transaction; nested calls just join it.
    return fn(this);
  }

  async close(): Promise<void> {
    // The owning pool manages the connection.
  }
}

/** `?` placeholders become `$1..$n`. Our SQL never contains a literal `?`. */
function translate(sql: string): string {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}
