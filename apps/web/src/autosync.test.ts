import { beforeAll, describe, expect, it, vi } from "vitest";

const rig = vi.hoisted(() => ({
  pushed: null as ((payload: unknown) => void) | null,
  feedState: null as ((payload: unknown) => void) | null,
  refreshes: 0,
  signals: [] as string[],
  handoffOn: true,
}));

vi.mock("./handoff", () => ({
  handoffEnabled: () => rig.handoffOn,
}));

vi.mock("./native", () => ({
  nativeOutboxDrain: async () => {},
  nativeFilesProviderSignal: async (email: string) => {
    rig.signals.push(email);
  },
  nativeFilesProviderFeedState: async () => "off",
  nativeListen: async (event: string, handler: (payload: unknown) => void) => {
    if (event === "vault-changed") {
      rig.pushed = handler;
    }
    if (event === "vault-feed-state") {
      rig.feedState = handler;
    }
    return () => {};
  },
}));

vi.mock("./backfill", () => ({
  scheduleBackfill: () => {},
}));

vi.mock("./store", () => {
  const state = {
    session: { email: "owner@example.com" },
    synced: true,
    files: new Map(),
    folders: new Map(),
    liveFeed: "off" as string,
    refresh: async () => {
      rig.refreshes += 1;
      // A changed map reference is autosync's "something arrived".
      state.files = new Map(state.files);
    },
  };
  return {
    useStore: {
      getState: () => state,
      setState: (patch: Record<string, unknown>) => Object.assign(state, patch),
    },
  };
});

import { installAutoSync } from "./autosync";

// The suite runs in node; autosync only needs listener registration
// from its globals, so two stubs stand in for a DOM.
const handlers = new Map<string, (event?: unknown) => void>();
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeAll(() => {
  Object.assign(globalThis, {
    document: {
      visibilityState: "hidden",
      addEventListener: (event: string, handler: () => void) => handlers.set(`doc:${event}`, handler),
    },
    window: {
      addEventListener: (event: string, handler: () => void) => handlers.set(`win:${event}`, handler),
      setInterval: () => 0,
    },
  });
  installAutoSync();
});

describe("autosync push", () => {
  it("subscribes to the shell's change feed", () => {
    expect(rig.pushed).not.toBeNull();
  });

  it("a pushed poke refreshes even inside the foreground cooldown", async () => {
    handlers.get("win:focus")?.();
    await settled();
    const after = rig.refreshes;
    expect(after).toBeGreaterThan(0);
    // Another foreground kick sits out the cooldown...
    handlers.get("win:focus")?.();
    await settled();
    expect(rig.refreshes).toBe(after);
    // ...but a pushed poke does not.
    rig.pushed?.({ seq: 7 });
    await settled();
    expect(rig.refreshes).toBe(after + 1);
    expect(rig.signals).toContain("owner@example.com");
  });

  it("does not poke the drive when extensions are off", async () => {
    rig.handoffOn = false;
    const before = rig.signals.length;
    rig.pushed?.({ seq: 99 });
    await settled();
    expect(rig.signals.length).toBe(before);
    rig.handoffOn = true;
  });

  it("mirrors the feed holder's reported state into the store", async () => {
    const { useStore } = await import("./store");
    expect(rig.feedState).not.toBeNull();
    rig.feedState?.({ state: "live" });
    expect((useStore.getState() as { liveFeed: string }).liveFeed).toBe("live");
    rig.feedState?.({ state: "unavailable" });
    expect((useStore.getState() as { liveFeed: string }).liveFeed).toBe("unavailable");
  });
});
