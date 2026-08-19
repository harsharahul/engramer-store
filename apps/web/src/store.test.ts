import { beforeAll, describe, expect, it, vi } from "vitest";
import { encryptFileMetadata, generateKey, ready, secretBoxSeal } from "@engramer/crypto";
import type { PreparedFile } from "./transfer";
import type { FileDto } from "./api";

const gauge = vi.hoisted(() => ({
  running: 0,
  peak: 0,
  analyzeOpts: [] as (undefined | { defer?: boolean })[],
}));

const rig = vi.hoisted(() => ({
  blobPuts: [] as string[],
  thumbAttempts: 0,
  stampedSourceIds: [] as (string | undefined)[],
}));

vi.mock("./api", async (importOriginal) => {
  const original = await importOriginal<typeof import("./api")>();
  return {
    ...original,
    uploadBlob: async (id: string, kind: string, bytes: Uint8Array) => {
      rig.blobPuts.push(`${kind}:${id}`);
      return bytes.length;
    },
  };
});

vi.mock("./transfer", async (importOriginal) => {
  const original = await importOriginal<typeof import("./transfer")>();
  return {
    ...original,
    analyzeFile: async (
      file: File,
      _signal?: AbortSignal,
      _onPhase?: (phase: string) => void,
      opts?: { defer?: boolean },
    ): Promise<PreparedFile> => {
      gauge.analyzeOpts.push(opts);
      gauge.running++;
      gauge.peak = Math.max(gauge.peak, gauge.running);
      await new Promise((resolve) => setTimeout(resolve, 25));
      gauge.running--;
      return {
        meta: { name: file.name, mime: "image/jpeg", size: file.size, mtime: 1 },
        analysis: { category: "Photos", tags: [] },
        thumbnail: null,
      };
    },
    makeThumbnail: async (_file: File, mime: string) => {
      rig.thumbAttempts++;
      return mime.startsWith("image/")
        ? { bytes: new Uint8Array(9), width: 100, height: 80, blur: "bl" }
        : null;
    },
    downloadAndDecrypt: async () => new Uint8Array(16),
    encryptAndUpload: async (
      file: File,
      folderId: string | null,
      masterKey: Uint8Array,
      prepared: PreparedFile,
    ) => {
      rig.stampedSourceIds.push(prepared.meta.sourceId);
      const fileKey = generateKey();
      const dto: FileDto = {
        id: `up-${file.name}`,
        folderId,
        encryptedKey: secretBoxSeal(fileKey, masterKey),
        encryptedMeta: encryptFileMetadata(prepared.meta, fileKey),
        size: file.size,
        thumbSize: 0,
        indexSize: 0,
        uploaded: true,
        trashed: false,
        deleted: false,
        updateSeq: 1,
        createdAt: 1,
        updatedAt: 1,
      };
      return { dto, fileKey, meta: prepared.meta };
    },
  };
});

vi.mock("./intel/semantic", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./intel/semantic")>()),
  embedImage: async () => new Float32Array([0.5, 0.5, 0.5, 0.5]),
}));

vi.mock("./intel/ocr", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./intel/ocr")>()),
  recognizeImage: async () => undefined,
}));

import { api } from "./api";
import {
  clipComparable,
  metadataOf,
  needsClip,
  needsText,
  needsThumb,
  pendingDerivatives,
  useStore,
  type FileEntry,
} from "./store";

/**
 * Metadata is rebuilt from the in-memory entry on every patch, so anything
 * metadataOf forgets is destroyed the next time a file is renamed, tagged or
 * favorited. These tests exist because that is silent: nothing fails, the file
 * still opens, and the loss is only visible much later when a check that
 * needed the missing field cannot run.
 */

const entry = (over: Partial<FileEntry> = {}): FileEntry => ({
  id: "f1",
  folderId: null,
  name: "passport.pdf",
  mime: "application/pdf",
  size: 1024,
  mtime: 1_700_000_000_000,
  hasText: false,
  hasClip: false,
  inlineText: false,
  tags: ["documents"],
  facts: [],
  favorite: false,
  key: new Uint8Array(32),
  hasThumb: false,
  trashed: false,
  createdAt: 1,
  updatedAt: 2,
  ...over,
});

