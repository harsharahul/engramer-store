/**
 * Embedding worker: MobileCLIP-S0 through transformers.js, entirely on this
 * device. Models load from this origin only; the strict page CSP means a
 * remote fetch would fail even if attempted. Outputs are unit-normalized so
 * similarity is a plain dot product.
 */
import {
  env,
  AutoTokenizer,
  AutoProcessor,
  CLIPTextModelWithProjection,
  CLIPVisionModelWithProjection,
  RawImage,
} from "@huggingface/transformers";
import { decodeHeic, isHeicLike } from "./heic";

const MODEL = "Xenova/mobileclip_s0";

env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = "/models/";
// The ONNX runtime must load from this origin, never a CDN.
if (env.backends.onnx.wasm) {
  env.backends.onnx.wasm.wasmPaths = "/ort/";
}

let loading: Promise<{
  tokenizer: Awaited<ReturnType<typeof AutoTokenizer.from_pretrained>>;
  processor: Awaited<ReturnType<typeof AutoProcessor.from_pretrained>>;
  textModel: Awaited<ReturnType<typeof CLIPTextModelWithProjection.from_pretrained>>;
  visionModel: Awaited<ReturnType<typeof CLIPVisionModelWithProjection.from_pretrained>>;
} | null> | null = null;

function load() {
  if (!loading) {
    loading = (async () => {
      const [tokenizer, processor, textModel, visionModel] = await Promise.all([
        AutoTokenizer.from_pretrained(MODEL),
        AutoProcessor.from_pretrained(MODEL),
        CLIPTextModelWithProjection.from_pretrained(MODEL, { dtype: "q8" }),
        CLIPVisionModelWithProjection.from_pretrained(MODEL, { dtype: "fp16" }),
      ]);
      return { tokenizer, processor, textModel, visionModel };
    })();
  }
  return loading;
}

function normalized(values: Float32Array): Float32Array {
  let sum = 0;
  for (const v of values) {
    sum += v * v;
  }
  const scale = sum > 0 ? 1 / Math.sqrt(sum) : 0;
  const out = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) {
    out[i] = values[i]! * scale;
  }
  return out;
}

interface EmbedRequest {
  id: number;
  kind: "text" | "image";
  text?: string;
  image?: ArrayBuffer;
  mime?: string;
}

self.onmessage = async (event: MessageEvent<EmbedRequest>) => {
  const { id, kind, text, image, mime } = event.data;
  try {
    const models = await load();
    if (!models) {
      throw new Error("model unavailable");
    }
    let embedding: Float32Array;
    if (kind === "text") {
      const inputs = models.tokenizer([text ?? ""], { padding: "max_length", truncation: true });
      const output = await models.textModel(inputs);
      embedding = normalized(output.text_embeds.data as Float32Array);
    } else {
      const blob = new Blob([image!], { type: mime ?? "image/jpeg" });
      let raw: RawImage;
      try {
        raw = await RawImage.fromBlob(blob);
      } catch (err) {
        // HEIC where the platform cannot decode it; ours can.
        if (!isHeicLike(mime ?? "", "")) {
          throw err;
        }
        const decoded = await decodeHeic(new Uint8Array(image!));
        raw = new RawImage(decoded.data, decoded.width, decoded.height, 4);
      }
      const inputs = await models.processor(raw);
      const output = await models.visionModel(inputs);
      embedding = normalized(output.image_embeds.data as Float32Array);
    }
    self.postMessage({ id, embedding }, { transfer: [embedding.buffer] });
  } catch (err) {
    self.postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
