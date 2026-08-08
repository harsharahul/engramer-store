import { describe, expect, it } from "vitest";
import { FLICK_MIN_PX, FLICK_VELOCITY, shouldDismiss } from "./sheetdrag";

describe("shouldDismiss", () => {
  it("springs back on no travel or upward travel", () => {
    expect(shouldDismiss(0, 2, 400)).toBe(false);
    expect(shouldDismiss(-30, 2, 400)).toBe(false);
  });

  it("dismisses on a fast flick with a little travel", () => {
    expect(shouldDismiss(FLICK_MIN_PX, FLICK_VELOCITY, 400)).toBe(true);
    expect(shouldDismiss(FLICK_MIN_PX - 1, 5, 400)).toBe(false);
  });

  it("dismisses a slow drag only past half the sheet", () => {
    expect(shouldDismiss(199, 0.1, 400)).toBe(false);
    expect(shouldDismiss(200, 0.1, 400)).toBe(true);
  });

  it("never slow-dismisses a sheet whose height is unknown", () => {
    expect(shouldDismiss(300, 0.1, 0)).toBe(false);
  });
});