describe("metadataOf", () => {
  it("keeps the content digest, which a patch would otherwise erase", () => {
    const digest = "b1946ac92492d2347c6235b4d2611184";
    expect(metadataOf(entry({ digest })).digest).toBe(digest);
  });

  it("keeps the facts read out of the file", () => {
    const facts = [
      {
        id: "f1:expiry:2029-03-12",
        kind: "expiry" as const,
        document: "passport" as const,
        value: "2029-03-12",
        source: "mrz" as const,
        confidence: 1,
        confirmed: true,
      },
    ];
    expect(metadataOf(entry({ facts })).facts).toEqual(facts);
  });

  it("writes no facts field at all for a file that carries none", () => {
    expect(metadataOf(entry())).not.toHaveProperty("facts");
  });

  it("keeps the embedding model version, which a patch would otherwise erase", () => {
    expect(metadataOf(entry({ hasClip: true, clipVersion: 3 })).clipVersion).toBe(3);
    expect(metadataOf(entry({}))).not.toHaveProperty("clipVersion");
  });

  it("keeps the backup source id, which a patch would otherwise erase", () => {
    expect(metadataOf(entry({ sourceId: "asset-99" })).sourceId).toBe("asset-99");
  });

  it("writes no sourceId for a file never backed up from the library", () => {
    expect(metadataOf(entry())).not.toHaveProperty("sourceId");
  });

  it("still carries the fields it always did", () => {
    const meta = metadataOf(entry({ category: "Documents", favorite: true }));
    expect(meta).toMatchObject({
      name: "passport.pdf",
      mime: "application/pdf",
      category: "Documents",
      tags: ["documents"],
      favorite: true,
    });
  });
});

/**
 * A multi-photo pick from a phone is the common upload, and its wall-clock
 * time is the per-file pipeline times the batch when nothing overlaps. The
 * folder path has had a bounded pool from the start; this holds the plain
 * file path to the same standard.
 */
describe("uploadFiles", () => {
  beforeAll(async () => {
    await ready();
  });

  it("overlaps the per-file pipelines instead of uploading one at a time", async () => {
    useStore.setState({
      session: {
        email: "t@example.com",
        token: "t",
        masterKey: generateKey(),
        privateKey: new Uint8Array(32),
        publicKey: "",
      },
      refreshUsage: async () => {},
    });
    const files = Array.from(
      { length: 6 },
      (_, i) => new File([new Uint8Array(64)], `p${i}.jpg`, { type: "image/jpeg" }),
    );
    await useStore.getState().uploadFiles(files, "folder-1");
    expect(gauge.peak).toBeGreaterThan(1);
    expect(gauge.peak).toBeLessThanOrEqual(4);
    expect(useStore.getState().files.size).toBe(6);
  });

  /**
   * A photo added by hand through the picker used to carry no library
   * identity, so the automatic backup re-uploaded it under another name.
   * The picker now says which asset each file came from; the stamp is what
   * the backup ledger keys on.
   */
  it("stamps a picked source's library id into its metadata", async () => {
    useStore.setState({
      session: {
        email: "t@example.com",
        token: "t",
        masterKey: generateKey(),
        privateKey: new Uint8Array(32),
        publicKey: "",
      },
      refreshUsage: async () => {},
    });
    rig.stampedSourceIds.length = 0;
    const picked = Object.assign(
      new File([new Uint8Array(8)], "IMG_7.HEIC", { type: "image/heic" }),
      { sourceId: "asset-77" },
    );
    const plain = new File([new Uint8Array(8)], "notes.txt", { type: "text/plain" });
    await useStore.getState().uploadFiles([picked, plain], "folder-1");
    expect(rig.stampedSourceIds).toContain("asset-77");
    expect(rig.stampedSourceIds).toContain(undefined);
  });
});

/**
 * Files can arrive without thumbnails: the iOS Files-app provider has no
 * way to make one, and nothing on the server ever can (the server never
 * sees pixels). Whichever signed-in device notices the gap fills it, so
 * these tests pin the sweep's contract: fill exactly the files that need
 * it, honor the phone's size cap, and never retry a file that failed.
 */
/**
 * Backed-up photos used to be stored under their export path (asset id
 * prefixed to the camera name). The one-shot tidy renames exactly those,
 * and nothing else: files without a stamp, files whose prefix is not
 * their own id, and the trash are all left alone.
 */
describe("tidyBackupNames", () => {
  it("renames only files whose stored name is their own export path", async () => {
    const renames: [string, string][] = [];
    const rows: FileEntry[] = [
      entry({
        id: "f1",
        name: "ASSET_1_L0_001-IMG_0042.HEIC",
        sourceId: "ASSET-1/L0/001",
      }),
      entry({ id: "f2", name: "IMG_0043.HEIC", sourceId: "ASSET-2/L0/001" }),
      entry({ id: "f3", name: "ASSET_9_L0_001-doc.pdf" }),
      entry({
        id: "f4",
        name: "ASSET_4_L0_001-IMG_0044.HEIC",
        sourceId: "ASSET-4/L0/001",
        trashed: true,
      }),
    ];
    useStore.setState({
      files: new Map(rows.map((f) => [f.id, f])),
      renameFile: async (id: string, name: string) => {
        renames.push([id, name]);
      },
    });
    const renamed = await useStore.getState().tidyBackupNames();
    expect(renamed).toBe(1);
    expect(renames).toEqual([["f1", "IMG_0042.HEIC"]]);
  });
});

