import { beforeAll, describe, expect, it, vi } from "vitest";

const rig = vi.hoisted(() => ({
  pushed: null as ((payload: unknown) => void) | null,
  refreshes: 0,
  signals: [] as string[],
}));

vi.mock("./native", () => ({
  nativeOutboxDrain: async () => {},
  nativeFilesProviderSignal: async (email: string) => {
    rig.signals.push(email);
  },
  nativeListen: async (event: string, handler: (payload: unknown) => void) => {
    if (event === "vault-changed") {
      rig.pushed = handler;
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
    refresh: async () => {
      rig.refreshes += 1;
      // A changed map reference is autosync's "something arrived".
      state.files = new Map(state.files);
    },
  };
  return { useStore: { getState: () => state } };
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
});
