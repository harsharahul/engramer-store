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
}

export const conformanceBin = (process.env.ENGRAM_CONFORMANCE_BIN ?? "").trim();

export async function startTarget(options: TargetOptions = {}): Promise<Target> {
  const dataDir = mkdtempSync(join(tmpdir(), "engram-conformance-"));
  const quotaBytes = options.quotaBytes ?? 512 * 1024;
  if (conformanceBin) {
    return startLocal(dataDir, quotaBytes);
  }
  const app = await buildApp({ dataDir, quotaBytes, webDistDir: null });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    kind: "node",
    baseUrl,
    dataDir,
    inject: (request) => send(baseUrl, request),
    close: async () => {
      await app.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

async function startLocal(dataDir: string, quotaBytes: number): Promise<Target> {
  const child = spawn(
    conformanceBin,
    ["--data-dir", dataDir, "--port", "0", "--quota-bytes", String(quotaBytes)],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const port = await new Promise<number>((resolve, reject) => {
    let stdout = "";
    const timer = setTimeout(
      () => reject(new Error(`engram-local did not start within 20 s\n${stderr}`)),
      20_000,
    );
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      const match = /listening on 127\.0\.0\.1:(\d+)/.exec(stdout);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`engram-local exited with ${code}\n${stderr}`));
    });
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
  const text = Buffer.from(await response.arrayBuffer()).toString("utf8");
  return {
    statusCode: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body: text,
    json: () => JSON.parse(text),
  };
}