describe("backfillThumbnails", () => {
  beforeAll(async () => {
    await ready();
  });

  const seed = (entries: FileEntry[]) => {
    const masterKey = generateKey();
    useStore.setState({
      session: {
        email: "t@example.com",
        token: "t",
        masterKey,
        privateKey: new Uint8Array(32),
        publicKey: "",
      },
      refreshUsage: async () => {},
      files: new Map(entries.map((e) => [e.id, e])),
    });
    const keys = new Map(entries.map((e) => [e.id, e.key]));
    (api as unknown as Record<string, unknown>).patchFile = async (
      id: string,
      patch: { encryptedMeta: FileDto["encryptedMeta"] },
    ): Promise<FileDto> => ({
      id,
      folderId: null,
      encryptedKey: secretBoxSeal(keys.get(id)!, masterKey),
      encryptedMeta: patch.encryptedMeta,
      size: 16,
      // The thumbnail upload preceded this patch, so the reply's row
      // already counts it; hasThumb flips from this very response.
      thumbSize: 9,
      indexSize: 0,
      uploaded: true,
      trashed: false,
      deleted: false,
      updateSeq: 2,
      createdAt: 1,
      updatedAt: 2,
    });
    rig.blobPuts.length = 0;
    rig.thumbAttempts = 0;
  };

  it("stores a thumbnail, its dimensions and blur for an image that has none", async () => {
    seed([entry({ id: "img1", name: "roll.jpg", mime: "image/jpeg", hasThumb: false })]);
    const made = await useStore.getState().backfillThumbnails();
    expect(made).toBe(1);
    expect(rig.blobPuts).toEqual(["thumbnail:img1"]);
    const after = useStore.getState().files.get("img1")!;
    expect(after.hasThumb).toBe(true);
    expect(after.width).toBe(100);
    expect(after.height).toBe(80);
    expect(after.blur).toBe("bl");
  });

  it("skips non-candidates, honors the size cap, and never retries a failure", async () => {
    seed([
      entry({ id: "done", mime: "image/jpeg", hasThumb: true }),
      entry({ id: "gone", mime: "image/jpeg", trashed: true }),
      entry({ id: "doc", mime: "application/pdf" }),
      entry({ id: "huge", mime: "image/jpeg", size: 50 * 1024 * 1024 }),
      // The mock cannot thumbnail a video, standing in for a codec the
      // web layer cannot decode: attempted once, then left alone.
      entry({ id: "clip", mime: "video/mp4" }),
    ]);
    const skip = new Set<string>();
    const made = await useStore
      .getState()
      .backfillThumbnails({ skip, maxBytes: 32 * 1024 * 1024 });
    expect(made).toBe(0);
    expect(rig.blobPuts).toEqual([]);
    expect(rig.thumbAttempts).toBe(1);
    expect(skip.has("clip")).toBe(true);

    const again = await useStore
      .getState()
      .backfillThumbnails({ skip, maxBytes: 32 * 1024 * 1024 });
    expect(again).toBe(0);
    expect(rig.thumbAttempts).toBe(1);
  });
});

/**
 * The scanner sweeps were built for a hand-invoked palette command; run
 * automatically they must remember what they already attempted, or one
 * stubborn file would be rescanned after every sync for as long as the
 * tab lives.
 */
