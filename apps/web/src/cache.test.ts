import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import type { FileDto, FolderDto, SyncResponse } from "./api";
import { clearCache, loadCache, storeSyncRows } from "./cache";

const box = { ciphertext: "AAAA", nonce: "BBBB" };

function folderDto(id: string, updateSeq: number, deleted = false): FolderDto {
  return {
    id,
    parentId: null,
    encryptedKey: box,
    encryptedMeta: box,
    deleted,
    updateSeq,
    createdAt: 1,
    updatedAt: 1,
  };
}

function fileDto(id: string, updateSeq: number, over: Partial<FileDto> = {}): FileDto {
  return {
    id,
    folderId: null,
    encryptedKey: box,
    encryptedMeta: box,
    size: 10,
    thumbSize: 0,
    indexSize: 0,
    uploaded: true,
    trashed: false,
    deleted: false,
    updateSeq,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

function response(seq: number, folders: FolderDto[] = [], files: FileDto[] = []): SyncResponse {
  return { seq, folders, files };
}

// Each test uses its own account so nothing bleeds between them.
let n = 0;
const account = () => `user-${++n}@example.com`;

describe("library cache", () => {
  it("returns null when nothing has been cached", async () => {
    expect(await loadCache(account())).toBeNull();
  });

  it("round-trips rows and the sync cursor verbatim", async () => {
    const who = account();
    const folder = folderDto("folder-1", 3);
    const file = fileDto("file-1", 4, { size: 123, trashed: true });
    await storeSyncRows(who, response(5, [folder], [file]));
    const cached = await loadCache(who);
    expect(cached).not.toBeNull();
    expect(cached!.seq).toBe(5);
    expect(cached!.folders).toEqual([folder]);
    expect(cached!.files).toEqual([file]);
  });

  it("prunes a row when its tombstone arrives", async () => {
    const who = account();
    await storeSyncRows(who, response(2, [folderDto("folder-1", 1)], [fileDto("file-1", 2)]));
    await storeSyncRows(
      who,
      response(4, [folderDto("folder-1", 3, true)], [fileDto("file-1", 4, { deleted: true })]),
    );
    const cached = await loadCache(who);
    expect(cached!.seq).toBe(4);
    expect(cached!.folders).toEqual([]);
    expect(cached!.files).toEqual([]);
  });

  it("never lets an older response roll a row or the cursor back", async () => {
    const who = account();
    const newer = fileDto("file-1", 20, { size: 999 });
    await storeSyncRows(who, response(20, [], [newer]));
    // A second tab that fetched earlier writes later.
    await storeSyncRows(who, response(10, [], [fileDto("file-1", 10, { size: 1 })]));
    const cached = await loadCache(who);
    expect(cached!.seq).toBe(20);
    expect(cached!.files).toEqual([newer]);
  });

  it("rebuild leaves an exact mirror of the response", async () => {
    const who = account();
    await storeSyncRows(who, response(5, [folderDto("stale", 1)], [fileDto("gone", 2)]));
    const kept = fileDto("kept", 6);
    await storeSyncRows(who, response(6, [], [kept]), true);
    const cached = await loadCache(who);
    expect(cached!.seq).toBe(6);
    expect(cached!.folders).toEqual([]);
    expect(cached!.files).toEqual([kept]);
  });

  it("keeps accounts fully separate", async () => {
    const first = account();
    const second = account();
    await storeSyncRows(first, response(3, [], [fileDto("mine", 3)]));
    expect(await loadCache(second)).toBeNull();
    await clearCache(second);
    expect((await loadCache(first))!.files).toHaveLength(1);
  });

  it("clearCache removes everything for the account", async () => {
    const who = account();
    await storeSyncRows(who, response(3, [folderDto("folder-1", 3)], []));
    await clearCache(who);
    expect(await loadCache(who)).toBeNull();
  });
});
