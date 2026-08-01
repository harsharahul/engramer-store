/**
 * Writes the golden fixture the Rust decrypt test checks against, using the
 * TypeScript writer as the source of truth. Run from apps/desktop:
 *   node scripts/egc1-fixture.mjs
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ready, chunkedEncrypt } from "../../../packages/crypto/src/index.ts";

await ready();
const size = 5 * 1024 * 1024;
const plain = new Uint8Array(size);
for (let i = 0; i < size; i++) {
  plain[i] = (i * 31 + 7) % 256;
}
const key = new Uint8Array(32);
for (let i = 0; i < 32; i++) {
  key[i] = (i * 13 + 5) % 256;
}
const blob = chunkedEncrypt(plain, key);
const out = join(dirname(fileURLToPath(import.meta.url)), "..", "src-tauri", "tests");
await mkdir(out, { recursive: true });
await writeFile(join(out, "egc1-fixture.bin"), blob);
await writeFile(join(out, "egc1-fixture.key"), key);
console.log(`fixture written: ${blob.length} bytes`);
