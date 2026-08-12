import { describe, expect, it } from "vitest";
import { unmeteredConnection } from "./connection";
import type { NativeNetworkStatus } from "./native";

function status(overrides: Partial<NativeNetworkStatus>): NativeNetworkStatus {
  return {
    known: true,
    online: true,
    wifi: false,
    wired: false,
    cellular: false,
    expensive: false,
    constrained: false,
    ...overrides,
  };
}

describe("unmeteredConnection", () => {
  it("fails open with no shell monitor", () => {
    expect(unmeteredConnection(null)).toBe(true);
  });

  it("fails open before the monitor's first update", () => {
    expect(unmeteredConnection(status({ known: false, cellular: true }))).toBe(true);
  });

  it("accepts clean wifi", () => {
    expect(unmeteredConnection(status({ wifi: true }))).toBe(true);
  });

  it("accepts wired ethernet", () => {
    expect(unmeteredConnection(status({ wired: true }))).toBe(true);
  });

  it("refuses cellular", () => {
    expect(unmeteredConnection(status({ cellular: true }))).toBe(false);
  });

  it("refuses a personal hotspot that looks like wifi", () => {
    expect(unmeteredConnection(status({ wifi: true, expensive: true }))).toBe(false);
  });

  it("refuses low data mode", () => {
    expect(unmeteredConnection(status({ wifi: true, constrained: true }))).toBe(false);
  });
});