describe("sweeps remember what they attempted", () => {
  beforeAll(async () => {
    await ready();
  });

  it("embedAllImages skips ids in the given set and records new attempts", async () => {
    const calls: string[] = [];
    const original = useStore.getState().embedFile;
    useStore.setState({
      files: new Map([["p1", entry({ id: "p1", mime: "image/jpeg", hasClip: false })]]),
      embedFile: async (id: string) => {
        calls.push(id);
        throw new Error("unreadable");
      },
    });
    try {
      const skip = new Set<string>();
      await useStore.getState().embedAllImages({ skip });
      expect(calls).toEqual(["p1"]);
      expect(skip.has("p1")).toBe(true);
      await useStore.getState().embedAllImages({ skip });
      expect(calls).toEqual(["p1"]);
    } finally {
      useStore.setState({ embedFile: original });
    }
  });

  it("recognizeAllImages skips ids in the given set and records new attempts", async () => {
    const calls: string[] = [];
    const original = useStore.getState().recognizeFile;
    useStore.setState({
      files: new Map([["s1", entry({ id: "s1", mime: "image/jpeg", hasText: false })]]),
      recognizeFile: async (id: string) => {
        calls.push(id);
        return false;
      },
    });
    try {
      const skip = new Set<string>();
      await useStore.getState().recognizeAllImages({ skip });
      expect(calls).toEqual(["s1"]);
      expect(skip.has("s1")).toBe(true);
      await useStore.getState().recognizeAllImages({ skip });
      expect(calls).toEqual(["s1"]);
    } finally {
      useStore.setState({ recognizeFile: original });
    }
  });

  it("scanLibraryForFacts skips ids in the given set and records new attempts", async () => {
    useStore.setState({
      files: new Map([
        ["d1", entry({ id: "d1", mime: "text/plain", text: "no dates in here", facts: [] })],
      ]),
    });
    const totals: number[] = [];
    const unsub = useStore.subscribe((s) => {
      if (s.ocrProgress) {
        totals.push(s.ocrProgress.total);
      }
    });
    const skip = new Set<string>();
    await useStore.getState().scanLibraryForFacts({ skip });
    expect(totals).toEqual([1]);
    expect(skip.has("d1")).toBe(true);
    totals.length = 0;
    await useStore.getState().scanLibraryForFacts({ skip });
    expect(totals).toEqual([]);
    unsub();
  });
});

/**
 * A running sweep must stop when asked: the file in hand finishes, the
 * rest wait for another day. Downloading someone's originals is not
 * something an app gets to insist on.
 */
describe("sweeps stop when asked", () => {
  const stopAfter = (n: number) => {
    let seen = 0;
    return {
      probe: () => seen >= n,
      count: () => seen++,
    };
  };

  it("backfillThumbnails stops between files", async () => {
    const gate = stopAfter(1);
    useStore.setState({
      files: new Map([
        ["t1", entry({ id: "t1", name: "a.jpg", mime: "image/jpeg" })],
        ["t2", entry({ id: "t2", name: "b.jpg", mime: "image/jpeg" })],
      ]),
      backfillThumbnail: async () => {
        gate.count();
        return true;
      },
    });
    const made = await useStore.getState().backfillThumbnails({ stop: gate.probe });
    expect(made).toBe(1);
  });

  it("recognizeAllImages stops between files", async () => {
    const gate = stopAfter(1);
    const original = useStore.getState().recognizeFile;
    useStore.setState({
      files: new Map([
        ["s1", entry({ id: "s1", name: "a.jpg", mime: "image/jpeg" })],
        ["s2", entry({ id: "s2", name: "b.jpg", mime: "image/jpeg" })],
      ]),
      recognizeFile: async () => {
        gate.count();
        return true;
      },
    });
    try {
      expect(await useStore.getState().recognizeAllImages({ stop: gate.probe })).toBe(1);
    } finally {
      useStore.setState({ recognizeFile: original });
    }
  });

  it("embedAllImages stops between files", async () => {
    const gate = stopAfter(1);
    const original = useStore.getState().embedFile;
    useStore.setState({
      files: new Map([
        ["e1", entry({ id: "e1", name: "a.jpg", mime: "image/jpeg", hasClip: false })],
        ["e2", entry({ id: "e2", name: "b.jpg", mime: "image/jpeg", hasClip: false })],
      ]),
      embedFile: async () => {
        gate.count();
        return true;
      },
    });
    try {
      expect(await useStore.getState().embedAllImages({ stop: gate.probe })).toBe(1);
    } finally {
      useStore.setState({ embedFile: original });
    }
  });

  it("scanLibraryForFacts stops between files", async () => {
    useStore.setState({
      files: new Map([
        ["d1", entry({ id: "d1", name: "a.txt", mime: "text/plain", text: "plain words" })],
        ["d2", entry({ id: "d2", name: "b.txt", mime: "text/plain", text: "plain words" })],
      ]),
    });
    const totals: number[] = [];
    const unsub = useStore.subscribe((s) => {
      if (s.ocrProgress) {
        totals.push(s.ocrProgress.done);
      }
    });
    let iterations = 0;
    await useStore.getState().scanLibraryForFacts({
      stop: () => iterations++ >= 1,
    });
    unsub();
    // Two candidates, one iteration before the stop was honored.
    expect(totals).toEqual([0]);
  });
});

