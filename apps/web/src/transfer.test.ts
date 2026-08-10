import { beforeAll, describe, expect, it, vi } from "vitest";
import { generateKey, ready } from "@engramer/crypto";
import type { FileDto } from "./api";

const relay = vi.hoisted(() => ({
  started: [] as string[],
  gate: Promise.resolve(),
  open: () => {},
}));

vi.mock("./api", async (importOriginal) => {
  const original = await importOriginal<typeof import("./api")>();
  const dto = (over: Partial<FileDto>): FileDto => ({
    id: "f1",
    folderId: null,
    encryptedKey: { nonce: "", ciphertext: "" },
    encryptedMeta: { nonce: "", ciphertext: "" },
    size: 0,
    thumbSize: 0,
    indexSize: 0,
    uploaded: false,
    trashed: false,
    deleted: false,
    updateSeq: 1,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  });
  return {
    ...original,
    api: {
      ...original.api,
      createFile: async (
        folderId: string | null,
        encryptedKey: FileDto["encryptedKey"],
        encryptedMeta: FileDto["encryptedMeta"],
      ) => dto({ folderId, encryptedKey, encryptedMeta }),
      patchFile: async (id: string, patch: { encryptedMeta: FileDto["encryptedMeta"] }) => {
        relay.started.push("patch");
        await relay.gate;
        return dto({ id, encryptedMeta: patch.encryptedMeta, updatedAt: 2 });
      },
    },
    uploadBlob: async (_id: string, kind: string, bytes: Uint8Array) => {
      relay.started.push(kind);
      if (kind !== "data") {
        await relay.gate;
      }
      return bytes.length;
    },
  };
});

vi.mock("./intel/ocr", () => ({
  ocrEnabled: () => true,
  recognizeImage: vi.fn(async () => "scanned words"),
  recognizePdf: vi.fn(async () => undefined),
  renderPdfPage: vi.fn(async () => null),
}));

vi.mock("./intel/semantic", () => ({
  semanticEnabled: () => true,
  embedImage: vi.fn(async () => new Float32Array(4)),
  CLIP_MODEL_VERSION: 1,
}));

vi.mock("./intel/scan", () => ({
  factsEnabled: () => true,
  scanForFacts: vi.fn(async () => ({ facts: [], evidence: [], decoded: [] })),
}));

import { encryptAndUpload, withDeadline, type PreparedFile } from "./transfer";

