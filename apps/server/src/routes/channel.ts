import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { nextChannelSeq } from "../db.js";
import type { Connection } from "../collabhub.js";

/**
 * The blind relay: an ordered, append-only channel per document.
 *
 * Truncation deliberately has NO message here. A client that could name
 * the position to discard could discard other people's unsynced work
 * without ever saving anything, which an audit demonstrated end to end.
 * The log is trimmed only by the server, inside the transaction that
 * commits a real snapshot save (see routes/storage.ts). Clients
 * post opaque base64 payloads (ciphertext under the file key, which this
 * server never holds); the database allocates each frame's position with a
 * single-row atomic, the log makes reconnection lossless, and ephemeral
 * frames (presence, cursors) are broadcast without ever touching a row.
 *
 * Authentication is a single-use ticket minted over the normal
 * authenticated API, so the long-lived bearer token never appears in a
 * URL, and the membership check runs against the database before a socket
 * exists.
 */

const TICKET_TTL_MS = 30_000;
/** Sockets idle beyond this are presumed dead; presence rows expire with it. */
const PRESENCE_TTL_MS = 90_000;

export function registerChannelRoutes(app: FastifyInstance): void {
  const auth = { preHandler: [app.authenticate] };

  /** The caller's role on a live file: owner, member role, or nothing. */
  const accessRole = async (fileId: string, uid: number): Promise<string | undefined> => {
    const owned = await app.db.get<{ id: string }>(
      "SELECT id FROM files WHERE id = ? AND user_id = ? AND deleted = 0 AND trashed = 0 AND uploaded = 1",
      fileId,
      uid,
    );
    if (owned) {
      return "owner";
    }
    const membership = await app.db.get<{ role: string }>(
      `SELECT c.role FROM file_collaborators c JOIN files f ON f.id = c.file_id
       WHERE c.file_id = ? AND c.user_id = ? AND c.revoked = 0
         AND f.deleted = 0 AND f.trashed = 0 AND f.uploaded = 1`,
      fileId,
      uid,
    );
    return membership?.role;
  };

  app.post("/api/collab/:fileId/ticket", auth, async (request, reply) => {
    const { fileId } = request.params as { fileId: string };
    const uid = request.user.uid;
    if (!(await accessRole(fileId, uid))) {
      return reply.code(404).send({ error: "file not found" });
    }
    const ticket = randomBytes(24).toString("base64url");
    await app.db.run(
      "INSERT INTO collab_tickets (ticket, user_id, file_id, expires_at) VALUES (?, ?, ?, ?)",
      ticket,
      uid,
      fileId,
      Date.now() + TICKET_TTL_MS,
    );
    // Expired tickets from crashed clients would otherwise pile up forever.
    await app.db.run("DELETE FROM collab_tickets WHERE expires_at < ?", Date.now() - 60_000);
    return reply.code(201).send({ ticket, expiresIn: TICKET_TTL_MS / 1000 });
  });

  app.get(
    "/api/collab/:fileId/channel",
    { websocket: true },
    (socket: WebSocket, request) => {
      const { fileId } = request.params as { fileId: string };
      const ticket = String((request.query as { ticket?: string }).ticket ?? "");
      const connId = randomUUID();
      let joined = false;
      let memberIndex = 0;
      let drainEarly: () => void = () => {};
      // A viewer may watch the document change in real time, which is the
      // point of live viewing, but may never write to it. Without this the
      // role is decorative: a viewer's frames would be applied by every
      // editor's engine and then persisted by whoever saved next.
      let mayWrite = false;

      let connUserId = 0;
      const conn: Connection = {
        id: connId,
        get userId() {
          return connUserId;
        },
        send: (frame) => {
          if (socket.readyState === socket.OPEN) {
            socket.send(JSON.stringify(frame));
          }
        },
        close: (code) => socket.close(code),
      };

      const refuse = (code: number) => {
        socket.close(code);
      };

      const membersFrame = async () => ({
        t: "members",
        members: (
          await app.db.all<{ conn_id: string; user_index: number }>(
            "SELECT conn_id, user_index FROM channel_presence WHERE file_id = ? AND last_seen > ?",
            fileId,
            Date.now() - PRESENCE_TTL_MS,
          )
        ).map((row) => ({ connId: row.conn_id, index: row.user_index })),
      });

      void (async () => {
        // Single-use claim: the delete is the authentication, and two
        // sockets presenting the same ticket can never both win it.
        const claimed = await app.db.get<{ user_id: number }>(
          "DELETE FROM collab_tickets WHERE ticket = ? AND file_id = ? AND expires_at > ? RETURNING user_id",
          ticket,
          fileId,
          Date.now(),
        );
        if (!claimed) {
          return refuse(4401);
        }
        // The membership could have been revoked between mint and connect,
        // and the role decides what this socket may do for its whole life.
        const role = await accessRole(fileId, claimed.user_id);
        if (!role) {
          return refuse(4403);
        }
        mayWrite = role === "owner" || role === "editor";
        connUserId = claimed.user_id;
        const now = Date.now();
        // A sticky per-channel index, never reused: the engine namespaces
        // object ids by participant index, and a recycled index would let
        // two histories mint colliding ids.
        const counted = await app.db.get<{ member_counter: number }>(
          `INSERT INTO channel_state (file_id, member_counter, updated_at) VALUES (?, 1, ?)
           ON CONFLICT (file_id) DO UPDATE SET member_counter = channel_state.member_counter + 1, updated_at = ?
           RETURNING member_counter`,
          fileId,
          now,
          now,
        );
        memberIndex = counted!.member_counter;
        await app.db.run(
          `INSERT INTO channel_presence (file_id, conn_id, pod_id, user_id, user_index, joined_at, last_seen)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          fileId,
          connId,
          app.podId,
          claimed.user_id,
          memberIndex,
          now,
          now,
        );
        app.hub.join(fileId, conn);
        joined = true;
        drainEarly();
        app.hub.broadcast(fileId, await membersFrame());
      })().catch(() => refuse(1011));

      /**
       * One frame at a time, in arrival order. Concurrent handlers would
       * each read the channel's size before any of them wrote it back, so
       * a burst could sail past the ceiling; they would also let two posts
       * take positions in the opposite order to the one they were sent.
       */
      const handleFrame = async (raw: string) => {
        {
          let frame: { t?: string; ref?: string; lastSeq?: number; payload?: string };
          try {
            frame = JSON.parse(String(raw)) as typeof frame;
          } catch {
            return refuse(1003);
          }
          switch (frame.t) {
            case "hello": {
              const state = await app.db.get<{
                last_seq: number;
                snapshot_generation: number;
                snapshot_seq: number;
              }>(
                "SELECT last_seq, snapshot_generation, snapshot_seq FROM channel_state WHERE file_id = ?",
                fileId,
              );
              conn.send({
                t: "welcome",
                channelSeq: state?.last_seq ?? 0,
                snapshotGeneration: state?.snapshot_generation ?? 0,
                snapshotSeq: state?.snapshot_seq ?? 0,
                you: connId,
                yourIndex: memberIndex,
                members: (await membersFrame()).members,
              });
              const since = Number(frame.lastSeq ?? 0);
              const tail = await app.db.all<{ seq: number; sender: string; payload: string }>(
                "SELECT seq, sender, payload FROM channel_messages WHERE file_id = ? AND seq > ? ORDER BY seq",
                fileId,
                since,
              );
              for (const row of tail) {
                conn.send({ t: "log", seq: row.seq, sender: row.sender, payload: row.payload });
              }
              conn.send({
                t: "caught-up",
                seq: tail.length > 0 ? tail[tail.length - 1]!.seq : since,
              });
              return;
            }
            case "post": {
              if (!mayWrite || typeof frame.payload !== "string" || frame.payload.length === 0) {
                return;
              }
              // The log is a tail between snapshots, not storage. Past the
              // ceiling the room is asked to snapshot — which truncates and
              // reopens the channel — and further frames are refused rather
              // than allowed to grow the database without limit.
              const state = await app.db.get<{ bytes: number }>(
                "SELECT bytes FROM channel_state WHERE file_id = ?",
                fileId,
              );
              if (Number(state?.bytes ?? 0) >= app.config.channelMaxBytes) {
                app.hub.broadcast(fileId, { t: "please-snapshot" });
                conn.send({ t: "please-snapshot" });
                return;
              }
              const seq = await nextChannelSeq(app.db, fileId);
              await app.db.run(
                `INSERT INTO channel_messages (file_id, seq, sender, payload, bytes, created_at)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                fileId,
                seq,
                connId,
                frame.payload,
                frame.payload.length,
                Date.now(),
              );
              await app.db.run(
                "UPDATE channel_state SET bytes = bytes + ? WHERE file_id = ?",
                frame.payload.length,
                fileId,
              );
              await app.db.run(
                "UPDATE channel_presence SET last_seen = ? WHERE file_id = ? AND conn_id = ?",
                Date.now(),
                fileId,
                connId,
              );
              app.hub.broadcast(
                fileId,
                { t: "log", seq, sender: connId, payload: frame.payload },
                connId,
              );
              conn.send({ t: "ack", ref: frame.ref ?? null, seq });
              return;
            }
            case "eph": {
              // The ephemeral path skips the ordered log, so it must not
              // become the way around the write gate: a viewer could
              // otherwise relabel a document change as a cursor and have
              // every editor apply it.
              if (!mayWrite || typeof frame.payload !== "string") {
                return;
              }
              // Broadcast and forget: presence and cursors leave no row to
              // subpoena, and a missed one costs nothing.
              app.hub.broadcast(
                fileId,
                { t: "eph", sender: connId, payload: frame.payload },
                connId,
              );
              return;
            }
            default:
              return;
          }
        }
      };

      // Frames that arrive while the join is still in flight are held, not
      // dropped: a browser greets the instant its socket opens, well before
      // the database has finished admitting it.
      const early: string[] = [];
      let chain: Promise<void> = Promise.resolve();
      const enqueue = (raw: string) => {
        chain = chain.then(() => handleFrame(raw)).catch(() => refuse(1011));
      };
      drainEarly = () => {
        for (const raw of early.splice(0)) {
          enqueue(raw);
        }
      };

      socket.on("message", (raw) => {
        const text = String(raw);
        if (!joined) {
          early.push(text);
          return;
        }
        enqueue(text);
      });

      socket.on("close", () => {
        void (async () => {
          if (!joined) {
            return;
          }
          app.hub.leave(fileId, conn);
          await app.db.run(
            "DELETE FROM channel_presence WHERE file_id = ? AND conn_id = ?",
            fileId,
            connId,
          );
          app.hub.broadcast(fileId, await membersFrame());
        })().catch(() => {});
      });
    },
  );
}
