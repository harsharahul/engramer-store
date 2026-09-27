import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

/**
 * Settings that only work with one process are refused once the metadata
 * lives in PostgreSQL, because that is the deployment shape with more
 * than one pod. A per-pod JWT file gives every pod its own signing key
 * (a token from one pod is a 401 on the next), and a derived split on
 * local disk makes one pod's disk the only copy of its thumbnails.
 */
describe("replicated-deployment refusals", () => {
  const ENV = ["ENGRAMER_JWT_SECRET", "ENGRAMER_DERIVED_BACKEND", "ENGRAMER_DERIVED_DIR"];
  const saved = new Map<string, string | undefined>();
  let dataDir: string;

  beforeEach(() => {
    for (const name of ENV) {
      saved.set(name, process.env[name]);
      delete process.env[name];
    }
    dataDir = mkdtempSync(join(tmpdir(), "engramer-config-"));
  });

  afterEach(() => {
    for (const name of ENV) {
      const value = saved.get(name);
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("keeps the per-directory secret file for the embedded database", () => {
    const config = loadConfig({ dataDir, databaseUrl: null });
    expect(config.jwtSecret.length).toBeGreaterThan(20);
  });

  it("refuses PostgreSQL without a shared JWT secret", () => {
    expect(() => loadConfig({ dataDir, databaseUrl: "postgres://db.example/engram" })).toThrow(
      /ENGRAMER_JWT_SECRET/,
    );
  });

  it("accepts PostgreSQL with the secret from the environment or an override", () => {
    process.env.ENGRAMER_JWT_SECRET = "shared-by-every-pod";
    expect(loadConfig({ dataDir, databaseUrl: "postgres://db.example/engram" }).jwtSecret).toBe(
      "shared-by-every-pod",
    );
    delete process.env.ENGRAMER_JWT_SECRET;
    expect(
      loadConfig({ dataDir, databaseUrl: "postgres://db.example/engram", jwtSecret: "from-a-test" })
        .jwtSecret,
    ).toBe("from-a-test");
  });

  it("refuses a local-disk derived split on PostgreSQL", () => {
    process.env.ENGRAMER_DERIVED_BACKEND = "fs";
    expect(() =>
      loadConfig({ dataDir, databaseUrl: "postgres://db.example/engram", jwtSecret: "shared" }),
    ).toThrow(/ENGRAMER_DERIVED_BACKEND/);
    // The same split is fine with the embedded database: one process, one disk.
    expect(loadConfig({ dataDir, databaseUrl: null }).derivedFsDir).toBe(join(dataDir, "derived"));
  });
});
