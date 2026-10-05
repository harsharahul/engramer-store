// @vitest-environment node
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkDist, classify, listFiles, precachePaths } from "./partition.mjs";

const SW = `self.m=[{"revision":"a1","url":"index.html"},{"revision":null,"url":"assets/index-abc.js"}];`;

function fixture(extra = {}, omit = []) {
  const dist = mkdtempSync(join(tmpdir(), "engram-partition-"));
  const files = {
    "index.html": "<!doctype html>",
    "sw.js": SW,
    "registerSW.js": "r",
    "assets/index-abc.js": "a",
    "assets/ort-wasm-simd-threaded-AAA.wasm": "w",
    "brand/ocean.png": "p",
    "zxing/3.1.4/zxing_reader.wasm": "z",
    "office/sdkjs/word/sdk-all.js": "o",
    "office/sdkjs/word/sdk-all.js.br": "o",
    "models/Xenova/clip/model.onnx": "m",
    "ort/1.26.0/ort-wasm-simd-threaded.asyncify.wasm": "r",
    "gliner-ort/1.19.0/ort-wasm.mjs": "g",
    "ocr/eng.traineddata.gz": "t",
    ...extra,
  };
  for (const path of omit) delete files[path];
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dist, path)), { recursive: true });
    writeFileSync(join(dist, path), body);
  }
  return dist;
}

describe("classify", () => {
  it("puts the office tree in the office pack", () => {
    expect(classify("office/web-apps/apps/api/documents/api.js")).toBe("office");
  });

  it("puts models, runtimes, OCR and the bundled ONNX wasm in the intelligence pack", () => {
    for (const path of [
      "models/Xenova/clip/model.onnx",
      "ort/1.26.0/ort-wasm-simd-threaded.asyncify.wasm",
      "gliner-ort/1.19.0/ort-wasm.mjs",
      "ocr/eng.traineddata.gz",
      "assets/ort-wasm-simd-threaded-B92PF46Y.wasm",
    ]) {
      expect(classify(path), path).toBe("intelligence");
    }
  });

  it("keeps the app, its workers, brand art and the barcode reader in the core", () => {
    for (const path of [
      "index.html",
      "sw.js",
      "registerSW.js",
      "manifest.webmanifest",
      "version.json",
      "x2t-worker.js",
      "icon.svg",
      "assets/index-abc.js",
      "assets/semantic.worker-xyz.js",
      "brand/ocean.png",
      "zxing/3.1.4/zxing_reader.wasm",
    ]) {
      expect(classify(path), path).toBe("core");
    }
  });

  it("matches nothing for an unknown root file, directory or nested asset", () => {
    expect(classify("robots.txt")).toBeNull();
    expect(classify("fonts/a.woff2")).toBeNull();
    expect(classify("assets/nested/a.js")).toBeNull();
  });
});

describe("listFiles", () => {
  it("returns sorted relative paths with forward slashes and no directories", () => {
    const dist = fixture();
    const files = listFiles(dist);
    expect(files).toContain("office/sdkjs/word/sdk-all.js");
    expect(files).not.toContain("office");
    expect([...files].sort()).toEqual(files);
  });
});

describe("precachePaths", () => {
  it("reads the precache entries from a built worker", () => {
    expect(precachePaths(SW)).toEqual(["assets/index-abc.js", "index.html"]);
  });

  it("strips a leading slash", () => {
    expect(precachePaths(`[{"revision":"a","url":"/index.html"}]`)).toEqual(["index.html"]);
  });
});

describe("checkDist", () => {
  it("groups every file with its size", () => {
    const groups = checkDist(fixture());
    expect(groups.office.map((f) => f.path)).toEqual([
      "office/sdkjs/word/sdk-all.js",
      "office/sdkjs/word/sdk-all.js.br",
    ]);
    expect(groups.intelligence).toHaveLength(5);
    expect(groups.core.find((f) => f.path === "index.html").bytes).toBe(15);
  });

  it("fails on a file no rule matches, naming it", () => {
    expect(() => checkDist(fixture({ "robots.txt": "x" }))).toThrow(/no pack rule matches robots\.txt/);
  });

  it("fails when the service worker precaches a pack file", () => {
    const sw = `[{"revision":"a","url":"office/sdkjs/word/sdk-all.js"}]`;
    expect(() => checkDist(fixture({ "sw.js": sw }))).toThrow(
      /precaches office\/sdkjs\/word\/sdk-all\.js, which is in the office pack/,
    );
  });

  it("fails when the service worker's precache list cannot be read", () => {
    const sw = `self.m=[{url:"index.html",revision:"a1"}];`;
    expect(() => checkDist(fixture({ "sw.js": sw }))).toThrow(/could not read the precache list/);
  });

  it("skips the precache rule when there is no service worker", () => {
    expect(() => checkDist(fixture({}, ["sw.js"]))).not.toThrow();
  });

  it("fails when the core is over budget", () => {
    expect(() => checkDist(fixture(), { coreBudgetBytes: 10 })).toThrow(/over the 10-byte budget/);
  });

  it("reports every problem at once", () => {
    let message = "";
    try {
      checkDist(fixture({ "robots.txt": "x", "fonts/a.woff2": "f" }));
    } catch (err) {
      message = err.message;
    }
    expect(message).toMatch(/^partition: 2 problem\(s\)/);
    expect(message).toMatch(/robots\.txt/);
    expect(message).toMatch(/fonts\/a\.woff2/);
  });
});

describe("the command line", () => {
  const script = fileURLToPath(new URL("./partition.mjs", import.meta.url));

  it("prints one line per group and exits 0 on a clean dist", () => {
    const run = spawnSync(process.execPath, [script, "--check", fixture()], { encoding: "utf8" });
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/partition: core: \d+ files/);
    expect(run.stdout).toMatch(/partition: office: 2 files/);
    expect(run.stdout).toMatch(/partition: intelligence: 5 files/);
  });

  it("exits 1 with the problem list on an unclassified file", () => {
    const run = spawnSync(process.execPath, [script, "--check", fixture({ "robots.txt": "x" })], {
      encoding: "utf8",
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/robots\.txt/);
  });

  it("exits 2 with usage when the directory is missing", () => {
    const run = spawnSync(process.execPath, [script, "--check"], { encoding: "utf8" });
    expect(run.status).toBe(2);
    expect(run.stderr).toMatch(/usage/);
  });

  it("exits 1 when the directory does not exist", () => {
    const missing = join(tmpdir(), "engram-partition-missing");
    rmSync(missing, { recursive: true, force: true });
    const run = spawnSync(process.execPath, [script, "--check", missing], { encoding: "utf8" });
    expect(run.status).toBe(1);
  });
});
