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
