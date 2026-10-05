import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startTarget } from "./helpers/target.js";

/**
 * The conformance helper must never leave a backend process or a data
 * directory behind when a target fails to start, and must surface the
 * backend's own error. These stand-in binaries record the data directory
 * and process id they were given, so the test can check both are gone.
 */
function standIn(body: (dir: string) => string) {
  const dir = mkdtempSync(join(tmpdir(), "engram-stand-in-"));
  const script = join(dir, "engram-local");
  writeFileSync(script, `#!/bin/sh\necho "$2" > "${dir}/data-dir"\n${body(dir)}\n`);
  chmodSync(script, 0o755);
  return {
    script,
    dataDir: () => readFileSync(join(dir, "data-dir"), "utf8").trim(),
    pid: () => Number(readFileSync(join(dir, "pid"), "utf8").trim()),
  };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("the conformance target helper", () => {
  it("kills a backend that never announces its port and removes its directory", async () => {
    const stub = standIn((dir) => `echo $$ > "${dir}/pid"\nexec sleep 30`);
    await expect(startTarget({ bin: stub.script, startTimeoutMs: 500 })).rejects.toThrow(
      /did not start within 500 ms/,
    );
    expect(alive(stub.pid())).toBe(false);
    expect(existsSync(stub.dataDir())).toBe(false);
  });

  it("reports what a backend printed before it exited, and removes its directory", async () => {
    const stub = standIn(() => `echo "cannot open the vault" >&2\nexit 3`);
    await expect(startTarget({ bin: stub.script })).rejects.toThrow(
      /exited with 3[\s\S]*cannot open the vault/,
    );
    expect(existsSync(stub.dataDir())).toBe(false);
  });
});
