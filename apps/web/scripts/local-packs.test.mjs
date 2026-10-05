// @vitest-environment node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as tar from "tar";
import { describe, expect, it } from "vitest";
import { archiveName, buildLocal, DEFAULT_RELEASE_BASE, packsBaseUrl } from "./local-packs.mjs";

const SW = `self.m=[{"revision":"a1","url":"index.html"}];`;
const LONG = `office/web-apps/apps/documenteditor/main/resources/img/toolbar/${"x".repeat(60)}.svg`;
const SPACED = "office/fonts/Noto Sans Café.ttf";

function fixture(extra = {}, omitPrefix = null) {
  const dist = mkdtempSync(join(tmpdir(), "engram-packs-"));
  const files = {
    "index.html": "<!doctype html>",
    "sw.js": SW,
    "assets/index-abc.js": "a",
    "brand/ocean.png": "p",
    "office/sdkjs/word/sdk-all.js": "word editor",
    [LONG]: "long",
    [SPACED]: "font",
    "models/Xenova/clip/model.onnx": "model bytes",
    "ort/1.26.0/ort-wasm-simd-threaded.asyncify.wasm": "runtime",
    "assets/ort-wasm-simd-threaded-AAA.wasm": "bundled runtime",
    ...extra,
  };
  for (const [path, body] of Object.entries(files)) {
    if (omitPrefix && path.startsWith(omitPrefix)) continue;
    mkdirSync(dirname(join(dist, path)), { recursive: true });
    writeFileSync(join(dist, path), body);
  }
  return dist;
}

function outDir() {
  return mkdtempSync(join(tmpdir(), "engram-packs-out-"));
}

async function entries(file) {
  const names = [];
  await tar.t({ file, onReadEntry: (entry) => names.push(entry.path) });
  return names;
}

const sha = (text) => createHash("sha256").update(text).digest("hex");

describe("names and URLs", () => {
  it("names archives by pack and version", () => {
    expect(archiveName("office", "0.59.0")).toBe("engram-pack-office-0.59.0.tar.gz");
  });

  it("defaults the base URL to the version's GitHub release", () => {
    expect(packsBaseUrl("0.59.0", {})).toBe(`${DEFAULT_RELEASE_BASE}/v0.59.0/`);
  });

  it("takes ENGRAM_PACKS_BASE_URL and always ends it with a slash", () => {
    expect(packsBaseUrl("0.59.0", { ENGRAM_PACKS_BASE_URL: "https://packs.example.com/v1" })).toBe(
      "https://packs.example.com/v1/",
    );
  });
});

describe("buildLocal", () => {
  it("copies only core files into core/ and writes packs.json there", async () => {
    const out = outDir();
    await buildLocal({ dist: fixture(), out, version: "0.59.0", env: {} });
    expect(readFileSync(join(out, "core", "index.html"), "utf8")).toBe("<!doctype html>");
    expect(existsSync(join(out, "core", "assets", "index-abc.js"))).toBe(true);
    expect(existsSync(join(out, "core", "office"))).toBe(false);
    expect(existsSync(join(out, "core", "models"))).toBe(false);
    expect(existsSync(join(out, "core", "assets", "ort-wasm-simd-threaded-AAA.wasm"))).toBe(false);
    expect(existsSync(join(out, "core", "packs.json"))).toBe(true);
  });

  it("lists every pack file with its size and sha256", async () => {
    const out = outDir();
    const { manifest } = await buildLocal({ dist: fixture(), out, version: "0.59.0", env: {} });
    const written = JSON.parse(readFileSync(join(out, "core", "packs.json"), "utf8"));
    expect(written).toEqual(manifest);
    expect(manifest.schema).toBe(1);
    expect(manifest.version).toBe("0.59.0");
    expect(manifest.packs.office.files).toContainEqual({
      path: "office/sdkjs/word/sdk-all.js",
      bytes: 11,
      sha256: sha("word editor"),
    });
    expect(manifest.packs.intelligence.files.map((f) => f.path)).toEqual([
      "assets/ort-wasm-simd-threaded-AAA.wasm",
      "models/Xenova/clip/model.onnx",
      "ort/1.26.0/ort-wasm-simd-threaded.asyncify.wasm",
    ]);
    expect(manifest.packs.office.installedBytes).toBe(11 + 4 + 4);
  });

  it("writes archives holding exactly each pack's files, with matching size and hash", async () => {
    const out = outDir();
    const { manifest } = await buildLocal({ dist: fixture(), out, version: "0.59.0", env: {} });
    for (const [name, pack] of Object.entries(manifest.packs)) {
      const file = join(out, "packs", pack.archive);
      expect(await entries(file), name).toEqual(pack.files.map((f) => f.path));
      const bytes = readFileSync(file);
      expect(bytes.length).toBe(pack.archiveBytes);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(pack.archiveSha256);
    }
  });

  it("keeps paths longer than 100 characters", async () => {
    expect(LONG.length).toBeGreaterThan(100);
    const out = outDir();
    const { manifest } = await buildLocal({ dist: fixture(), out, version: "0.59.0", env: {} });
    expect(await entries(join(out, "packs", manifest.packs.office.archive))).toContain(LONG);
  });

  it("keeps paths with spaces and non-ASCII characters exact", async () => {
    const out = outDir();
    const { manifest } = await buildLocal({ dist: fixture(), out, version: "0.59.0", env: {} });
    expect(manifest.packs.office.files.map((f) => f.path)).toContain(SPACED);
    expect(await entries(join(out, "packs", manifest.packs.office.archive))).toContain(SPACED);
  });

  it("produces the same archive bytes from the same files", async () => {
    const dist = fixture();
    const a = await buildLocal({ dist, out: outDir(), version: "0.59.0", env: {} });
    const b = await buildLocal({ dist, out: outDir(), version: "0.59.0", env: {} });
    for (const name of ["office", "intelligence"]) {
      expect(b.manifest.packs[name].archiveSha256).toBe(a.manifest.packs[name].archiveSha256);
    }
  });

  it("removes the previous run's output", async () => {
    const out = outDir();
    mkdirSync(join(out, "packs"), { recursive: true });
    writeFileSync(join(out, "packs", "engram-pack-office-0.0.1.tar.gz"), "stale");
    mkdirSync(join(out, "core"), { recursive: true });
    writeFileSync(join(out, "core", "stale.js"), "stale");
    await buildLocal({ dist: fixture(), out, version: "0.59.0", env: {} });
    expect(existsSync(join(out, "packs", "engram-pack-office-0.0.1.tar.gz"))).toBe(false);
    expect(existsSync(join(out, "core", "stale.js"))).toBe(false);
  });

  it("fails on an empty pack, naming it", async () => {
    await expect(
      buildLocal({ dist: fixture({}, "office/"), out: outDir(), version: "0.59.0", env: {} }),
    ).rejects.toThrow(/the office pack is empty/);
  });

  it("fails on a partition problem before writing anything", async () => {
    const out = outDir();
    await expect(
      buildLocal({ dist: fixture({ "robots.txt": "x" }), out, version: "0.59.0", env: {} }),
    ).rejects.toThrow(/no pack rule matches robots\.txt/);
    expect(existsSync(join(out, "core"))).toBe(false);
  });
});
