import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
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
import { openDatabase } from "../src/db.js";

/**
 * Presence rows say who holds a live editing channel, and a save is
 * refused with 409 while anyone does. Rows left by an instance that
 * died were only ever hidden by a 90s age filter, so for that long every
 * save on the document failed. Each instance now heartbeats a `pods`
 * row; presence readers ignore rows from instances that stopped, and an
 * instance leaving on purpose removes its rows on the way out.
 */
let app: FastifyInstance;
let dataDir: string;
let token: string;
let fileId: string;
let fileKey: Uint8Array;

beforeAll(async () => {
  await ready();
  dataDir = mkdtempSync(join(tmpdir(), "engramer-presence-"));
  app = await buildApp({ dataDir, webDistDir: null });
  const keys = generateAccountKeys("presence phrase");
  const registered = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { email: "presence@example.com", loginKey: keys.loginKey, keyAttributes: keys.keyAttributes },
  });
  token = registered.json().token as string;
  fileKey = generateKey();
  const content = utf8Encode("presence body");
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

const saveBody = () =>
  app.inject({
    method: "PUT",
    url: `/api/files/${fileId}/data`,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream" },
    payload: Buffer.from(encryptBytes(utf8Encode("saved again"), fileKey)),
  });

describe("presence and pods", () => {
  it("records this instance in the pods table while it runs", async () => {
    const row = await app.db.get<{ pod_id: string; last_seen: number }>(
      "SELECT pod_id, last_seen FROM pods WHERE pod_id = ?",
      app.podId,
    );
    expect(row).toBeDefined();
    expect(Date.now() - Number(row!.last_seen)).toBeLessThan(60_000);
  });

  it("ignores presence rows left by an instance that no longer heartbeats", async () => {
    const now = Date.now();
    await app.db.run(
      `INSERT INTO channel_presence (file_id, conn_id, pod_id, user_id, user_index, role, joined_at, last_seen)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      fileId,
      "ghost-conn",
      "pod-that-died",
      1,
      1,
      "owner",
      now,
      now,
    );
    // Fresh by age, dead by pod: the save must not be refused.
    const saved = await saveBody();
    expect(saved.statusCode).toBe(200);
    // The same row under a live pod does gate the save.
    await app.db.run("UPDATE channel_presence SET pod_id = ? WHERE conn_id = ?", app.podId, "ghost-conn");
    const gated = await saveBody();
    expect(gated.statusCode).toBe(409);
    await app.db.run("DELETE FROM channel_presence WHERE conn_id = ?", "ghost-conn");
  });

  it("removes its own presence and pod rows when it stops", async () => {
    const now = Date.now();
    await app.db.run(
      `INSERT INTO channel_presence (file_id, conn_id, pod_id, user_id, user_index, role, joined_at, last_seen)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      fileId,
      "mine-conn",
      app.podId,
      1,
      2,
      "owner",
      now,
      now,
    );
    const podId = app.podId;
    await app.close();
    // Read back through a fresh handle: the app's own closed with it.
    const db = openDatabase(join(dataDir, "engramer.db"));
    try {
      expect(await db.get("SELECT 1 AS one FROM pods WHERE pod_id = ?", podId)).toBeUndefined();
      expect(await db.get("SELECT 1 AS one FROM channel_presence WHERE pod_id = ?", podId)).toBeUndefined();
    } finally {
      await db.close();
    }
  });
});
