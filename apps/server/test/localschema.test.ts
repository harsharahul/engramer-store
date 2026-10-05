import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderMigrations, renderSchema, SCHEMA_DIR } from "../scripts/export-sqlite-schema.js";

/**
 * The on-device backend embeds a copy of the server's SQLite schema. A
 * schema change here without a fresh export would let the two drift, so
 * the committed copy must always equal what the exporter writes.
 */
const committed = (name: string) => {
  const path = join(SCHEMA_DIR, name);
  return existsSync(path) ? readFileSync(path, "utf8") : "";
};
const hint = "run: pnpm --filter @engramer/server export:schema";

describe("the on-device backend's copy of the schema", () => {
  it("matches the server's tables and indexes", () => {
    expect(committed("sqlite-schema.sql"), hint).toBe(renderSchema());
  });

  it("matches the server's column migrations", () => {
    expect(committed("column-migrations.json"), hint).toBe(renderMigrations());
  });
});
