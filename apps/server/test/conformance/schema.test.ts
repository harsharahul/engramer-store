import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDatabase } from "../../src/db.js";
import { startTarget, type Target } from "../helpers/target.js";

/**
 * A vault and a server data directory must hold the same database: the
 * same tables, columns, types, defaults and indexes, in the same order.
 */
let target: Target;

beforeAll(async () => {
  target = await startTarget();
});

afterAll(async () => {
  // Undefined when the start failed; that error is the one to read.
  await target?.close();
});

function shape(path: string) {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const objects = db
      .prepare(
        "SELECT type, name, tbl_name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
      )
      .all() as Array<{ type: string; name: string; tbl_name: string }>;
    const columns: Record<string, unknown[]> = {};
    for (const object of objects.filter((o) => o.type === "table")) {
      columns[object.name] = db.prepare(`PRAGMA table_info(${object.name})`).all();
    }
    return { objects, columns };
  } finally {
    db.close();
  }
}

describe("the vault database", () => {
  it("has exactly the server's tables, columns and indexes", async () => {
    // A request first, so the target has certainly opened its database.
    await target.inject({ method: "GET", url: "/api/health" });
    const reference = mkdtempSync(join(tmpdir(), "engram-schema-reference-"));
    try {
      const path = join(reference, "engramer.db");
      await openDatabase(path).close();
      expect(shape(join(target.dataDir, "engramer.db"))).toEqual(shape(path));
    } finally {
      rmSync(reference, { recursive: true, force: true });
    }
  });
});
