import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * The share extension's reading of the share sheet is a pure Swift type;
 * this compiles it with its checks on the Mac and runs them, so the
 * extension's behaviour is tested without a device or a simulator.
 * Skipped where there is no Swift compiler (Linux CI).
 */

const here = dirname(fileURLToPath(import.meta.url));
const intake = resolve(here, "../src-tauri/ios/ShareExtension/ShareIntake.swift");
const checks = resolve(here, "share-intake-check.swift");

/** Whether a Swift compiler is here at all; the compile itself goes
 * through xcrun so the SDK the compiler needs is set up for it. */
function hasSwift() {
  try {
    execFileSync("xcrun", ["-f", "swiftc"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return true;
  } catch {
    return false;
  }
}

test("the share extension reads the sheet as planned", { skip: !hasSwift() && "no swiftc here" }, () => {
  const out = mkdtempSync(join(tmpdir(), "share-intake-"));
  try {
    // Swift allows top-level code only in main.swift when several files
    // compile together, so the checks are compiled under that name.
    const main = join(out, "main.swift");
    copyFileSync(checks, main);
    const binary = join(out, "check");
    const compile = spawnSync(
      "xcrun",
      ["--sdk", "macosx", "swiftc", "-O", "-o", binary, intake, main],
      { encoding: "utf8" },
    );
    assert.equal(compile.status, 0, `swiftc failed:\n${compile.stderr}`);
    const run = spawnSync(binary, [], { encoding: "utf8" });
    assert.equal(run.status, 0, `checks failed:\n${run.stdout}${run.stderr}`);
    assert.match(run.stdout, /all checks passed/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
