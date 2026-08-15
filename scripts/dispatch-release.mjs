#!/usr/bin/env node
/**
 * Dispatches the deployment pipeline's Release workflow for a version.
 *
 *   ENGRAM_GITEA_HOST=git.example.com ENGRAM_DEPLOY_REPO=you/deploy \
 *     node scripts/dispatch-release.mjs 0.46.0
 *
 * The Gitea host and repository come from the environment; the
 * credential comes from git's own credential helper for that host,
 * the same one pushes use, and is never printed. The workflow
 * refuses to run without a version input by design.
 */
import { execFileSync } from "node:child_process";

const version = (process.argv[2] ?? "").trim();
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error("usage: dispatch-release.mjs <version, e.g. 0.46.0>");
  process.exit(1);
}
const host = process.env.ENGRAM_GITEA_HOST;
const repo = process.env.ENGRAM_DEPLOY_REPO;
if (!host || !repo) {
  console.error("set ENGRAM_GITEA_HOST and ENGRAM_DEPLOY_REPO to your deployment pipeline");
  process.exit(1);
}

const fill = execFileSync("git", ["credential", "fill"], {
  input: `protocol=https\nhost=${host}\n\n`,
  encoding: "utf8",
});
const token = fill.split("\n").find((l) => l.startsWith("password="))?.slice(9);
if (!token) {
  console.error(`no credential for ${host} in git's credential helper`);
  process.exit(1);
}

const response = await fetch(
  `https://${host}/api/v1/repos/${repo}/actions/workflows/release.yml/dispatches`,
  {
    method: "POST",
    headers: { Authorization: `token ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ref: "main", inputs: { version } }),
  },
);
console.log(`dispatch ${version}: HTTP ${response.status}`);
process.exit(response.status === 204 ? 0 : 1);
