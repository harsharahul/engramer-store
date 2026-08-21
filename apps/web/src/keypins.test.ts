import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkPin, clearPins, mergePins, pinKey, pinnedKey, pinnedKeys } from "./keypins";
import { onSettingChanged } from "./settingsbus";

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

beforeEach(() => {
  installLocalStorage();
  clearPins();
});

describe("key pins", () => {
  it("treats the first key as new, the same key as a match, and any other as changed", () => {
    expect(checkPin("Ann@Example.com", "key-1")).toBe("new");
    pinKey("ann@example.com", "key-1");
    expect(checkPin("ANN@example.com ", "key-1")).toBe("match");
    expect(checkPin("ann@example.com", "key-2")).toBe("changed");
    expect(pinnedKey("ann@example.com")).toBe("key-1");
  });

  it("announces a new pin to the settings sync, but not an unchanged one", () => {
    const heard = vi.fn();
    const stop = onSettingChanged(heard);
    pinKey("bob@example.com", "key-1");
    pinKey("bob@example.com", "key-1");
    expect(heard).toHaveBeenCalledTimes(1);
    pinKey("bob@example.com", "key-2");
    expect(heard).toHaveBeenCalledTimes(2);
    stop();
  });

  it("merges remote pins over local ones without announcing", () => {
    const heard = vi.fn();
    const stop = onSettingChanged(heard);
    pinKey("ann@example.com", "key-1");
    heard.mockClear();
    mergePins({ "ann@example.com": "key-9", "cid@example.com": "key-3" });
    expect(heard).not.toHaveBeenCalled();
    expect(pinnedKeys()).toEqual({ "ann@example.com": "key-9", "cid@example.com": "key-3" });
    mergePins(undefined);
    expect(pinnedKeys()).toEqual({ "ann@example.com": "key-9", "cid@example.com": "key-3" });
    stop();
  });

  it("survives a corrupt store", () => {
    localStorage.setItem("engram-key-pins", "not json");
    expect(pinnedKeys()).toEqual({});
    expect(checkPin("x@example.com", "k")).toBe("new");
  });
});
