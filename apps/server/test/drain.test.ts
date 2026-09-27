import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import WebSocket from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ready,
  generateAccountKeys,
  generateKey,
  secretBoxSeal,
  encryptBytes,
  encryptFileMetadata,
  utf8Encode,
} from "@engramer/crypto";
import { buildApp } from "../src/app.js";

/**
 * A pod leaving the set closes what it holds on purpose: channel sockets
 * get 1012 ("service restart"), which every client treats as "dial
 * again", and the readiness probe says 503 from the first moment of the
 * drain so the load balancer stops sending new work. The websocket
 * plugin's own default closes with no code and then waits up to 30s for
 * peers that never answer.
 */
let app: FastifyInstance;
let dataDir: string;
let base: string;
let token: string;
let fileId: string;

beforeAll(async () => {
  await ready();
  dataDir = mkdtempSync(join(tmpdir(), "engramer-drain-test-"));
  app = await buildApp({ dataDir, webDistDir: null });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (typeof address === "string" || !address) {
    throw new Error("no port");
  }
  base = `ws://127.0.0.1:${address.port}`;
  const keys = generateAccountKeys("drain test phrase");
  const registered = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { email: "drain@example.com", loginKey: keys.loginKey, keyAttributes: keys.keyAttributes },
  });
  token = registered.json().token as string;
  const fileKey = generateKey();
  const content = utf8Encode("drain body");
  const created = await app.inject({
    method: "POST",
    url: "/api/files",
    headers: { authorization: `Bearer ${token}` },
    payload: {
      folderId: null,
      encryptedKey: secretBoxSeal(fileKey, keys.masterKey),
      encryptedMeta: encryptFileMetadata(
        { name: "doc.docx", mime: "application/octet-stream", size: content.length, mtime: 1 },
        fileKey,
      ),
    },
  });
  fileId = created.json().id as string;
  await app.inject({
    method: "PUT",
    url: `/api/files/${fileId}/data`,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream" },
    payload: Buffer.from(encryptBytes(content, fileKey)),
  });
});

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("draining", () => {
  it("answers the readiness probe with 200 until the drain begins, then 503", async () => {
    const before = await app.inject({ method: "GET", url: "/api/ready" });
    expect(before.statusCode).toBe(200);
    expect(before.json()).toEqual({ status: "ready" });
    // The health probe never changes: liveness must not restart a pod that
    // is doing exactly what it was told.
    const health = await app.inject({ method: "GET", url: "/api/health" });
    expect(health.json()).toEqual({ status: "ok" });
  });

  it("closes channel sockets with 1012 and ends within the deadline", async () => {
    const minted = await app.inject({
      method: "POST",
      url: `/api/collab/${fileId}/ticket`,
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    const ticket = minted.json().ticket as string;
    const socket = new WebSocket(`${base}/api/collab/${fileId}/channel?ticket=${ticket}`);
    const closed = new Promise<number>((resolve) => socket.on("close", (code) => resolve(code)));
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    socket.send(JSON.stringify({ t: "hello", lastSeq: 0 }));
    await new Promise<void>((resolve) => socket.once("message", () => resolve()));

    const started = Date.now();
    const closing = app.close();
    const code = await Promise.race([
      closed,
      new Promise<number>((_, reject) => setTimeout(() => reject(new Error("socket never closed")), 3000)),
    ]);
    expect(code).toBe(1012);
    // Readiness flipped before the sockets went: the load balancer had
    // stopped routing here while they were still being closed.
    expect(app.draining).toBe(true);
    await closing;
    expect(Date.now() - started).toBeLessThan(3000);
  });
});
