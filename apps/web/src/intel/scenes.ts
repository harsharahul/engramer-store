import { CLIP_MODEL_VERSION, cosine, embedQuery } from "./semantic";

/**
 * Scene labels for photos, read off the meaning vector the search index
 * already holds. The same model that answers "beach" as a query scores a
 * photo against a small vocabulary of everyday words; the confident ones
 * become tags, so search, chips, and albums work on them with no new UI.
 *
 * Everything here is arithmetic over unit vectors. The vocabulary is
 * embedded once per device and cached; the model never sees the photo
 * again for this, and nothing leaves the device.
 *
 * Once shipped, a version's meaning is immutable: bump SCENES_VERSION
 * when the vocabulary or the thresholds change, and every device
 * re-labels what lags, the same way CLIP_MODEL_VERSION re-embeds.
 */
export const SCENES_VERSION = 1;

/** Cosine-to-logit scale MobileCLIP was trained with. */
const LOGIT_SCALE = 100;
/**
 * Below this share of the softmax a label is a guess, and unsure means no
 * label. A clear match holds well over half the mass at this scale; flat
 * or abstract pictures spread theirs thinly and must end with nothing.
 */
const MIN_PROBABILITY = 0.2;
const MAX_LABELS = 3;
/** Share of the softmax across text-bearing labels that says "worth reading". */
const TEXT_BEARING_THRESHOLD = 0.25;

interface Scene {
  label: string;
  prompt: string;
}

const scene = (label: string, prompt: string): Scene => ({ label, prompt });

export const SCENES: readonly Scene[] = [
  scene("people", "a photo of people"),
  scene("group", "a group photo of several people together"),
  scene("selfie", "a selfie"),
  scene("portrait", "a portrait of a person"),
  scene("baby", "a photo of a baby"),
  scene("dog", "a photo of a dog"),
  scene("cat", "a photo of a cat"),
  scene("bird", "a photo of a bird"),
  scene("animal", "a photo of an animal"),
  scene("food", "a photo of food on a plate"),
  scene("drink", "a photo of drinks"),
  scene("beach", "a photo of a beach"),
  scene("mountains", "a photo of mountains"),
  scene("forest", "a photo of a forest"),
  scene("sunset", "a photo of a sunset"),
  scene("landscape", "a landscape photo"),
  scene("water", "a photo of a lake, river or sea"),
  scene("snow", "a photo of snow"),
  scene("flowers", "a photo of flowers"),
  scene("garden", "a photo of a garden"),
  scene("city", "a photo of a city skyline"),
  scene("street", "a photo of a street"),
  scene("building", "a photo of a building"),
  scene("temple", "a photo of a temple or place of worship"),
  scene("interior", "a photo of a room indoors"),
  scene("car", "a photo of a car"),
  scene("bicycle", "a photo of a bicycle"),
  scene("boat", "a photo of a boat"),
  scene("airplane", "a photo of an airplane"),
  scene("aerial", "an aerial photo from above"),
  scene("night", "a photo taken at night"),
  scene("concert", "a photo of a concert or live music"),
  scene("sports", "a photo of a sports game"),
  scene("wedding", "a photo of a wedding"),
  scene("birthday", "a photo of a birthday cake"),
  scene("party", "a photo of a party"),
  scene("festival", "a photo of a festival celebration"),
  scene("art", "a photo of a painting or artwork"),
  scene("document", "a photo of a paper document"),
  scene("receipt", "a photo of a receipt"),
  scene("screenshot", "a screenshot of a phone or computer screen"),
  scene("text", "a photo of printed text"),
  scene("whiteboard", "a photo of a whiteboard with writing"),
  scene("sign", "a photo of a sign with words"),
  scene("map", "a photo of a map"),
  scene("book", "a photo of a book"),
  scene("clothing", "a photo of clothes"),
  scene("shopping", "a photo of a store or shopping bags"),
];

/** Labels that mean the picture carries words a text reader could find. */
export const TEXT_BEARING: ReadonlySet<string> = new Set([
  "document",
  "receipt",
  "screenshot",
  "text",
  "whiteboard",
  "sign",
]);

