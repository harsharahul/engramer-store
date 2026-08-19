import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const rig = vi.hoisted(() => ({
  handheld: true,
  shell: true,
  savedName: "clip.mov" as string | null,
  saveError: null as string | null,
  saveCalls: [] as { id: string; name: string }[],
  decrypts: 0,
}));

vi.mock("./analysisslot", () => ({
  isHandheld: () => rig.handheld,
}));

vi.mock("./native", () => ({
  nativeShell: () => rig.shell,
  nativeSaveDownload: async (file: { id: string; name: string }) => {
    if (rig.saveError) {
      throw new Error(rig.saveError);
    }
    rig.saveCalls.push({ id: file.id, name: file.name });
    return rig.savedName;
  },
}));

vi.mock("./transfer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./transfer")>()),
  downloadAndDecrypt: async () => {
    rig.decrypts++;
    return new Uint8Array(8);
  },
}));

vi.mock("./store", () => ({
  useStore: {
    getState: () => ({ session: { email: "t@example.com", token: "tok" } }),
  },
}));

import { saveDecryptedFile } from "./download";
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

// The legacy path builds an anchor; give the node env just enough DOM.
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
  rig.savedName = "clip.mov";
  rig.saveError = null;
  rig.saveCalls.length = 0;
  rig.decrypts = 0;
});

/**
 * A phone download used to decrypt the whole file into the page plus a
 * Blob copy; past a few hundred megabytes iOS killed the content process
 * and the page silently reloaded. On a shell that can, the file now
 * streams natively into Documents/Downloads (visible in the Files app),
 * whatever its size; the in-page path remains only where no shell can.
 */
describe("saveDecryptedFile", () => {
  it("streams natively on a handheld shell and says where the file went", async () => {
    const message = await saveDecryptedFile(entry(5 * 1024 * 1024 * 1024));
    expect(rig.saveCalls).toEqual([{ id: "f1", name: "clip.mov" }]);
    expect(rig.decrypts).toBe(0);
    expect(message).toMatch(/Files/);
    expect(message).toMatch(/clip\.mov/);
  });

  it("names the number the file landed under when the name was taken", async () => {
    rig.savedName = "clip 2.mov";
    const message = await saveDecryptedFile(entry(1024));
    expect(message).toMatch(/clip 2\.mov/);
  });

  it("falls back to the in-page path only when the shell lacks the command", async () => {
    rig.savedName = null;
    await saveDecryptedFile(entry(1024));
    expect(rig.decrypts).toBe(1);
  });

  it("surfaces a native failure rather than retrying a huge file in-page", async () => {
    rig.saveError = "the server refused";
    await expect(saveDecryptedFile(entry(5 * 1024 * 1024 * 1024))).rejects.toThrow(/refused/);
    expect(rig.decrypts).toBe(0);
  });

  it("keeps the browser path on desktops", async () => {
    rig.handheld = false;
    await saveDecryptedFile(entry(1024));
    expect(rig.saveCalls).toEqual([]);
    expect(rig.decrypts).toBe(1);
  });
});
