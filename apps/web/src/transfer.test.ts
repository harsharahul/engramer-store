import { describe, expect, it } from "vitest";
import { withDeadline } from "./transfer";

describe("withDeadline", () => {
  it("passes a value through when the work finishes in time", async () => {
    expect(await withDeadline(Promise.resolve("ok"), 1000)).toBe("ok");
  });

  it("yields nothing when the work outlasts its deadline", async () => {
    // A media element that never fires its events looks exactly like this.
    const never = new Promise<string>(() => {});
    expect(await withDeadline(never, 20)).toBeUndefined();
  });

  it("yields nothing when the work throws", async () => {
    expect(await withDeadline(Promise.reject(new Error("nope")), 1000)).toBeUndefined();
  });

  it("does not hold the result hostage to the timer", async () => {
    const started = Date.now();
    await withDeadline(Promise.resolve(1), 5000);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
