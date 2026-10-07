/**
 * The backend a conformance test talks to, always over real HTTP: the
 * Node server by default, or the on-device backend binary named by
 * ENGRAM_CONFORMANCE_BIN. Every target gets a fresh data directory, so no
 * state crosses test files, and both are driven by the same client.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../../src/app.js";

export interface TargetResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  /** The answer's bytes, for blob downloads. */
  rawPayload: Buffer;
  json(): any;
}

export interface InjectOptions {
  method: string;
  url: string;
  headers?: Record<string, string>;
  payload?: unknown;
}

export interface Target {
  kind: "node" | "local";
  baseUrl: string;
  dataDir: string;
  inject(options: InjectOptions): Promise<TargetResponse>;
  close(): Promise<void>;
}

export interface TargetOptions {
  quotaBytes?: number;
  /** How often an open change feed is checked and kept warm. */
  eventsHeartbeatMs?: number;
  /** Content versions kept per file. */
  maxVersions?: number;
  /** The backend binary; defaults to ENGRAM_CONFORMANCE_BIN. */
  bin?: string;
  /** How long a binary may take to announce its port. */
  startTimeoutMs?: number;
}

export const conformanceBin = (process.env.ENGRAM_CONFORMANCE_BIN ?? "").trim();

/**
 * Starts a target on a fresh data directory. A target that fails to
 * start leaves nothing behind: its process is killed and its directory
 * removed before the error, which carries the backend's own output, is
 * thrown.
 */
export async function startTarget(options: TargetOptions = {}): Promise<Target> {
  const dataDir = mkdtempSync(join(tmpdir(), "engram-conformance-"));
  const quotaBytes = options.quotaBytes ?? 512 * 1024;
  const heartbeatMs = options.eventsHeartbeatMs ?? 25_000;
  const maxVersions = options.maxVersions ?? 10;
  const bin = options.bin ?? conformanceBin;
  try {
    if (bin) {
      return await startLocal(bin, dataDir, quotaBytes, heartbeatMs, maxVersions, options.startTimeoutMs ?? 20_000);
    }
    return await startNode(dataDir, quotaBytes, heartbeatMs, maxVersions);
  } catch (err) {
    rmSync(dataDir, { recursive: true, force: true });
    throw err;
  }
}

async function startNode(
  dataDir: string,
  quotaBytes: number,
  eventsHeartbeatMs: number,
  maxVersions: number,
): Promise<Target> {
  const app = await buildApp({ dataDir, quotaBytes, eventsHeartbeatMs, maxVersions, webDistDir: null });
  try {
    await app.listen({ port: 0, host: "127.0.0.1" });
  } catch (err) {
    await app.close();
    throw err;
  }
  const address = app.server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    kind: "node",
    baseUrl,
    dataDir,
    inject: (request) => send(baseUrl, request),
    close: async () => {
      // Every request a suite made has been answered by now; the client's
      // idle keep-alive connections would otherwise hold close() open for
      // the server's keep-alive timeout.
      app.server.closeAllConnections();
      await app.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

async function startLocal(
  bin: string,
  dataDir: string,
  quotaBytes: number,
  eventsHeartbeatMs: number,
  maxVersions: number,
  startTimeoutMs: number,
): Promise<Target> {
  const child = spawn(
    bin,
    [
      "--data-dir",
      dataDir,
      "--port",
      "0",
      "--quota-bytes",
      String(quotaBytes),
      "--events-heartbeat-ms",
      String(eventsHeartbeatMs),
      "--max-versions",
      String(maxVersions),
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const port = await new Promise<number>((resolve, reject) => {
    let stdout = "";
    let settled = false;
    // Rejects only once the process is gone: a backend still running
    // after a failed start would hold its port and its data directory.
    const fail = (message: string) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      const running = child.pid !== undefined && child.exitCode === null && child.signalCode === null;
      if (!running) {
        reject(new Error(message));
        return;
      }
      child.once("close", () => reject(new Error(message)));
      child.kill("SIGKILL");
    };
    const timer = setTimeout(
      () => fail(`engram-local did not start within ${startTimeoutMs} ms\n${stderr}`),
      startTimeoutMs,
    );
    child.stdout.on("data", (chunk) => {
      if (settled) {
        return;
      }
      stdout += String(chunk);
      const match = /listening on 127\.0\.0\.1:(\d+)/.exec(stdout);
      if (match) {
        settled = true;
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    child.on("error", (err) => fail(`engram-local could not start: ${err.message}`));
    // "close" waits for stdout and stderr to drain, so the message is whole.
    child.on("close", (code) => fail(`engram-local exited with ${code}\n${stderr}`));
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    kind: "local",
    baseUrl,
    dataDir,
    inject: (request) => send(baseUrl, request),
    close: async () => {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise((resolve) => child.once("exit", resolve));
        child.kill("SIGTERM");
        await exited;
      }
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** The same request shape as Fastify's inject, sent with fetch. */
async function send(baseUrl: string, request: InjectOptions): Promise<TargetResponse> {
  const headers: Record<string, string> = { ...(request.headers ?? {}) };
  let body: Uint8Array | string | undefined;
  if (request.payload !== undefined) {
    if (request.payload instanceof Uint8Array) {
      body = request.payload;
    } else {
      body = JSON.stringify(request.payload);
      headers["content-type"] ??= "application/json";
    }
  }
  const response = await fetch(baseUrl + request.url, { method: request.method, headers, body });
  const rawPayload = Buffer.from(await response.arrayBuffer());
  const text = rawPayload.toString("utf8");
  return {
    statusCode: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body: text,
    rawPayload,
    json: () => JSON.parse(text),
  };
}