/**
 * Meaning vectors from different models are not comparable: a cosine
 * between them is noise that ranks with confidence. Every embedding
 * therefore carries the version of the model that made it, the sweep
 * re-opens files whose version lags, and search only compares vectors the
 * current model can answer for. Absence reads as version 1: everything
 * stored before the tag existed came from the first model.
 */
describe("embedding model version", () => {
  it("needsClip re-opens files without a vector or with a stale one", () => {
    const image = (over: Partial<FileEntry>) => entry({ mime: "image/jpeg", ...over });
    expect(needsClip(image({ hasClip: false }), 1)).toBe(true);
    expect(needsClip(image({ hasClip: true }), 1)).toBe(false);
    expect(needsClip(image({ hasClip: true }), 2)).toBe(true);
    expect(needsClip(image({ hasClip: true, clipVersion: 2 }), 2)).toBe(false);
    expect(needsClip(image({ hasClip: true, trashed: true }), 2)).toBe(false);
    // A video embeds from its stored poster frame; without one there is
    // nothing to embed yet.
    expect(needsClip(entry({ mime: "video/mp4", hasThumb: false }), 1)).toBe(false);
    expect(needsClip(entry({ mime: "video/mp4", hasThumb: true }), 1)).toBe(true);
    expect(needsClip(entry({ mime: "application/pdf" }), 1)).toBe(false);
  });

  it("needsThumb wants exactly the untrashed media without a preview", () => {
    expect(needsThumb(entry({ mime: "image/jpeg", hasThumb: false }))).toBe(true);
    expect(needsThumb(entry({ mime: "video/mp4", hasThumb: false }))).toBe(true);
    expect(needsThumb(entry({ mime: "image/jpeg", hasThumb: true }))).toBe(false);
    expect(needsThumb(entry({ mime: "image/jpeg", trashed: true }))).toBe(false);
    expect(needsThumb(entry({ mime: "application/pdf" }))).toBe(false);
  });

  it("needsText wants exactly the unread images and scannable PDFs", () => {
    expect(needsText(entry({ mime: "image/jpeg", hasText: false }))).toBe(true);
    expect(needsText(entry({ name: "scan.pdf", mime: "application/pdf", hasText: false }))).toBe(
      true,
    );
    expect(needsText(entry({ mime: "image/jpeg", hasText: true }))).toBe(false);
    // Read once with nothing found is DONE, not forever-pending: without
    // this, every ordinary photo counts as unfinished work for all time.
    expect(needsText(entry({ mime: "image/jpeg", noText: true }))).toBe(false);
    expect(needsText(entry({ mime: "image/jpeg", trashed: true }))).toBe(false);
    expect(needsText(entry({ name: "notes.txt", mime: "text/plain" }))).toBe(false);
  });

  it("a reading that finds nothing is recorded, so the file leaves the queue", async () => {
    await ready();
    const masterKey = generateKey();
    const file = entry({ id: "r1", name: "sunset.jpg", mime: "image/jpeg", key: generateKey() });
    useStore.setState({
      session: {
        email: "t@example.com",
        token: "t",
        masterKey,
        privateKey: new Uint8Array(32),
        publicKey: "",
      },
      refreshUsage: async () => {},
      files: new Map([[file.id, file]]),
    });
    (api as unknown as Record<string, unknown>).patchFile = async (
      id: string,
      patch: { encryptedMeta: FileDto["encryptedMeta"] },
    ): Promise<FileDto> => ({
      id,
      folderId: null,
      encryptedKey: secretBoxSeal(file.key, masterKey),
      encryptedMeta: patch.encryptedMeta,
      size: 16,
      thumbSize: 0,
      indexSize: 0,
      uploaded: true,
      trashed: false,
      deleted: false,
      updateSeq: 2,
      createdAt: 1,
      updatedAt: 2,
    });
    expect(await useStore.getState().recognizeFile("r1")).toBe(false);
    const after = useStore.getState().files.get("r1")!;
    expect(after.noText).toBe(true);
    expect(needsText(after)).toBe(false);
  });

  it("pendingDerivatives counts what each sweep still has to do", () => {
    const files = new Map<string, FileEntry>(
      (
        [
          entry({ id: "a", mime: "image/jpeg", hasThumb: false, hasText: false, hasClip: false }),
          entry({ id: "b", mime: "image/jpeg", hasThumb: true, hasText: true, hasClip: true }),
          entry({ id: "c", name: "scan.pdf", mime: "application/pdf", hasText: false }),
          entry({ id: "d", name: "clip.mp4", mime: "video/mp4", hasThumb: false, hasClip: false }),
          entry({ id: "e", mime: "image/png", trashed: true }),
        ] as FileEntry[]
      ).map((f) => [f.id, f]),
    );
    // "a" needs all three; "c" needs text; "d" needs a thumb but cannot
    // embed until its poster frame exists; "b" is done; "e" is trash.
    expect(pendingDerivatives(files, 1)).toEqual({ thumbs: 2, text: 2, meaning: 1 });
    // A model bump re-opens the already-embedded file.
    expect(pendingDerivatives(files, 2)).toEqual({ thumbs: 2, text: 2, meaning: 2 });
  });

  /**
   * The automatic sweeps skip kinds whose preference is off, so a count
   * that includes them describes work nothing will ever take up. With
   * reading and meaning off by default, every deferred backup photo read
   * as a permanently pending queue the size of the library.
   */
  it("pendingDerivatives excludes kinds whose sweep is turned off", () => {
    const files = new Map<string, FileEntry>(
      (
        [
          entry({ id: "a", mime: "image/jpeg", hasThumb: false, hasText: false, hasClip: false }),
          entry({ id: "c", name: "scan.pdf", mime: "application/pdf", hasText: false }),
        ] as FileEntry[]
      ).map((f) => [f.id, f]),
    );
    expect(pendingDerivatives(files, 1, { ocr: false, semantic: true })).toEqual({
      thumbs: 1,
      text: 0,
      meaning: 1,
    });
    expect(pendingDerivatives(files, 1, { ocr: true, semantic: false })).toEqual({
      thumbs: 1,
      text: 2,
      meaning: 0,
    });
  });

  it("clipComparable admits only vectors from the current model", () => {
    const clip = new Float32Array(4);
    expect(clipComparable(entry({ hasClip: true, clip }), 1)).toBe(true);
    expect(clipComparable(entry({ hasClip: true, clip, clipVersion: 1 }), 2)).toBe(false);
    expect(clipComparable(entry({ hasClip: true, clip, clipVersion: 2 }), 2)).toBe(true);
    expect(clipComparable(entry({ hasClip: true }), 1)).toBe(false);
  });

  it("embedFile stamps the model version into metadata", async () => {
    await ready();
    const masterKey = generateKey();
    const file = entry({ id: "v1", mime: "image/jpeg", hasClip: false, key: generateKey() });
    useStore.setState({
      session: {
        email: "t@example.com",
        token: "t",
        masterKey,
        privateKey: new Uint8Array(32),
        publicKey: "",
      },
      refreshUsage: async () => {},
      files: new Map([[file.id, file]]),
    });
    (api as unknown as Record<string, unknown>).patchFile = async (
      id: string,
      patch: { encryptedMeta: FileDto["encryptedMeta"] },
    ): Promise<FileDto> => ({
      id,
      folderId: null,
      encryptedKey: secretBoxSeal(file.key, masterKey),
      encryptedMeta: patch.encryptedMeta,
      size: 16,
      thumbSize: 0,
      indexSize: 9,
      uploaded: true,
      trashed: false,
      deleted: false,
      updateSeq: 2,
      createdAt: 1,
      updatedAt: 2,
    });
    expect(await useStore.getState().embedFile("v1")).toBe(true);
    const after = useStore.getState().files.get("v1")!;
    expect(after.hasClip).toBe(true);
    expect(after.clipVersion).toBe(1);
  });
});

