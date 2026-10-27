import { afterEach, describe, expect, it, vi } from "vitest";

const knobs = vi.hoisted(() => ({ handheld: true }));
vi.mock("./analysisslot", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./analysisslot")>()),
  isHandheld: () => knobs.handheld,
}));

import {
  HANDHELD_MODEL_READS_PER_OPEN,
  remainingModelReads,
  spendModelReads,
  startOfOpen,
  watchAppOpens,
} from "./modelbudget";

afterEach(() => {
  knobs.handheld = true;
  startOfOpen();
});

/**
 * A phone opening onto a large import must not spend one open reading
 * everything with the model. Each time the app is opened, or brought back
 * to the front, it gets a fixed number of model readings.
 */
describe("the model budget per app open", () => {
  it("a phone has 40 readings per open, and what is spent comes off", () => {
    expect(remainingModelReads()).toBe(HANDHELD_MODEL_READS_PER_OPEN);
    spendModelReads(30);
    expect(remainingModelReads()).toBe(10);
    spendModelReads(30);
    expect(remainingModelReads()).toBe(0);
  });

  it("a desktop has no budget", () => {
    knobs.handheld = false;
    spendModelReads(1000);
    expect(remainingModelReads()).toBe(Number.POSITIVE_INFINITY);
  });

  it("coming back to the front starts a fresh budget", () => {
    const page = Object.assign(new EventTarget(), { visibilityState: "visible" });
    watchAppOpens(page);
    spendModelReads(40);
    expect(remainingModelReads()).toBe(0);
    // A glance at another tab or app and back is still the same open only
    // if the page was never hidden; hidden then visible is a new open.
    page.visibilityState = "hidden";
    page.dispatchEvent(new Event("visibilitychange"));
    expect(remainingModelReads()).toBe(0);
    page.visibilityState = "visible";
    page.dispatchEvent(new Event("visibilitychange"));
    expect(remainingModelReads()).toBe(HANDHELD_MODEL_READS_PER_OPEN);
  });
});
