import { beforeAll, describe, expect, it, vi } from "vitest";

const rig = vi.hoisted(() => ({
  pushed: null as ((payload: unknown) => void) | null,
  feedState: null as ((payload: unknown) => void) | null,
  refreshes: 0,
  signals: [] as string[],
  handoffOn: true,
  reachedSeq: 1_000_000,
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
    syncSeq: 0,
    files: new Map(),
    folders: new Map(),
    liveFeed: "off" as string,
    refresh: async () => {
      rig.refreshes += 1;
      // A changed map reference is autosync's "something arrived".
      state.files = new Map(state.files);
      // The cursor the pull reached; a test lowers it to play a pull
      // that read the server before the announced change had landed.
      state.syncSeq = rig.reachedSeq;
    },
  };
  return {
    useStore: {
      getState: () => state,
      setState: (patch: Record<string, unknown>) => Object.assign(state, patch),
    },
  };
});

import { installAutoSync, RECHECK_DELAYS_MS } from "./autosync";

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

  it("pokes that land during a refresh collapse into one follow-up refresh", async () => {
    // Hold the refresh open so pokes arrive while it is in flight.
    const { useStore } = await import("./store");
    let release: (() => void) | null = null;
    const state = useStore.getState() as { refresh: () => Promise<void>; files: Map<string, unknown> };
    const original = state.refresh;
    useStore.setState({
      refresh: async () => {
        rig.refreshes += 1;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      },
    });
    const before = rig.refreshes;
    rig.pushed?.({ seq: 100 });
    await settled();
    expect(rig.refreshes).toBe(before + 1);
    rig.pushed?.({ seq: 101 });
    rig.pushed?.({ seq: 102 });
    rig.pushed?.({ seq: 103 });
    await settled();
    // Still one: the running pull holds them.
    expect(rig.refreshes).toBe(before + 1);
    useStore.setState({ refresh: original });
    release!();
    await settled();
    await settled();
    // Exactly one more, not three.
    expect(rig.refreshes).toBe(before + 2);
  });

  it("pulls again, backing off, until the pull reaches the announced sequence", async () => {
    // Real time is faked for this case alone: the follow-up pulls are
    // scheduled seconds apart and the test walks the clock to them.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const before = rig.refreshes;
      // The server announced 500, but the pull it triggered read the
      // state from before that change committed and stopped at 480.
      rig.reachedSeq = 480;
      rig.pushed?.({ seq: 500 });
      await vi.advanceTimersByTimeAsync(0);
      expect(rig.refreshes).toBe(before + 1);
      // Not immediately: the first follow-up waits a beat.
      await vi.advanceTimersByTimeAsync(RECHECK_DELAYS_MS[0] - 1);
      expect(rig.refreshes).toBe(before + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(rig.refreshes).toBe(before + 2);
      // Still short: the next wait is longer.
      await vi.advanceTimersByTimeAsync(RECHECK_DELAYS_MS[0]);
      expect(rig.refreshes).toBe(before + 2);
      rig.reachedSeq = 500;
      await vi.advanceTimersByTimeAsync(RECHECK_DELAYS_MS[1] - RECHECK_DELAYS_MS[0]);
      expect(rig.refreshes).toBe(before + 3);
      // Caught up: nothing more is scheduled.
      await vi.advanceTimersByTimeAsync(RECHECK_DELAYS_MS[2] * 2);
      expect(rig.refreshes).toBe(before + 3);
    } finally {
      rig.reachedSeq = 1_000_000;
      vi.useRealTimers();
    }
  });

  it("gives up re-pulling after the last delay so a bad announcement cannot loop", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const before = rig.refreshes;
      rig.reachedSeq = 10;
      rig.pushed?.({ seq: 900 });
      await vi.advanceTimersByTimeAsync(0);
      const total = RECHECK_DELAYS_MS.reduce((sum, delay) => sum + delay, 0);
      await vi.advanceTimersByTimeAsync(total * 3);
      expect(rig.refreshes).toBe(before + 1 + RECHECK_DELAYS_MS.length);
    } finally {
      rig.reachedSeq = 1_000_000;
      vi.useRealTimers();
    }
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
