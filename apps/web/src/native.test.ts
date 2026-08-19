import { afterEach, describe, expect, it } from "vitest";
import { fileBytes, mimeFromName, pickPhotos } from "./native";
import { NativePickedFile } from "./nativefile";

/**
 * Files from the shell's picker arrive as bytes and a name, with no type:
 * it hands over paths, not browser `File`s. Downstream everything branches
 * on the mime, so the name has to supply it. HEIC is recovered later by
 * normalizeImageMime, but nothing recovers a video, and a typeless .mov
 * would upload as an unplayable blob.
 */
describe("mimeFromName", () => {
  it("names the formats an iPhone library actually holds", () => {
    expect(mimeFromName("IMG_0001.HEIC")).toBe("image/heic");
    expect(mimeFromName("IMG_0002.jpg")).toBe("image/jpeg");
    expect(mimeFromName("IMG_0003.PNG")).toBe("image/png");
    expect(mimeFromName("IMG_0004.mov")).toBe("video/quicktime");
    expect(mimeFromName("IMG_0005.mp4")).toBe("video/mp4");
  });

  it("says nothing rather than guessing wrong", () => {
    // An empty type is honest and recoverable; a wrong one is neither.
    expect(mimeFromName("notes")).toBe("");
    expect(mimeFromName("archive.zzz")).toBe("");
  });
});

/**
 * The shell boundary carries no types: values arrive as JSON from another
 * process, and the old code asserted an ArrayBuffer rather than converting
 * to one. What actually arrives is an array of byte values, and
 * `new Blob([array])` does not complain, it stringifies. Every file a
 * watched folder uploaded became the text "37,80,68,70,..." at three and a
 * half times its size, and nothing noticed for months.
 */
describe("fileBytes", () => {
  const pdf = [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34];

  it("converts the array of byte values the shell actually sends", () => {
    const bytes = fileBytes(pdf);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect([...bytes]).toEqual(pdf);
  });

  it("keeps the bytes a file would be built from identical", () => {
    // The failure was silent because a Blob accepts both and only one is
    // the file: the array stringifies, the bytes do not.
    const asBytes = fileBytes(pdf);
    expect(new Blob([asBytes.slice().buffer as ArrayBuffer]).size).toBe(pdf.length);
    expect(new Blob([pdf as unknown as BlobPart]).size).toBeGreaterThan(pdf.length);
  });

  it("passes through what is already binary", () => {
    const view = new Uint8Array(pdf);
    expect(fileBytes(view)).toBe(view);
    expect([...fileBytes(view.buffer)]).toEqual(pdf);
  });

  it("refuses anything that is not file content", () => {
    expect(() => fileBytes(null)).toThrow();
    expect(() => fileBytes("not bytes")).toThrow();
    expect(() => fileBytes({ nope: true })).toThrow();
  });
});

/**
 * The picker's byte bridge is what killed the app on large videos: the
 * old whole-file read serialized entire clips through the IPC. These pin
 * the gate: no streaming shell, no native picker (the file input is the
 * crash-free fallback), and a streaming shell hands back handles that
 * move no bytes at all.
 */
