#!/usr/bin/env node
/**
 * Stages the on-device semantic search model into public/models so the app
 * serves it from its own origin (the CSP allows no other). Files land in
 * the exact Hugging Face layout transformers.js resolves against a local
 * model path. Run once for development; the container build runs it so
 * images ship self-contained. Nothing here is committed: the directory is
 * gitignored and this script is the source of truth for what belongs in it.
 */
import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MODEL = "Xenova/mobileclip_s0";
const BASE = `https://huggingface.co/${MODEL}/resolve/main`;
const FILES = [
  "config.json",
  "preprocessor_config.json",
  "tokenizer.json",
  "tokenizer_config.json",
  "LICENSE",
  // Chosen after in-browser evaluation: the int8 vision tower is numerically
  // broken (identical images embed at 0.37 similarity) and the fp16 text
  // tower fails to load in wasm; this mix is correct and compact.
  "onnx/text_model_quantized.onnx",
  "onnx/vision_model_fp16.onnx",
];

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "models", MODEL);

async function present(path) {
  try {
    return (await stat(path)).size > 0;
  } catch {
    return false;
  }
}

for (const file of FILES) {
  const target = join(root, file);
  if (await present(target)) {
    console.log(`models: ${file} present`);
    continue;
  }
  await mkdir(dirname(target), { recursive: true });
  let attempt = 0;
  for (;;) {
    attempt++;
    try {
      const response = await fetch(`${BASE}/${file}`, { redirect: "follow" });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      await writeFile(target, bytes);
      console.log(`models: fetched ${file} (${(bytes.length / 1048576).toFixed(1)} MB)`);
      break;
    } catch (err) {
      if (attempt >= 4) {
        console.error(`models: failed ${file}: ${err}`);
        process.exit(1);
      }
      await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
    }
  }
}
console.log("models: ready");
