import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * A pod is told to stop with SIGTERM. Node's default is to exit at once,
 * cutting every request, stream and socket; the server instead drains
 * through app.close() and says so, so a rolling update ends connections
 * cleanly and within the grace period.
 */
const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, "..", "src", "index.ts");

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

describe("the server process", () => {
  let dataDir: string;

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("drains and exits cleanly on SIGTERM", async () => {
    dataDir = mkdtempSync(join(tmpdir(), "engramer-shutdown-"));
    const port = await freePort();
    const child = spawn(process.execPath, ["--import", "tsx", entry], {
      cwd: join(here, ".."),
      env: {
        ...process.env,
        ENGRAMER_PORT: String(port),
        ENGRAMER_HOST: "127.0.0.1",
        ENGRAMER_DATA_DIR: dataDir,
        ENGRAMER_WEB_DIST: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += String(chunk)));
    child.stderr.on("data", (chunk) => (output += String(chunk)));
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
      child.once("exit", (code, signal) => resolve({ code, signal })),
    );

    const deadline = Date.now() + 30_000;
    while (!output.includes("listening on")) {
      if (Date.now() > deadline) {
        child.kill("SIGKILL");
        throw new Error(`server never listened:\n${output}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const ready = await fetch(`http://127.0.0.1:${port}/api/ready`);
    expect(ready.status).toBe(200);

    const started = Date.now();
    child.kill("SIGTERM");
    const result = await Promise.race([
      exited,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("no exit")), 10_000)),
    ]);
    expect(result.code).toBe(0);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(output).toMatch(/shutting down/);
  }, 45_000);
});