describe("pickPhotos", () => {
  const shim = (invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>) => {
    (globalThis as { window?: unknown }).window = { __TAURI__: { core: { invoke } } };
  };
  const calls: string[] = [];

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
    calls.length = 0;
  });

  it("uses the file input when the shell cannot stream", async () => {
    shim(async (cmd) => {
      calls.push(cmd);
      throw new Error(`${cmd} not allowed`);
    });
    expect(await pickPhotos()).toBeNull();
    expect(calls).toEqual(["picked_probe"]);
  });

  it("hands back streamed handles carrying library ids, moving no bytes", async () => {
    shim(async (cmd) => {
      calls.push(cmd);
      if (cmd === "picked_probe") return true;
      if (cmd === "pick_photos_with_ids")
        return [
          { path: "/tmp/engram-picked/IMG_1.HEIC", id: "asset-1" },
          { path: "/tmp/engram-picked/clip.mov", id: null },
        ];
      if (cmd === "picked_file_stat") return { size: 42, mtime_ms: 5 };
      throw new Error(`unexpected ${cmd}`);
    });
    const picked = await pickPhotos();
    expect(picked).toHaveLength(2);
    expect(picked![0]).toBeInstanceOf(NativePickedFile);
    expect(picked![0]!.size).toBe(42);
    expect(picked![0]!.sourceId).toBe("asset-1");
    expect(picked![1]!.sourceId).toBeUndefined();
    expect(picked![1]!.type).toBe("video/quicktime");
    expect(calls).not.toContain("picked_file_read");
  });

  it("falls back to path-only picking on a shell without identities", async () => {
    shim(async (cmd) => {
      calls.push(cmd);
      if (cmd === "picked_probe") return true;
      if (cmd === "pick_photos_with_ids") throw new Error("not allowed");
      if (cmd === "pick_photos") return ["/tmp/engram-picked/IMG_2.HEIC"];
      if (cmd === "picked_file_stat") return { size: 7 };
      throw new Error(`unexpected ${cmd}`);
    });
    const picked = await pickPhotos();
    expect(picked).toHaveLength(1);
    expect(picked![0]!.sourceId).toBeUndefined();
    expect(picked![0]!.size).toBe(7);
  });
});

/**
 * Watched folders on the Mac read every new file whole through the same
 * bridge, bounded only by a size cap whose comment admitted the shortcut.
 * A streaming shell hands back the same bounded-window handles the picker
 * uses; an old shell answers null and the caller keeps its capped read.
 */
describe("watchedStreamedFile", () => {
  const shim = (invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>) => {
    (globalThis as { window?: unknown }).window = { __TAURI__: { core: { invoke } } };
  };

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  const watched = { path: "/Users/me/Watched/clip.mov", name: "clip.mov", size: 64, mtime: 5 };

  it("hands back a watched-family handle from a streaming shell", async () => {
    shim(async (cmd, args) => {
      if (cmd === "watched_file_stat") return { size: 64, mtime_ms: 5 };
      if (cmd === "watched_file_read_range")
        return new Uint8Array((args?.length as number) ?? 0);
      throw new Error(`unexpected ${cmd}`);
    });
    const { watchedStreamedFile } = await import("./native");
    const source = await watchedStreamedFile(watched);
    expect(source).toBeInstanceOf(NativePickedFile);
    expect(source!.size).toBe(64);
    expect(source!.mediaUrl).toContain("picked://localhost/watched?p=");
    expect(new Uint8Array(await source!.slice(0, 8).arrayBuffer()).length).toBe(8);
  });

  it("answers null on a shell without the ranged commands", async () => {
    shim(async () => {
      throw new Error("not allowed");
    });
    const { watchedStreamedFile } = await import("./native");
    expect(await watchedStreamedFile(watched)).toBeNull();
  });
});

/**
 * The offline store is the shell's disk copy of a file's ciphertext.
 * A complete copy opens with no network at all; anything less answers
 * null so the caller fetches from the server exactly as before. Every
 * failure is a null too: an old shell without the commands has to look
 * identical to an empty store, never break an open.
 */
