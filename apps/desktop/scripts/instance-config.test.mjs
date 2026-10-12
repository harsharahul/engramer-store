import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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

/** A stand-in for the web client's core bundle: the two files the config checks for. */
function fakeCore() {
  const dir = mkdtempSync(join(tmpdir(), "instance-config-core-"));
  writeFileSync(join(dir, "index.html"), "<!doctype html>");
  writeFileSync(join(dir, "packs.json"), "{}");
  return dir;
}

test("a generic build bakes the local picker, no origin, and the core bundle for local mode", () => {
  const core = fakeCore();
  try {
    const r = run({ ENGRAM_GENERIC: "1", ENGRAM_LOCAL_CORE: core });
    assert.equal(r.ok, true, r.stderr);
    assert.equal(r.instance.build.frontendDist, "../picker");
    assert.equal(r.instance.build.devUrl, null, "the dev server must not replace the picker");
    assert.equal(r.instance.app.windows[0].url, "index.html");
    assert.deepEqual(r.capability.remote.urls, ["https://**"]);
    const resources = r.instance.bundle.resources;
    assert.deepEqual(Object.values(resources), ["webdist"]);
    const [source] = Object.keys(resources);
    assert.equal(resolve(join(here, "..", "src-tauri"), source), core);
  } finally {
    rmSync(core, { recursive: true, force: true });
  }
});

test("a generic build without the core bundle is a refusal with the build hint", () => {
  const empty = mkdtempSync(join(tmpdir(), "instance-config-nocore-"));
  try {
    const r = run({ ENGRAM_GENERIC: "1", ENGRAM_LOCAL_CORE: empty });
    assert.equal(r.ok, false);
    assert.match(r.stderr, /needs the web client's core bundle/);
    assert.match(r.stderr, /local:packs/);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test("a core bundle named with a tilde is found under the home directory", () => {
  const core = mkdtempSync(join(homedir(), ".instance-config-core-"));
  writeFileSync(join(core, "index.html"), "<!doctype html>");
  writeFileSync(join(core, "packs.json"), "{}");
  try {
    const r = run({ ENGRAM_GENERIC: "1", ENGRAM_LOCAL_CORE: `~/${core.slice(homedir().length + 1)}` });
    assert.equal(r.ok, true, r.stderr);
    const [source] = Object.keys(r.instance.bundle.resources);
    assert.equal(resolve(join(here, "..", "src-tauri"), source), core);
  } finally {
    rmSync(core, { recursive: true, force: true });
  }
});

test("the remote capability never grants the local vault's commands", () => {
  const core = fakeCore();
  try {
    for (const env of [{ ENGRAM_GENERIC: "1", ENGRAM_LOCAL_CORE: core }, { ENGRAM_APP_URL: "https://vault.example.com" }]) {
      const r = run(env);
      assert.equal(r.ok, true, r.stderr);
      assert.ok(r.capability.permissions.includes("shell-commands"));
      assert.ok(!r.capability.permissions.includes("local-commands"), JSON.stringify(env));
    }
  } finally {
    rmSync(core, { recursive: true, force: true });
  }
});

test("a baked build carries no core bundle and keeps its dev server", () => {
  const r = run({ ENGRAM_APP_URL: "https://vault.example.com" });
  assert.equal(r.ok, true);
  assert.equal(r.instance.bundle, undefined);
  assert.equal(r.instance.build.devUrl, "http://localhost:5173");
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
