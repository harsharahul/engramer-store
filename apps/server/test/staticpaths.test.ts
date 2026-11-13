import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { get } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp, plainPath } from "../src/app.js";

/**
 * The office editor's own font list starts every name with a slash, so it
 * asks for its fonts at /office/fonts//fonts/<name>. A reverse proxy that
 * merges slashes hides this; a server reached directly does not. The path
 * names one file whichever way it is written, so it is read as the
 * on-device backend reads it: empty segments are dropped before anything
 * looks at the path. A path that climbs is still refused, and the API is
 * left as written.
 */
describe("static paths with an empty segment", () => {
  let app: FastifyInstance;
  let dataDir: string;
  let webDist: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "engramer-paths-"));
    webDist = mkdtempSync(join(tmpdir(), "engramer-dist-"));
    mkdirSync(join(webDist, "office", "fonts", "fonts"), { recursive: true });
    writeFileSync(join(webDist, "office", "fonts", "fonts", "demo.ttf"), "font-bytes");
    mkdirSync(join(webDist, "office", "sdkjs"), { recursive: true });
    writeFileSync(join(webDist, "office", "sdkjs", "sdk.js"), "plain-bytes");
    writeFileSync(join(webDist, "office", "sdkjs", "sdk.js.br"), "brotli-bytes");
    mkdirSync(join(webDist, "assets"), { recursive: true });
    writeFileSync(join(webDist, "assets", "index-abc.js"), "app-bytes");
    writeFileSync(join(webDist, "index.html"), "<html>the app</html>");
    app = await buildApp({ dataDir, webDistDir: webDist });
  });

  afterAll(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(webDist, { recursive: true, force: true });
  });

  it("serves the font the editor asks for with a doubled slash", async () => {
    const response = await app.inject({ method: "GET", url: "/office/fonts//fonts/demo.ttf" });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("font-bytes");
  });

  it("serves any static file whose path holds an empty segment, query kept", async () => {
    const response = await app.inject({ method: "GET", url: "/assets//index-abc.js?v=1" });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("app-bytes");
  });

  it("the compressed copy of an office file is found through such a path too", async () => {
    const response = await app.inject({ method: "GET", url: "/office//sdkjs/sdk.js", headers: { "accept-encoding": "br" } });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-encoding"]).toBe("br");
    expect(response.body).toBe("brotli-bytes");
  });

  it("a doubled slash in front of the office prefix is the office prefix: a missing file there is not the app's page", async () => {
    const response = await app.inject({ method: "GET", url: "//office/nothing-here.js" });
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain("the app");
  });

  it("still refuses a path that climbs, with or without an empty segment", async () => {
    // Over a real socket, so the dots reach the server as a client wrote
    // them: a URL parser would resolve them first.
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const port = Number(new URL(address).port);
    const status = (path: string) =>
      new Promise<number>((resolve, reject) => {
        get({ host: "127.0.0.1", port, path }, (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        }).on("error", reject);
      });
    expect(await status("/office/fonts//fonts/demo.ttf")).toBe(200);
    for (const path of ["/office/fonts/../../index.html", "/office/fonts//../fonts/demo.ttf", "/assets//../index.html", "/assets//./index-abc.js"]) {
      expect({ path, status: await status(path) }).toEqual({ path, status: 403 });
    }
  });

  it("gives the API no second spelling", async () => {
    expect((await app.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(200);
    for (const url of ["/api//health", "//api/health", "//api//health"]) {
      const response = await app.inject({ method: "GET", url });
      expect({ url, answered: response.statusCode === 200 }).toEqual({ url, answered: false });
    }
  });

  it("puts a path in its plain form and leaves the rest as written", () => {
    expect(plainPath("/office/fonts//fonts/a.ttf")).toBe("/office/fonts/fonts/a.ttf");
    expect(plainPath("///assets///x.js?next=//later")).toBe("/assets/x.js?next=//later");
    expect(plainPath("/assets/x.js?next=//later")).toBe("/assets/x.js?next=//later");
    expect(plainPath("/api//files")).toBe("/api//files");
    expect(plainPath("//api/files")).toBe("//api/files");
    expect(plainPath("/")).toBe("/");
  });
});