export interface SceneScore {
  label: string;
  probability: number;
}

/** Softmax over the scaled cosines, best first. Pure: unit vectors in, shares out. */
export function scoreScenes(
  clip: Float32Array,
  vectors: ReadonlyArray<{ label: string; vector: Float32Array }>,
): SceneScore[] {
  if (vectors.length === 0) {
    return [];
  }
  const logits = vectors.map((v) => cosine(clip, v.vector) * LOGIT_SCALE);
  const top = Math.max(...logits);
  const exps = logits.map((l) => Math.exp(l - top));
  const sum = exps.reduce((a, b) => a + b, 0);
  return vectors
    .map((v, i) => ({ label: v.label, probability: exps[i]! / sum }))
    .sort((a, b) => b.probability - a.probability);
}

/** The labels worth keeping: the few confident ones, or none. */
export function sceneLabels(scores: readonly SceneScore[]): string[] {
  return scores
    .filter((s) => s.probability >= MIN_PROBABILITY)
    .slice(0, MAX_LABELS)
    .map((s) => s.label);
}

/** Whether a text reading is worth its cost for this picture. */
export function looksTextBearing(scores: readonly SceneScore[]): boolean {
  const share = scores
    .filter((s) => TEXT_BEARING.has(s.label))
    .reduce((sum, s) => sum + s.probability, 0);
  return share >= TEXT_BEARING_THRESHOLD;
}

const CACHE_KEY = `engram-scenes:clip${CLIP_MODEL_VERSION}:v${SCENES_VERSION}`;

function encodeVectors(vectors: Array<{ label: string; vector: Float32Array }>): string {
  return JSON.stringify(
    vectors.map((v) => ({ label: v.label, vector: Array.from(v.vector) })),
  );
}

function decodeVectors(raw: string): Array<{ label: string; vector: Float32Array }> | null {
  try {
    const parsed = JSON.parse(raw) as Array<{ label: string; vector: number[] }>;
    if (!Array.isArray(parsed) || parsed.length !== SCENES.length) {
      return null;
    }
    return parsed.map((v) => ({ label: v.label, vector: Float32Array.from(v.vector) }));
  } catch {
    return null;
  }
}

let vectorsPromise: Promise<Array<{ label: string; vector: Float32Array }> | null> | null = null;

/**
 * The vocabulary as vectors, embedded once per device and remembered.
 * Null when the model cannot answer (no model files, no worker): labeling
 * is then simply skipped, and the file stays a candidate for later.
 */
export function sceneVectors(
  embed: (text: string) => Promise<Float32Array | undefined> = embedQuery,
): Promise<Array<{ label: string; vector: Float32Array }> | null> {
  if (vectorsPromise) {
    return vectorsPromise;
  }
  vectorsPromise = (async () => {
    try {
      const cached = localStorage.getItem(CACHE_KEY);
      if (cached) {
        const decoded = decodeVectors(cached);
        if (decoded) {
          return decoded;
        }
      }
    } catch {
      // No storage; embed every session.
    }
    const vectors: Array<{ label: string; vector: Float32Array }> = [];
    for (const s of SCENES) {
      const vector = await embed(s.prompt);
      if (!vector) {
        vectorsPromise = null;
        return null;
      }
      vectors.push({ label: s.label, vector });
    }
    try {
      localStorage.setItem(CACHE_KEY, encodeVectors(vectors));
    } catch {
      // Best-effort cache.
    }
    return vectors;
  })();
  return vectorsPromise;
}

/** Forgets the embedded vocabulary (tests, or a model swap in-session). */
export function resetSceneVectors(): void {
  vectorsPromise = null;
}

export interface SceneReading {
  labels: string[];
  textBearing: boolean;
}

/** Labels one photo's meaning vector; null when the vocabulary is unavailable. */
export async function readScenes(
  clip: Float32Array,
  embed?: (text: string) => Promise<Float32Array | undefined>,
): Promise<SceneReading | null> {
  const vectors = await sceneVectors(embed);
  if (!vectors) {
    return null;
  }
  const scores = scoreScenes(clip, vectors);
  return { labels: sceneLabels(scores), textBearing: looksTextBearing(scores) };
}
