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

    // Newer generation: the entry is what lags; the bytes decrypted under
    // the file key, which authenticates them.
    const ahead = await downloadContent("f1", key, staleDigest, { newerThan: 5 });
    expect(ahead.generation).toBe(7);
    expect(ahead.bytes).toEqual(current);

    // Same generation with a wrong digest is real damage, not lag.
    await expect(
      downloadContent("f1", key, staleDigest, { newerThan: 7 }),
    ).rejects.toBeInstanceOf(IntegrityError);

    // Without a stated baseline the check stays exactly as strict.
    await expect(downloadContent("f1", key, staleDigest)).rejects.toBeInstanceOf(IntegrityError);
  });
});
