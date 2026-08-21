import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { idleLockMinutes, installIdleLock, setIdleLockMinutes } from "./idlelock";

function installLocalStorage() {
  const backing = new Map<string, string>();
  (globalThis as { localStorage?: Storage }).localStorage = {
    getItem: (k: string) => backing.get(k) ?? null,
    setItem: (k: string, v: string) => void backing.set(k, String(v)),
    removeItem: (k: string) => void backing.delete(k),
    clear: () => backing.clear(),
    key: (i: number) => [...backing.keys()][i] ?? null,
    get length() {
      return backing.size;
    },
  } as Storage;
}

describe("idle lock setting", () => {
  beforeEach(() => installLocalStorage());

  it("is off until chosen and round-trips a choice", () => {
    expect(idleLockMinutes()).toBe(0);
    setIdleLockMinutes(15);
    expect(idleLockMinutes()).toBe(15);
    setIdleLockMinutes(0);
    expect(idleLockMinutes()).toBe(0);
  });
});

describe("idle lock watch", () => {
  let clock = 0;
  const now = () => clock;
  let target: EventTarget;
  let onLock: ReturnType<typeof vi.fn<() => void>>;

  beforeEach(() => {
    vi.useFakeTimers();
    clock = 1_000_000;
    target = new EventTarget();
    onLock = vi.fn<() => void>();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const advance = (ms: number) => {
    clock += ms;
    vi.advanceTimersByTime(ms);
  };

  it("does nothing while the setting is off", () => {
    const stop = installIdleLock({ minutes: () => 0, onLock, target, now, checkEveryMs: 1_000 });
    advance(3 * 60 * 60_000);
    expect(onLock).not.toHaveBeenCalled();
    stop();
  });

  it("locks once after the quiet spell, and activity resets the clock", () => {
    const stop = installIdleLock({ minutes: () => 5, onLock, target, now, checkEveryMs: 1_000 });
    advance(4 * 60_000);
    target.dispatchEvent(new Event("keydown"));
    advance(4 * 60_000);
    expect(onLock).not.toHaveBeenCalled();
    advance(2 * 60_000);
    expect(onLock).toHaveBeenCalledTimes(1);
    advance(30 * 60_000);
    expect(onLock).toHaveBeenCalledTimes(1);
    stop();
  });

  it("checks at once when the page becomes visible again", () => {
    const stop = installIdleLock({ minutes: () => 5, onLock, target, now, checkEveryMs: 60 * 60_000 });
    clock += 10 * 60_000; // asleep: no timer ticks ran
    target.dispatchEvent(new Event("visibilitychange"));
    expect(onLock).toHaveBeenCalledTimes(1);
    stop();
  });

  it("reads the setting on every check, so a change applies live", () => {
    let minutes = 0;
    const stop = installIdleLock({ minutes: () => minutes, onLock, target, now, checkEveryMs: 1_000 });
    advance(10 * 60_000);
    expect(onLock).not.toHaveBeenCalled();
    minutes = 5;
    advance(1_000);
    expect(onLock).toHaveBeenCalledTimes(1);
    stop();
  });

  it("stops watching once uninstalled", () => {
    const stop = installIdleLock({ minutes: () => 1, onLock, target, now, checkEveryMs: 1_000 });
    stop();
    advance(10 * 60_000);
    expect(onLock).not.toHaveBeenCalled();
  });
});
