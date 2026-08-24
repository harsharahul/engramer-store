import type { FastifyInstance } from "fastify";
import { PassThrough } from "node:stream";

/**
 * The change feed: a server-sent event stream that pokes a signed-in
 * device whenever its account's sequence advances, so an always-on
 * client (the desktop tray, holding the Finder drive fresh) learns
 * about another device's upload in seconds instead of at its next
 * poll. Events carry only the sequence number; the client answers
 * every poke with the same cursor pull it already trusts.
 *
 * The first event states the current sequence immediately, which is
 * what lets the endpoint degrade gracefully behind a proxy that
 * refuses long-lived responses: connect, learn where the account
 * stands, reconnect later. A comment line every heartbeat keeps
 * idle-connection reapers away, and each one re-checks what login
 * checks, so a revoked or disabled session loses its stream within
 * one beat instead of holding it for the token's lifetime.
 */
export function registerEventsRoutes(app: FastifyInstance): void {
  const auth = { preHandler: [app.authenticate] };

  app.get("/api/events", auth, async (request, reply) => {
    const uid = request.user.uid;
    const row = await app.db.get<{ last_seq: number }>(
      "SELECT last_seq FROM users WHERE id = ?",
      uid,
    );
    const stream = new PassThrough();
    const unsubscribe = app.seqEvents.subscribe(uid, stream);
    const heartbeat = setInterval(() => {
      void (async () => {
        const state = await app.db.get<{ disabled: number; token_epoch: number }>(
          "SELECT disabled, token_epoch FROM users WHERE id = ?",
          uid,
        );
        const revoked =
          !state ||
          state.disabled === 1 ||
          (request.user.ep ?? 0) !== (state.token_epoch ?? 0);
        if (revoked) {
          stream.end();
        } else {
          stream.write(": hb\n\n");
        }
      })().catch(() => stream.end());
    }, app.config.eventsHeartbeatMs);
    stream.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });

    reply.header("content-type", "text/event-stream");
    reply.header("cache-control", "no-store");
    // Tells nginx-family proxies not to buffer the response; without
    // it events sit in a proxy buffer until the connection dies.
    reply.header("x-accel-buffering", "no");
    stream.write(`retry: 5000\ndata: {"seq":${row?.last_seq ?? 0}}\n\n`);
    return reply.send(stream);
  });
}
