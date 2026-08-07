import { beforeAll, describe, expect, it, vi } from "vitest";
import { encryptFileMetadata, generateKey, ready, secretBoxSeal } from "@engramer/crypto";
import type { PreparedFile } from "./transfer";
import type { FileDto } from "./api";

const gauge = vi.hoisted(() => ({ running: 0, peak: 0 }));

vi.mock("./transfer", async (importOriginal) => {
  const original = await importOriginal<typeof import("./transfer")>();
  return {
    ...original,
    analyzeFile: async (file: File): Promise<PreparedFile> => {
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
    encryptAndUpload: async (
      file: File,
      folderId: string | null,
      masterKey: Uint8Array,
      prepared: PreparedFile,
    ) => {
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

import { metadataOf, useStore, type FileEntry } from "./store";

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
