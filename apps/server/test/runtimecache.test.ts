import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";

/**
 * The ML runtimes (onnx wasm, tesseract cores, barcode reader) are tens of
 * megabytes of same-origin static assets living under versioned paths.
 * Served with the static handler's default max-age=0, Safari refuses to
 * retain entries that large at all, so every upload session re-downloads
 * and re-compiles them; on a WAN deployment that wait lands inside the
 * upload experience. Versioned paths make them immutable by construction,
 * and the header must say so. App-shell assets keep the default policy.
 */
describe("runtime asset caching", () => {
  let app: FastifyInstance;
  let dataDir: string;
  let webDist: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "engramer-runtime-"));
    webDist = mkdtempSync(join(tmpdir(), "engramer-dist-"));
    mkdirSync(join(webDist, "ort", "1.2.3"), { recursive: true });
    writeFileSync(join(webDist, "ort", "1.2.3", "runtime.wasm"), "wasm-bytes");
    mkdirSync(join(webDist, "ocr"), { recursive: true });
    writeFileSync(join(webDist, "ocr", "eng.traineddata.gz"), "lang-bytes");
    mkdirSync(join(webDist, "assets"), { recursive: true });
    writeFileSync(join(webDist, "assets", "index-abc.js"), "app-bytes");
    writeFileSync(join(webDist, "index.html"), "<html></html>");
    app = await buildApp({ dataDir, webDistDir: webDist });
  });

  afterAll(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(webDist, { recursive: true, force: true });
  });

  it("marks versioned runtime assets immutable for a year", async () => {
    const response = await app.inject({ method: "GET", url: "/ort/1.2.3/runtime.wasm" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
  });

  it("marks the stable language data immutable too", async () => {
    const response = await app.inject({ method: "GET", url: "/ocr/eng.traineddata.gz" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
  });

  it("leaves app-shell assets on the default policy", async () => {
    const response = await app.inject({ method: "GET", url: "/assets/index-abc.js" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).not.toContain("immutable");
  });
});
