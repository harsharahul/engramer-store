import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { Vault } from "./vault.js";
import { buildBridge } from "./server.js";

/** The first line of the file, without its line ending; undefined when unset or unreadable. */
function readPasswordFile(path: string | undefined): string | undefined {
  if (!path) {
    return undefined;
  }
  try {
    const text = readFileSync(path, "utf8");
    return text.split(/\r?\n/)[0] || undefined;
  } catch {
    return undefined;
  }
}

/**
 * CLI entry point for the local S3 bridge.
 *
 *   ENGRAM_EMAIL=you@example.com ENGRAM_PASSWORD=... engram-bridge
 *
 * Point any S3 client at the printed endpoint and credentials.
 */
async function main(): Promise<void> {
  const serverUrl = process.env.ENGRAM_SERVER_URL ?? "http://127.0.0.1:3080";
  const email = process.env.ENGRAM_EMAIL;
  // A file keeps the password out of the process environment, which every
  // process of the same user can read.
  const password = process.env.ENGRAM_PASSWORD ?? readPasswordFile(process.env.ENGRAM_PASSWORD_FILE);
  const host = process.env.BRIDGE_HOST ?? "127.0.0.1";
  const port = Number(process.env.BRIDGE_PORT ?? 3081);

  if (!email || !password) {
    console.error("Set ENGRAM_EMAIL and ENGRAM_PASSWORD (or ENGRAM_PASSWORD_FILE).");
    process.exit(1);
  }

  const accessKeyId = process.env.BRIDGE_ACCESS_KEY ?? `engram${randomBytes(6).toString("hex")}`;
  const secretAccessKey = process.env.BRIDGE_SECRET_KEY ?? randomBytes(24).toString("base64url");

  console.log(`Connecting to ${serverUrl} as ${email} ...`);
  const vault = new Vault(serverUrl, email, password);
  await vault.connect();
  console.log(`Unlocked. ${vault.folders.size} folders, ${vault.files.size} files.`);

  const app = buildBridge(vault, { accessKeyId, secretAccessKey });
  const address = await app.listen({ host, port });

  console.log("");
  console.log(`Local S3 bridge (zero-knowledge) listening at ${address}`);
  console.log("Configure your S3 client with:");
  console.log(`  endpoint          ${address}`);
  console.log(`  region            us-east-1`);
  console.log(`  access key id     ${accessKeyId}`);
  console.log(`  secret access key ${secretAccessKey}`);
  console.log("  path-style        true");
  console.log("");
  console.log("Example: rclone with a provider=Other, path-style S3 remote, then `rclone lsd remote:`.");
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
