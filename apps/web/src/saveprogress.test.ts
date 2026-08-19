import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  activeSaves,
  beginSave,
  endSave,
  SAVE_QUIET_MS,
  subscribeSaves,
  updateSave,
  visibleSaves,
} from "./saveprogress";

/**
 * One narration for every way bytes leave the vault: export on iOS, the
 * anchor download in a browser, a pin filling in the background. Each
 * path reports into this record and one overlay renders it, so open,
 * export, and pin all speak the same visual language. The record itself
 * is deliberately dumb: names, phases, and byte counts, nothing else.
 */
describe("save progress record", () => {
  beforeEach(() => {
    for (const save of activeSaves()) {
      endSave(save.fileId);
    }
  });

  it("tracks a save from begin through progress to end", () => {
    beginSave("f1", "clip.mov");
    expect(activeSaves()).toHaveLength(1);
    expect(activeSaves()[0]).toMatchObject({
      fileId: "f1",
      name: "clip.mov",
      done: 0,
      total: null,
    });
    updateSave("f1", "download", 512, 2048);
    expect(activeSaves()[0]).toMatchObject({ phase: "download", done: 512, total: 2048 });
    updateSave("f1", "decrypt", 2048, 2048);
    expect(activeSaves()[0]!.phase).toBe("decrypt");
    endSave("f1");
    expect(activeSaves()).toEqual([]);
  });

  it("ignores progress for a save nobody began", () => {
    // Shell events are broadcast; one for a file this page is not
    // narrating must not conjure an overlay row.
    updateSave("ghost", "download", 1, 2);
    expect(activeSaves()).toEqual([]);
  });

  it("keeps the snapshot's identity stable between changes", () => {
    // useSyncExternalStore re-renders on every new snapshot identity;
    // a fresh array per read would loop the renderer.
    beginSave("f1", "a.bin");
    const first = activeSaves();
    expect(activeSaves()).toBe(first);
    updateSave("f1", "download", 1, 2);
    expect(activeSaves()).not.toBe(first);
  });

  it("keeps quick saves silent and surfaces the ones that take a while", () => {
    // Small files finish inside the quiet window and show no ceremony;
    // anything still running past it gets the overlay.
    beginSave("f1", "quick.txt");
    const began = activeSaves()[0]!.startedAt;
    expect(visibleSaves(activeSaves(), began + SAVE_QUIET_MS - 1)).toEqual([]);
    expect(visibleSaves(activeSaves(), began + SAVE_QUIET_MS + 1)).toHaveLength(1);
  });

  it("notifies subscribers on each change, and stops after unsubscribe", () => {
    const seen = vi.fn();
    const stop = subscribeSaves(seen);
    beginSave("f1", "a.bin");
    updateSave("f1", "download", 1, 2);
    endSave("f1");
    expect(seen).toHaveBeenCalledTimes(3);
    stop();
    beginSave("f2", "b.bin");
    expect(seen).toHaveBeenCalledTimes(3);
  });
});