describe("offline bridge", () => {
  const shim = (invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>) => {
    (globalThis as { window?: unknown }).window = { __TAURI__: { core: { invoke } } };
    (globalThis as { location?: unknown }).location = { origin: "https://store.example" };
  };

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
    delete (globalThis as { location?: unknown }).location;
  });

  it("hands back a complete file's ciphertext as bytes", async () => {
    shim(async (cmd, args) => {
      if (cmd === "offline_read" && args?.fileId === "f1") return [1, 2, 3];
      throw new Error(`unexpected ${cmd}`);
    });
    const { nativeOfflineRead } = await import("./native");
    const bytes = await nativeOfflineRead("f1");
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect([...bytes!]).toEqual([1, 2, 3]);
  });

  it("answers null when the file is not fully local", async () => {
    shim(async () => {
      throw new Error("that file is not fully local");
    });
    const { nativeOfflineRead } = await import("./native");
    expect(await nativeOfflineRead("f1")).toBeNull();
  });

  it("answers null outside the shell", async () => {
    (globalThis as { window?: unknown }).window = {};
    const { nativeOfflineRead } = await import("./native");
    expect(await nativeOfflineRead("f1")).toBeNull();
  });

  it("pins with the key encoded the way the media path sends it", async () => {
    const seen: Record<string, unknown>[] = [];
    shim(async (cmd, args) => {
      if (cmd === "offline_pin") {
        seen.push(args!);
        return null;
      }
      throw new Error(`unexpected ${cmd}`);
    });
    const { nativeOfflinePin } = await import("./native");
    const key = new Uint8Array(32).fill(7);
    const ok = await nativeOfflinePin({ id: "f1", key, digest: "d1" }, "tok");
    expect(ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.fileId).toBe("f1");
    expect(seen[0]!.token).toBe("tok");
    expect(seen[0]!.base).toBe("https://store.example");
    expect(seen[0]!.digest).toBe("d1");
    const sent = Uint8Array.from(atob(seen[0]!.key as string), (c) => c.charCodeAt(0));
    expect([...sent]).toEqual([...key]);
  });

  it("reports a failed pin as false rather than breaking the caller", async () => {
    shim(async () => {
      throw new Error("no space");
    });
    const { nativeOfflinePin } = await import("./native");
    expect(await nativeOfflinePin({ id: "f1", key: new Uint8Array(32) }, "tok")).toBe(false);
  });

  it("lists the store's entries, or nothing outside the shell", async () => {
    shim(async (cmd) => {
      if (cmd === "offline_status")
        return [{ fileId: "f1", pinned: true, complete: true, bytes: 9 }];
      throw new Error(`unexpected ${cmd}`);
    });
    const { nativeOfflineStatus } = await import("./native");
    expect(await nativeOfflineStatus()).toEqual([
      { fileId: "f1", pinned: true, complete: true, bytes: 9 },
    ]);
    (globalThis as { window?: unknown }).window = {};
    expect(await nativeOfflineStatus()).toEqual([]);
  });

  it("clears the unpinned cache and names the bytes freed", async () => {
    shim(async (cmd) => {
      if (cmd === "offline_clear_cache") return 4096;
      throw new Error(`unexpected ${cmd}`);
    });
    const { nativeOfflineClearCache } = await import("./native");
    expect(await nativeOfflineClearCache()).toBe(4096);
  });
});

/**
 * Export replaces save-to-Downloads: the shell streams the ciphertext
 * down, decrypts file to file, then presents the share sheet, where the
 * person chooses where the plaintext goes. Old shells without the
 * command answer null so the in-page path still works; a shell that HAS
 * the command but fails throws, because retrying a large file in-page
 * is the crash this path exists to end.
 */
describe("nativeExportFile", () => {
  const shim = (invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>) => {
    (globalThis as { window?: unknown }).window = { __TAURI__: { core: { invoke } } };
    (globalThis as { location?: unknown }).location = { origin: "https://store.example" };
  };

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
    delete (globalThis as { location?: unknown }).location;
  });

  const file = { id: "f1", name: "clip.mov", key: new Uint8Array(32).fill(3), digest: "d1" };

  it("streams through the shell and answers the name the export landed under", async () => {
    const seen: Record<string, unknown>[] = [];
    shim(async (cmd, args) => {
      if (cmd === "file_export") {
        seen.push(args!);
        return "clip 2.mov";
      }
      throw new Error(`unexpected ${cmd}`);
    });
    const { nativeExportFile } = await import("./native");
    expect(await nativeExportFile(file, "tok")).toBe("clip 2.mov");
    expect(seen[0]!.fileId).toBe("f1");
    expect(seen[0]!.name).toBe("clip.mov");
    expect(seen[0]!.digest).toBe("d1");
  });

  it("answers null where the shell lacks the command", async () => {
    shim(async () => {
      throw new Error("file_export not allowed");
    });
    const { nativeExportFile } = await import("./native");
    expect(await nativeExportFile(file, "tok")).toBeNull();
  });

  it("surfaces a real failure instead of falling back in-page", async () => {
    shim(async () => {
      throw new Error("the server refused");
    });
    const { nativeExportFile } = await import("./native");
    await expect(nativeExportFile(file, "tok")).rejects.toThrow(/refused/);
  });
});