/**
 * A backup pass wants the photo on the server, not fully understood: the
 * heavy scanners run later, from whichever signed-in device picks the file
 * up. If backup ever ran them inline again, every photo would pay seconds
 * of OCR and embedding before its first byte went out.
 */
describe("backupAsset", () => {
  beforeAll(async () => {
    await ready();
  });

  it("defers heavy analysis to the backfill sweeps", async () => {
    const folderKey = generateKey();
    useStore.setState({
      session: {
        email: "t@example.com",
        token: "t",
        masterKey: generateKey(),
        privateKey: new Uint8Array(32),
        publicKey: "",
      },
      refreshUsage: async () => {},
      folders: new Map([
        [
          "camera-roll",
          {
            id: "camera-roll",
            parentId: null,
            name: "Camera Roll",
            key: folderKey,
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      ]),
    });
    gauge.analyzeOpts.length = 0;
    const photo = new File([new Uint8Array(64)], "roll.jpg", { type: "image/jpeg" });
    await useStore.getState().backupAsset(photo, "asset-1");
    expect(gauge.analyzeOpts).toEqual([{ defer: true }]);
  });
});

describe("decryptSharedFile", () => {
  beforeAll(async () => {
    await ready();
  });

  it("opens the sealed key with the account key pair and marks the entry shared", async () => {
    const { generateKeyPair, sealToPublicKey, encryptFileMetadata: encMeta } = await import(
      "@engramer/crypto"
    );
    const { decryptSharedFile } = await import("./store");
    const pair = generateKeyPair();
    const session = {
      email: "r@example.com",
      token: "t",
      masterKey: generateKey(),
      privateKey: pair.privateKey,
      publicKey: pair.publicKey,
    };
    const fileKey = generateKey();
    const dto = {
      id: "sf1",
      folderId: null as null,
      encryptedMeta: encMeta(
        { name: "team.docx", mime: "application/pdf", size: 9, mtime: 5 },
        fileKey,
      ),
      size: 9,
      thumbSize: 0,
      indexSize: 0,
      uploaded: true,
      updateSeq: 3,
      createdAt: 1,
      updatedAt: 2,
      ownerEmail: "owner@example.com",
      role: "editor" as const,
      sealedKey: sealToPublicKey(fileKey, pair.publicKey),
      keyEpoch: 0,
      revoked: false,
    };
    const entry = decryptSharedFile(dto, session);
    expect(entry.name).toBe("team.docx");
    expect(entry.shared).toBe(true);
    expect(entry.role).toBe("editor");
    expect(entry.ownerEmail).toBe("owner@example.com");
    expect(entry.folderId).toBeNull();
    expect(entry.key).toEqual(fileKey);
  });

  it("keeps metadataOf byte-preserving for a shared entry", async () => {
    const meta = metadataOf(
      entry({ shared: true, role: "viewer", ownerEmail: "o@example.com" } as Partial<FileEntry>),
    );
    expect(meta.name).toBe("passport.pdf");
    // Share bookkeeping lives in the membership row, never inside the
    // encrypted metadata, which stays exactly the owner's document.
    expect(meta).not.toHaveProperty("role");
    expect(meta).not.toHaveProperty("ownerEmail");
  });
});

/**
 * A collaborator's save uploads bytes, then applies the server's reply.
 * That reply carries the OWNER's wrapped key, which the collaborator's
 * master key cannot open — so applying it must keep using the key the
 * share delivered. Caught live: the bytes landed and the editor still
 * reported "wrong secret key for the given ciphertext".
 */
describe("entryFromUpdate", () => {
  beforeAll(async () => {
    await ready();
  });

  it("keeps a shared entry's own key and share facts across an update", async () => {
    const { entryFromUpdate } = await import("./store");
    const { encryptFileMetadata: encMeta, secretBoxSeal: seal } = await import("@engramer/crypto");
    const ownerMaster = generateKey();
    const otherMaster = generateKey();
    const fileKey = generateKey();
    const prior = entry({
      id: "shared-1",
      key: fileKey,
      shared: true,
      role: "editor",
      ownerEmail: "owner@example.com",
      folderId: null,
    });
    const dto = {
      id: "shared-1",
      folderId: "owners-folder",
      // The owner's wrapping: opaque to this account.
      encryptedKey: seal(fileKey, ownerMaster),
      encryptedMeta: encMeta(
        { name: "coedit.docx", mime: "application/octet-stream", size: 42, mtime: 9 },
        fileKey,
      ),
      size: 42,
      thumbSize: 0,
      indexSize: 0,
      uploaded: true,
      trashed: false,
      deleted: false,
      updateSeq: 5,
      createdAt: 1,
      updatedAt: 9,
    };
    const updated = entryFromUpdate(prior, dto, otherMaster);
    expect(updated.name).toBe("coedit.docx");
    expect(updated.size).toBe(42);
    expect(updated.key).toEqual(fileKey);
    expect(updated.shared).toBe(true);
    expect(updated.role).toBe("editor");
    expect(updated.ownerEmail).toBe("owner@example.com");
    // The owner's tree is not this account's business.
    expect(updated.folderId).toBeNull();
  });

  it("still unwraps an owned file with the master key", async () => {
    const { entryFromUpdate } = await import("./store");
    const { encryptFileMetadata: encMeta, secretBoxSeal: seal } = await import("@engramer/crypto");
    const master = generateKey();
    const fileKey = generateKey();
    const dto = {
      id: "own-1",
      folderId: "f1",
      encryptedKey: seal(fileKey, master),
      encryptedMeta: encMeta(
        { name: "mine.docx", mime: "application/octet-stream", size: 7, mtime: 3 },
        fileKey,
      ),
      size: 7,
      thumbSize: 0,
      indexSize: 0,
      uploaded: true,
      trashed: false,
      deleted: false,
      updateSeq: 2,
      createdAt: 1,
      updatedAt: 3,
    };
    const updated = entryFromUpdate(undefined, dto, master);
    expect(updated.name).toBe("mine.docx");
    expect(updated.folderId).toBe("f1");
    expect(updated.shared).toBeUndefined();
  });
});

describe("albums in the store", () => {
  beforeAll(async () => {
    await ready();
  });

  /**
   * Seeds the store with real-crypto files and stubs api.patchFile to echo
   * the encrypted metadata straight back, so every assertion below reads
   * what would actually have been stored, after the full seal/open cycle.
   * The stub also measures overlap: album writes must stay sequential,
   * because each one rewrites the whole metadata blob last-write-wins.
   */
  const setup = (tagsById: Record<string, string[]>) => {
    const masterKey = generateKey();
    const keys = new Map<string, Uint8Array>();
    const files = new Map<string, FileEntry>();
    for (const [id, tags] of Object.entries(tagsById)) {
      const key = generateKey();
      keys.set(id, key);
      files.set(id, entry({ id, tags, key, mtime: 5 }));
    }
    useStore.setState({
      session: {
        email: "t@example.com",
        token: "t",
        masterKey,
        privateKey: new Uint8Array(32),
        publicKey: "",
      },
      files,
    });
    const gauge = { order: [] as string[], running: 0, peak: 0 };
    let seq = 100;
    const spy = vi.spyOn(api, "patchFile").mockImplementation(async (id, patch) => {
      gauge.order.push(id);
      gauge.running++;
      gauge.peak = Math.max(gauge.peak, gauge.running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      gauge.running--;
      return {
        id,
        folderId: null,
        encryptedKey: secretBoxSeal(keys.get(id)!, masterKey),
        encryptedMeta: patch.encryptedMeta!,
        size: 1,
        thumbSize: 0,
        indexSize: 0,
        uploaded: true,
        trashed: false,
        deleted: false,
        updateSeq: seq++,
        createdAt: 1,
        updatedAt: 2,
      } satisfies FileDto;
    });
    return { gauge, spy, tagsOf: (id: string) => useStore.getState().files.get(id)!.tags };
  };

  it("addToAlbum tags every member one write at a time and skips existing members", async () => {
    const { gauge, spy, tagsOf } = setup({
      a: ["sunny"],
      b: ["album:beach"],
      c: [],
    });
    await useStore.getState().addToAlbum(["a", "b", "c"], "album:beach");
    expect(tagsOf("a")).toEqual(["sunny", "album:beach"]);
    expect(tagsOf("c")).toEqual(["album:beach"]);
    expect(gauge.order).toEqual(["a", "c"]);
    expect(gauge.peak).toBe(1);
    spy.mockRestore();
  });

  it("setTags refuses hand-typed reserved tags but keeps existing membership", async () => {
    const { spy, tagsOf } = setup({ a: ["album:beach", "sunny"] });
    await useStore.getState().setTags("a", ["sunny", "warm", "album:forged", "trip:fake-2026-01"]);
    expect(tagsOf("a")).toEqual(["sunny", "warm", "album:beach"]);
    spy.mockRestore();
  });

  it("renameAlbum retags every member and returns the new tag", async () => {
    const { gauge, spy, tagsOf } = setup({
      a: ["album:beach", "sunny"],
      b: ["album:beach"],
      c: ["album:city"],
    });
    const next = await useStore.getState().renameAlbum("album:beach", "Beach Trip");
    expect(next).toBe("album:beach-trip");
    expect(tagsOf("a")).toEqual(["album:beach-trip", "sunny"]);
    expect(tagsOf("b")).toEqual(["album:beach-trip"]);
    expect(tagsOf("c")).toEqual(["album:city"]);
    expect(gauge.peak).toBe(1);
    spy.mockRestore();
  });

  it("deleteAlbum strips the tag and keeps the files", async () => {
    const { spy, tagsOf } = setup({ a: ["album:beach", "sunny"], b: ["album:beach"] });
    await useStore.getState().deleteAlbum("album:beach");
    expect(tagsOf("a")).toEqual(["sunny"]);
    expect(tagsOf("b")).toEqual([]);
    expect(useStore.getState().files.size).toBe(2);
    spy.mockRestore();
  });

  it("confirmed trips dedupe their tag on a second confirmation", async () => {
    const { spy, tagsOf } = setup({ a: ["trip:rome-2026-03"] });
    await useStore.getState().addToAlbum(["a"], "album:rome");
    await useStore.getState().addToAlbum(["a"], "album:rome");
    expect(tagsOf("a")).toEqual(["trip:rome-2026-03", "album:rome"]);
    spy.mockRestore();
  });
});
