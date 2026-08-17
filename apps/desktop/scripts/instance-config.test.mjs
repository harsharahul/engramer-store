import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "instance-config.mjs");

/** Runs the script into a temp dir and returns its outputs, or the failure. */
function run(env) {
  const out = mkdtempSync(join(tmpdir(), "instance-config-test-"));
  try {
    execFileSync(process.execPath, [script], {
      env: { ...process.env, ENGRAM_APP_URL: "", ENGRAM_GENERIC: "", ENGRAM_INSTANCE_DIR: out, ...env },
      stdio: "pipe",
    });
    return {
      ok: true,
      instance: JSON.parse(readFileSync(join(out, "tauri.instance.json"), "utf8")),
      capability: JSON.parse(readFileSync(join(out, "capabilities", "instance.json"), "utf8")),
    };
  } catch (err) {
    return { ok: false, stderr: String(err.stderr) };
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

test("a baked build points everything at the deployment origin", () => {
  const r = run({ ENGRAM_APP_URL: "https://vault.example.com/some/path/" });
  assert.equal(r.ok, true);
  assert.equal(r.instance.build.frontendDist, "https://vault.example.com");
  assert.equal(r.instance.app.windows[0].url, "https://vault.example.com");
  assert.deepEqual(r.capability.remote.urls, ["https://vault.example.com", "https://**"]);
});

test("no environment falls back to the committed localhost, for the dev flow", () => {
  const r = run({});
  assert.equal(r.ok, true);
  assert.equal(r.instance.build.frontendDist, "http://localhost:3080");
  assert.deepEqual(r.capability.remote.urls, ["http://localhost:3080", "https://**"]);
});

test("a generic build bakes the local picker and no origin at all", () => {
  const r = run({ ENGRAM_GENERIC: "1" });
  assert.equal(r.ok, true);
  assert.equal(r.instance.build.frontendDist, "../picker");
  assert.equal(r.instance.app.windows[0].url, "index.html");
  assert.deepEqual(r.capability.remote.urls, ["https://**"]);
});

test("generic plus a baked URL is a refusal, not a guess", () => {
  const r = run({ ENGRAM_GENERIC: "1", ENGRAM_APP_URL: "https://vault.example.com" });
  assert.equal(r.ok, false);
  assert.match(r.stderr, /mutually exclusive/);
});

test("a non-http(s) URL is a refusal", () => {
  const r = run({ ENGRAM_APP_URL: "ftp://vault.example.com" });
  assert.equal(r.ok, false);
  assert.match(r.stderr, /not an http\(s\) URL/);
});
