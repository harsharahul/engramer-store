import { beforeAll, describe, expect, it, vi } from "vitest";
import { chunkedCiphertextSize, generateKey, ready } from "@engramer/crypto";
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
    beginPartUpload: async () => ({ session: "s1" }),
    uploadPart: async (_id: string, _s: string, _no: number, body: Uint8Array) => body.length,
    completePartUpload: async () => ({ size: 0 }),
    abortPartUpload: async () => {},
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

import {
  contentCiphertextSize,
  encryptAndUpload,
  makeThumbnail,
  withDeadline,
  type PreparedFile,
  type UploadSource,
} from "./transfer";

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
 * The upload path was designed to never hold a large file: 4 MiB slices,
 * bounded part bodies. That property was silently defeated once, by a
 * picker that handed it memory-backed Files, and the whole app died on a
 * 30-second video. This suite guards the property itself, so the next
 * change that re-materializes a source fails here instead of on a phone.
 */
describe("the upload path never materializes a large source", () => {
  beforeAll(async () => {
    await ready();
  });

  const virtualSource = (size: number, over: Partial<UploadSource> = {}): UploadSource & {
    wholeReads: () => number;
    maxWindow: () => number;
  } => {
    let whole = 0;
    let max = 0;
    return {
      name: "big.mov",
      type: "video/mp4",
      size,
      lastModified: 1,
      slice(start = 0, end = size) {
        const from = Math.min(start, size);
        const to = Math.min(end, size);
        return {
          size: to - from,
          arrayBuffer: async () => {
            max = Math.max(max, to - from);
            return new Uint8Array(to - from).buffer as ArrayBuffer;
          },
        };
      },
      arrayBuffer: async () => {
        whole++;
        return new ArrayBuffer(size);
      },
      text: async () => "",
      wholeReads: () => whole,
      maxWindow: () => max,
      ...over,
    };
  };

  it("streams a 64MiB source in bounded windows, never whole", async () => {
    const source = virtualSource(64 * 1024 * 1024 + 5);
    const prepared: PreparedFile = {
      meta: { name: source.name, mime: source.type, size: source.size, mtime: 1 },
      analysis: { category: "Other", tags: [] },
      thumbnail: null,
    };
    await encryptAndUpload(source, null, generateKey(), prepared, () => {});
    expect(source.wholeReads()).toBe(0);
    expect(source.maxWindow()).toBeLessThanOrEqual(4 * 1024 * 1024);
  });

  it("sizes a typeless picked video as media, so playback can seek", () => {
    // The shell hands over paths; an extension outside the mime table
    // means an empty type, and an empty type used to pick the stream
    // format, which cannot answer range requests.
    const source = virtualSource(1000, { name: "clip.mov", type: "" });
    expect(contentCiphertextSize(source)).toBe(chunkedCiphertextSize(1000));
  });

  it("yields no thumbnail, quickly, for a video source with no URL to decode", async () => {
    // A source that is neither a Blob nor URL-served cannot feed a media
    // element; the honest answer is no thumbnail, not a hang or a throw.
    const source = virtualSource(1000);
    await expect(makeThumbnail(source, "video/mp4")).resolves.toBeNull();
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

/**
 * A sweep must be able to tell "read it, there was nothing" from "the
 * read never came back". Conflating them would let a stalled phone
 * stamp a file as read-and-empty, which is a permanent lie about a file
 * nobody ever managed to read.
 */
describe("withDeadlineOrThrow", () => {
  it("passes a value through, including a legitimate nothing", async () => {
    const { withDeadlineOrThrow } = await import("./transfer");
    expect(await withDeadlineOrThrow(Promise.resolve("ok"), 1000, "read")).toBe("ok");
    expect(await withDeadlineOrThrow(Promise.resolve(undefined), 1000, "read")).toBeUndefined();
  });

  it("throws when the work outlasts its deadline, naming what stalled", async () => {
    const { withDeadlineOrThrow, DeadlineError } = await import("./transfer");
    const never = new Promise<string>(() => {});
    await expect(withDeadlineOrThrow(never, 20, "thumbnail")).rejects.toBeInstanceOf(DeadlineError);
    await expect(withDeadlineOrThrow(never, 20, "thumbnail")).rejects.toThrow(/thumbnail/);
  });

  it("lets the underlying failure through untouched", async () => {
    const { withDeadlineOrThrow } = await import("./transfer");
    await expect(
      withDeadlineOrThrow(Promise.reject(new Error("network gone")), 1000, "download"),
    ).rejects.toThrow("network gone");
  });
});

describe("a reading that finds nothing", () => {
  it("is recorded in metadata so no sweep re-reads the file forever", async () => {
    const { recognizeImage } = await import("./intel/ocr");
    const { analyzeFile } = await import("./transfer");
    vi.mocked(recognizeImage).mockResolvedValueOnce(undefined);
    const photo = new File([new Uint8Array([1, 2, 3])], "p.png", { type: "image/png" });
    const prepared = await analyzeFile(photo);
    expect(prepared.meta.hasText).toBeUndefined();
    expect(prepared.meta.noText).toBe(true);

    // Deferred analysis never ran the reader, so it must NOT claim one
    // happened: the sweep still owes this file its first reading.
    const deferred = await analyzeFile(photo, undefined, undefined, { defer: true });
    expect(deferred.meta.noText).toBeUndefined();
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
