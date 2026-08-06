#!/usr/bin/env node
/**
 * Points the desktop shell at a vault.
 *
 * The shell is a native window around a hosted client, so it has to be told
 * which deployment it belongs to. That address is a property of whoever
 * builds the app, not of this source tree, so the committed configuration
 * names only localhost and the real one arrives in the environment:
 *
 *   ENGRAM_APP_URL=https://vault.example.com pnpm --filter @engramer/desktop bundle
 *
 * The Apple signing team is the builder's property in the same way, so iOS
 * builds name it in the environment too:
 *
 *   APPLE_DEVELOPMENT_TEAM=XXXXXXXXXX ENGRAM_APP_URL=... pnpm --filter @engramer/desktop ios:bundle
 *
 * Both files this writes are derived and ignored by git, so a build can
 * never leave a builder's own address or team in a tracked file. Two things
 * need the address: the window's URL, and the capability that lets that
 * origin call the shell's unlock commands, which is what makes Touch ID
 * work.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const tauriDir = join(here, "..", "src-tauri");

// Derived from the committed configuration rather than restating it, so the
// window keeps its size, title and everything else it is given there.
const config = JSON.parse(readFileSync(join(tauriDir, "tauri.conf.json"), "utf8"));

// Both files are written every time, including when nothing is set: the
// build always passes them, and a stale one from an earlier build pointing
// somewhere else would be worse than none.
const raw = (process.env.ENGRAM_APP_URL ?? "").trim().replace(/\/+$/, "");
let origin = config.app.windows?.[0]?.url ?? "http://localhost:3080";
if (raw) {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error("not http(s)");
    }
    origin = parsed.origin;
  } catch {
    console.error(`instance: ENGRAM_APP_URL is not an http(s) URL: ${raw}`);
    process.exit(1);
  }
}
config.build.frontendDist = origin;
for (const window of config.app.windows ?? []) {
  window.url = origin;
}
const instance = { build: config.build, app: { windows: config.app.windows } };
const team = (process.env.APPLE_DEVELOPMENT_TEAM ?? "").trim();
if (team) {
  instance.bundle = { iOS: { developmentTeam: team } };
}
writeFileSync(
  join(tauriDir, "tauri.instance.json"),
  `${JSON.stringify(instance, null, 2)}\n`,
);

const capability = JSON.parse(readFileSync(join(tauriDir, "capabilities", "default.json"), "utf8"));
capability.identifier = "instance";
capability.description = "The deployment this build belongs to, named at build time.";
capability.remote = { urls: [origin] };
writeFileSync(
  join(tauriDir, "capabilities", "instance.json"),
  `${JSON.stringify(capability, null, 2)}\n`,
);

console.log(
  raw ? `instance: building against ${origin}` : `instance: no ENGRAM_APP_URL set, using ${origin}`,
);
