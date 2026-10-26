import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ready } from "@engramer/crypto";
import { buildApp } from "../src/app.js";

/**
 * With request logging on, the liveness and readiness probes arrive
 * twice every few seconds per instance and would be most of the log,
 * pushing the lines that matter out of the container's retention within
 * hours. They stay silent; every other request is logged as before.
 */
describe("request log", () => {
  let dataDir: string;
  const lines: string[] = [];

  beforeAll(async () => {
    await ready();
    dataDir = mkdtempSync(join(tmpdir(), "engramer-requestlog-test-"));
  });

  afterAll(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("logs requests but never the health and readiness probes", async () => {
    const app = await buildApp({
      dataDir,
      webDistDir: null,
      events: false,
      requestLog: { stream: { write: (message: string) => void lines.push(message) } },
    });
    try {
      expect((await app.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/api/ready" })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/api/sync" })).statusCode).toBe(401);
    } finally {
      await app.close();
    }
    const urls = lines
      .map((line) => {
        try {
          return (JSON.parse(line) as { req?: { url?: string } }).req?.url ?? null;
        } catch {
          return null;
        }
      })
      .filter((url): url is string => url !== null);
    expect(urls).toContain("/api/sync");
    expect(urls).not.toContain("/api/health");
    expect(urls).not.toContain("/api/ready");
    // The probe answers leave no response line either: every logged
    // response belongs to a logged request.
    const responses = lines.filter((line) => /"res":/.test(line)).length;
    expect(responses).toBe(urls.length);
  });
});
