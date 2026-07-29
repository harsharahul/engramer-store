import pg from "pg";
import {
  COLUMN_MIGRATIONS,
  COMMON_SCHEMA,
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
export class PostgresDb implements Db {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({
      connectionString,
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
  }

  /** Creates the schema and applies the shared additive migrations. */
  async migrate(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS users (
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
        );
        ${COMMON_SCHEMA}
      `);
      for (const migration of COLUMN_MIGRATIONS) {
        await client.query(
          `ALTER TABLE ${migration.table} ADD COLUMN IF NOT EXISTS ${migration.column} ${migration.type}`,
        );
      }
    } finally {
      client.release();
    }
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
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(new PgClientDb(client));
      await client.query("COMMIT");
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
  constructor(private readonly client: pg.PoolClient) {}

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
