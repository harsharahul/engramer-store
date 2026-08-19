import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const rig = vi.hoisted(() => ({
  handheld: true,
  shell: true,
  exportedName: "clip.mov" as string | null,
  exportError: null as string | null,
  exportCalls: [] as { id: string; name: string }[],
  decrypts: 0,
  decryptOpts: null as Record<string, unknown> | null,
  shellEvents: null as ((payload: unknown) => void) | null,
  midExport: null as (() => void) | null,
}));

vi.mock("./analysisslot", () => ({
  isHandheld: () => rig.handheld,
}));

vi.mock("./native", () => ({
  nativeShell: () => rig.shell,
  nativeExportFile: async (file: { id: string; name: string }) => {
    rig.midExport?.();
    if (rig.exportError) {
      throw new Error(rig.exportError);
    }
    rig.exportCalls.push({ id: file.id, name: file.name });
    return rig.exportedName;
  },
  nativeListen: async (_event: string, handler: (payload: unknown) => void) => {
    rig.shellEvents = handler;
    return () => {
      rig.shellEvents = null;
    };
  },
}));

vi.mock("./transfer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./transfer")>()),
  downloadAndDecrypt: async (
    _id: string,
    _key: Uint8Array,
    _digest?: string,
    opts?: Record<string, unknown>,
  ) => {
    rig.decrypts++;
    rig.decryptOpts = opts ?? null;
    (opts?.onProgress as ((loaded: number, total: number | null) => void) | undefined)?.(10, 100);
    return new Uint8Array(8);
  },
}));

vi.mock("./store", () => ({
  useStore: {
    getState: () => ({ session: { email: "t@example.com", token: "tok" } }),
  },
}));

import { saveDecryptedFile } from "./download";
import { activeSaves } from "./saveprogress";
import type { FileEntry } from "./store";

const entry = (size: number): FileEntry =>
  ({
    id: "f1",
    name: "clip.mov",
    mime: "video/quicktime",
    size,
    key: new Uint8Array(32),
    digest: "d1",
    tags: [],
    facts: [],
  }) as unknown as FileEntry;

// The browser path builds an anchor; give the node env just enough DOM.
beforeAll(() => {
  (globalThis as { document?: unknown }).document = {
    createElement: () => ({ click: () => {}, remove: () => {}, set href(_: string) {}, set download(_: string) {} }),
    body: { append: () => {} },
  };
  (URL as unknown as { createObjectURL: () => string }).createObjectURL = () => "blob:x";
  (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => {};
});

beforeEach(() => {
  rig.handheld = true;
  rig.shell = true;
  rig.exportedName = "clip.mov";
  rig.exportError = null;
  rig.exportCalls.length = 0;
  rig.decrypts = 0;
  rig.decryptOpts = null;
  rig.shellEvents = null;
  rig.midExport = null;
});

/**
 * The Download button on a handheld shell hands the file to the share
 * sheet: the shell streams the ciphertext down, decrypts file to file,
 * and the person picks where the plaintext goes. Nothing is held in the
 * page, whatever the size, and the sheet itself is the feedback. The
 * in-page anchor remains only where no shell can export. Both paths
 * narrate through the shared save record so one overlay tells the story.
 */
describe("saveDecryptedFile", () => {
  it("exports through the shell on a handheld; the sheet is the feedback", async () => {
    await saveDecryptedFile(entry(5 * 1024 * 1024 * 1024));
    expect(rig.exportCalls).toEqual([{ id: "f1", name: "clip.mov" }]);
    expect(rig.decrypts).toBe(0);
  });

  it("narrates the shell's progress events while the export runs", async () => {
    rig.midExport = () => {
      // The shell is mid-download: its event lands in the shared record.
      rig.shellEvents?.({ fileId: "f1", phase: "download", done: 512, total: 2048 });
      expect(activeSaves()).toHaveLength(1);
      expect(activeSaves()[0]).toMatchObject({ phase: "download", done: 512, total: 2048 });
      // An event for someone else's file changes nothing.
      rig.shellEvents?.({ fileId: "other", phase: "download", done: 1, total: 2 });
      expect(activeSaves()).toHaveLength(1);
    };
    await saveDecryptedFile(entry(1024));
    expect(activeSaves()).toEqual([]);
    expect(rig.shellEvents).toBeNull();
  });

  it("falls back to the in-page path only when the shell lacks the command", async () => {
    rig.exportedName = null;
    await saveDecryptedFile(entry(1024));
    expect(rig.decrypts).toBe(1);
  });

  it("surfaces a native failure rather than retrying a huge file in-page", async () => {
    rig.exportError = "the server refused";
    await expect(saveDecryptedFile(entry(5 * 1024 * 1024 * 1024))).rejects.toThrow(/refused/);
    expect(rig.decrypts).toBe(0);
    expect(activeSaves()).toEqual([]);
  });

  it("keeps the browser path on desktops, narrating bytes as they land", async () => {
    rig.handheld = false;
    await saveDecryptedFile(entry(1024));
    expect(rig.exportCalls).toEqual([]);
    expect(rig.decrypts).toBe(1);
    // The download fed the shared record: the mock pushed one tick through.
    expect(rig.decryptOpts?.onProgress).toBeTypeOf("function");
    expect(activeSaves()).toEqual([]);
  });

  it("prefers the shell's local copy on the in-page path, never for verify", async () => {
    rig.handheld = false;
    await saveDecryptedFile(entry(1024));
    expect(rig.decryptOpts?.preferLocal).toBe(true);
  });
});
