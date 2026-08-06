/// <reference lib="webworker" />
/**
 * The entity extractor, quarantined in its own worker.
 *
 * Quarantined for a hard reason: the extractor pins transformers v2 while
 * the app ships v4, and the two must never share a bundle or a global. The
 * model, its tokenizer and the runtime's WebAssembly all load from this
 * origin, staged there by scripts/fetch-models.mjs; nothing in this worker
 * ever talks to another host, and the content security policy would refuse
 * it anyway.
 */

import { Gliner } from "gliner";

const MODEL = "onnx-community/gliner_small-v2.1";

let ready: Promise<Gliner> | null = null;
let initMs: number | null = null;

async function load(): Promise<Gliner> {
  const started = performance.now();
  const gliner = new Gliner({
    // Resolves under this origin's /models/ tree, the extractor's default
    // local path.
    tokenizerPath: MODEL,
    onnxSettings: {
      modelPath: `/models/${MODEL}/onnx/model_quantized.onnx`,
      executionProvider: "wasm",
      wasmPaths: "/gliner-ort/",
    },
    transformersSettings: { allowLocalModels: true, useBrowserCache: true },
    maxWidth: 12,
  });
  await gliner.initialize();
  initMs = Math.round(performance.now() - started);
  return gliner;
}

interface Ask {
  id: number;
  text: string;
  labels: string[];
  threshold: number;
}

self.onmessage = async (event: MessageEvent<Ask>) => {
  const { id, text, labels, threshold } = event.data;
  try {
    ready ??= load();
    const gliner = await ready;
    const out = await gliner.inference({ texts: [text], entities: labels, threshold });
    const spans = (out[0] ?? []).map((span) => ({
      label: span.label,
      text: String(span.spanText),
      start: span.start,
      end: span.end,
      score: span.score,
    }));
    self.postMessage({ id, spans, initMs });
  } catch (error) {
    ready = null;
    self.postMessage({ id, error: String(error) });
  }
};
