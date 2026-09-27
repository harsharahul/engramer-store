import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { buildApp } from "./app.js";

const here = dirname(fileURLToPath(import.meta.url));
const bundledWebDist = join(here, "../../web/dist");

const app = await buildApp({
  webDistDir: process.env.ENGRAMER_WEB_DIST ?? (existsSync(bundledWebDist) ? bundledWebDist : null),
});

const address = await app.listen({ port: app.config.port, host: app.config.host });
app.log.info(`engramer-store server listening on ${address}`);
console.log(`engramer-store server listening on ${address}`);

/**
 * Stopping is a drain, not a cut. Kubernetes (and docker stop) send
 * SIGTERM and allow a grace period; the server stops accepting work,
 * ends its event streams and channel sockets on purpose, lets requests
 * in flight finish, and only then exits. If something holds on past the
 * deadline the remaining connections are closed and the process exits
 * anyway, well before the platform would kill it.
 */
const DRAIN_DEADLINE_MS = Number(process.env.ENGRAMER_DRAIN_DEADLINE_MS ?? 40_000);
let stopping = false;

function shutdown(signal: NodeJS.Signals): void {
  if (stopping) {
    return;
  }
  stopping = true;
  console.log(`engramer-store server shutting down (${signal})`);
  const deadline = setTimeout(() => {
    console.warn(`engramer-store server drain exceeded ${DRAIN_DEADLINE_MS}ms; closing remaining connections`);
    app.server.closeAllConnections();
    process.exit(0);
  }, DRAIN_DEADLINE_MS);
  deadline.unref();
  app
    .close()
    .then(() => {
      clearTimeout(deadline);
      console.log("engramer-store server stopped");
      process.exit(0);
    })
    .catch((err: unknown) => {
      clearTimeout(deadline);
      console.error(`engramer-store server failed to stop cleanly: ${String(err)}`);
      process.exit(1);
    });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
