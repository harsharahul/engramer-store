import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  SCENES,
  looksTextBearing,
  readScenes,
  resetSceneVectors,
  sceneLabels,
  scoreScenes,
} from "./scenes";

/** Unit vectors in a toy space: one axis per named label, so cosines are exact. */
const axis = (i: number, dims = 8): Float32Array => {
  const v = new Float32Array(dims);
  v[i] = 1;
  return v;
};
const mix = (parts: Array<[number, number]>, dims = 8): Float32Array => {
  const v = new Float32Array(dims);
  for (const [i, w] of parts) {
    v[i] = w;
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / norm);
};

const vocabulary = [
  { label: "beach", vector: axis(0) },
  { label: "dog", vector: axis(1) },
  { label: "document", vector: axis(2) },
  { label: "receipt", vector: axis(3) },
  { label: "food", vector: axis(4) },
];

describe("scoreScenes and sceneLabels", () => {
  it("names the one thing a picture clearly is", () => {
    const scores = scoreScenes(axis(0), vocabulary);
    expect(scores[0]).toMatchObject({ label: "beach" });
    expect(scores[0]!.probability).toBeGreaterThan(0.99);
    expect(sceneLabels(scores)).toEqual(["beach"]);
  });

  it("keeps up to three confident labels for a mixed picture, best first", () => {
    // Equal parts beach and dog, a touch of food: two clear labels, one weak.
    const scores = scoreScenes(mix([[0, 1], [1, 1], [4, 0.6]]), vocabulary);
    const labels = sceneLabels(scores);
    expect(labels.slice(0, 2).sort()).toEqual(["beach", "dog"]);
    expect(labels.length).toBeLessThanOrEqual(3);
  });

  it("says nothing about a picture that is nothing in particular", () => {
    // Orthogonal to every label: every cosine is 0, the softmax is flat.
    const scores = scoreScenes(axis(7), vocabulary);
    expect(scores.every((s) => Math.abs(s.probability - 0.2) < 1e-6)).toBe(true);
    // With a vocabulary the size of the real one, a flat share (~0.02)
    // sits well under the floor and no label is claimed.
    const wide = Array.from({ length: 48 }, (_, i) => ({ label: `l${i}`, vector: axis(i, 64) }));
    expect(sceneLabels(scoreScenes(axis(63, 64), wide))).toEqual([]);
  });
});

// The vocabulary cache lives in localStorage; give the node test environment one.
beforeAll(() => {
  const backing = new Map<string, string>();
  (globalThis as { localStorage?: Storage }).localStorage = {
    getItem: (k: string) => backing.get(k) ?? null,
    setItem: (k: string, v: string) => void backing.set(k, String(v)),
    removeItem: (k: string) => void backing.delete(k),
    clear: () => backing.clear(),
    key: (i: number) => [...backing.keys()][i] ?? null,
    get length() {
      return backing.size;
    },
  } as Storage;
});

describe("looksTextBearing", () => {
  it("is true for documents and receipts, false for a beach", () => {
    expect(looksTextBearing(scoreScenes(axis(2), vocabulary))).toBe(true);
    expect(looksTextBearing(scoreScenes(mix([[2, 1], [3, 1]]), vocabulary))).toBe(true);
    expect(looksTextBearing(scoreScenes(axis(0), vocabulary))).toBe(false);
  });
});

describe("readScenes", () => {
  beforeEach(() => {
    resetSceneVectors();
    localStorage.clear();
  });

  it("embeds the vocabulary once, remembers it, and labels from it", async () => {
    let calls = 0;
    const embed = async (prompt: string) => {
      calls++;
      const i = SCENES.findIndex((s) => s.prompt === prompt);
      return axis(i, SCENES.length);
    };
    const beachIndex = SCENES.findIndex((s) => s.label === "beach");
    const first = await readScenes(axis(beachIndex, SCENES.length), embed);
    expect(first).toEqual({ labels: ["beach"], textBearing: false });
    expect(calls).toBe(SCENES.length);
    // A second reading, even after forgetting the in-memory copy, costs no embedding.
    resetSceneVectors();
    const receiptIndex = SCENES.findIndex((s) => s.label === "receipt");
    const second = await readScenes(axis(receiptIndex, SCENES.length), embed);
    expect(second).toEqual({ labels: ["receipt"], textBearing: true });
    expect(calls).toBe(SCENES.length);
  });

  it("answers null, not a wrong label, when the model cannot embed", async () => {
    const reading = await readScenes(axis(0, SCENES.length), async () => undefined);
    expect(reading).toBeNull();
  });
});