describe("withDeadline", () => {
  it("passes a value through when the work finishes in time", async () => {
    expect(await withDeadline(Promise.resolve("ok"), 1000)).toBe("ok");
  });

  it("yields nothing when the work outlasts its deadline", async () => {
    // A media element that never fires its events looks exactly like this.
    const never = new Promise<string>(() => {});
    expect(await withDeadline(never, 20)).toBeUndefined();
  });

  it("yields nothing when the work throws", async () => {
    expect(await withDeadline(Promise.reject(new Error("nope")), 1000)).toBeUndefined();
  });

  it("does not hold the result hostage to the timer", async () => {
    const started = Date.now();
    await withDeadline(Promise.resolve(1), 5000);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

/**
 * After the content lands, the digest patch, the thumbnail and the search
 * index have no data dependency on one another; on a phone network each
 * serial round trip is real waiting. This pins them to travelling together.
 */
describe("encryptAndUpload", () => {
  beforeAll(async () => {
    await ready();
  });

  it("sends the digest patch, thumbnail and index without waiting on each other", async () => {
    relay.started.length = 0;
    relay.gate = new Promise<void>((resolve) => {
      relay.open = resolve;
    });
    const prepared: PreparedFile = {
      meta: { name: "n.txt", mime: "text/plain", size: 5, mtime: 1 },
      analysis: { category: "Documents", tags: [] },
      thumbnail: { bytes: new Uint8Array(10), width: 4, height: 4 },
      text: "hello",
    };
    const file = new File(["hello"], "n.txt", { type: "text/plain" });
    const done = encryptAndUpload(file, null, generateKey(), prepared, () => {});
    // All three must be in flight while none of them has answered yet.
    await vi.waitFor(
      () => {
        expect(relay.started).toContain("patch");
        expect(relay.started).toContain("thumbnail");
        expect(relay.started).toContain("index");
      },
      { timeout: 500 },
    );
    relay.open();
    const result = await done;
    expect(result.dto.uploaded).toBe(true);
    expect(result.meta.digest).toBeDefined();
  });
});

/**
 * A photo used to be decoded three times over — thumbnail, text
 * recognition, barcode scan — each time at full resolution. With HEIC
 * packing tens of megapixels into a couple of megabytes, that exhausted
 * an iPhone and iOS closed the app mid-upload, twice reported from a real
 * device. The reading stages must work from one bounded copy.
 */
describe("analysis reads a bounded copy, not the original", () => {
  it("bounds a large image and leaves a small one alone", async () => {
    const { boundedForReading } = await import("./transfer");
    const big = await boundedForReading(6000, 4000);
    expect(big).not.toBeNull();
    expect(Math.max(big!.width, big!.height)).toBeLessThanOrEqual(3600);
    // Aspect ratio survives, or barcodes and text distort.
    expect(big!.width / big!.height).toBeCloseTo(1.5, 1);

    // Already small enough: no copy, no second decode, nothing wasted.
    expect(await boundedForReading(800, 600)).toBeNull();
  });
});

/**
 * Backup wants photos on the server fast; text recognition, meaning
 * embedding and fact scanning can happen any time later, from any signed-in
 * device. Deferring must leave the per-kind flags unset, because those very
 * flags are how the backfill sweeps find their work.
 */
describe("deferred analysis", () => {
  it("skips the heavy scanners and leaves their flags unset", async () => {
    const { recognizeImage } = await import("./intel/ocr");
    const { embedImage } = await import("./intel/semantic");
    const { scanForFacts } = await import("./intel/scan");
    const { analyzeFile } = await import("./transfer");
    vi.mocked(recognizeImage).mockClear();
    vi.mocked(embedImage).mockClear();
    vi.mocked(scanForFacts).mockClear();

    const photo = new File([new Uint8Array([1, 2, 3])], "p.png", { type: "image/png" });
    const prepared = await analyzeFile(photo, undefined, undefined, { defer: true });

    expect(recognizeImage).not.toHaveBeenCalled();
    expect(embedImage).not.toHaveBeenCalled();
    expect(scanForFacts).not.toHaveBeenCalled();
    expect(prepared.meta.hasText).toBeUndefined();
    expect(prepared.meta.hasClip).toBeUndefined();
    expect(prepared.meta.facts).toBeUndefined();
  });

  it("still runs every scanner when not deferred", async () => {
    const { recognizeImage } = await import("./intel/ocr");
    const { embedImage } = await import("./intel/semantic");
    const { scanForFacts } = await import("./intel/scan");
    const { analyzeFile } = await import("./transfer");
    vi.mocked(recognizeImage).mockClear();
    vi.mocked(embedImage).mockClear();
    vi.mocked(scanForFacts).mockClear();

    const photo = new File([new Uint8Array([1, 2, 3])], "p.png", { type: "image/png" });
    const prepared = await analyzeFile(photo);

    expect(recognizeImage).toHaveBeenCalled();
    expect(embedImage).toHaveBeenCalled();
    expect(scanForFacts).toHaveBeenCalled();
    expect(prepared.meta.hasText).toBe(true);
    expect(prepared.meta.hasClip).toBe(true);
    // The vector's provenance travels with it; a model change re-opens
    // the file instead of mixing incomparable vectors.
    expect(prepared.meta.clipVersion).toBe(1);
  });
});

describe("downloadContent and the moving digest", () => {
  it("accepts strictly newer authenticated bytes over a stale entry digest", async () => {
    const { encryptBytes, contentDigest, utf8Encode } = await import("@engramer/crypto");
    const { downloadContent, IntegrityError } = await import("./transfer");
    const { api } = await import("./api");
    const key = generateKey();
    const current = utf8Encode("the room saved after my last sync");
    const staleDigest = contentDigest(utf8Encode("what my library still expects"));
    (api as unknown as Record<string, unknown>).downloadBlobDetailed = async () => ({
      bytes: encryptBytes(current, key),
      generation: 7,
    });

    // At or past the known generation: the entry is what lags (a save
    // writes bytes then metadata, and any refresh in that gap pairs the
    // new generation with the old digest); the bytes decrypted under the
    // file key, which authenticates them.
    const ahead = await downloadContent("f1", key, staleDigest, { atLeast: 5 });
    expect(ahead.generation).toBe(7);
    expect(ahead.bytes).toEqual(current);
    const equal = await downloadContent("f1", key, staleDigest, { atLeast: 7 });
    expect(equal.generation).toBe(7);

    // An OLDER generation than the library knows is a rollback: refused.
    await expect(
      downloadContent("f1", key, staleDigest, { atLeast: 9 }),
    ).rejects.toBeInstanceOf(IntegrityError);

    // Without a stated baseline the check stays exactly as strict.
    await expect(downloadContent("f1", key, staleDigest)).rejects.toBeInstanceOf(IntegrityError);
  });
});
