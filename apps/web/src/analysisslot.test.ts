import { describe, expect, it } from "vitest";
import { analysisLanes, uploadLanes, withAnalysisSlot } from "./analysisslot";

describe("analysis slots", () => {
  it("never reads more files at once than the device allows", async () => {
    const limit = analysisLanes();
    let running = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 8 }, () =>
        withAnalysisSlot(async () => {
          running += 1;
          peak = Math.max(peak, running);
          await new Promise((resolve) => setTimeout(resolve, 10));
          running -= 1;
        }),
      ),
    );
    expect(peak).toBeLessThanOrEqual(limit);
    expect(peak).toBeGreaterThan(0);
  });

  it("releases the slot when the work throws, so later files still run", async () => {
    await expect(
      withAnalysisSlot(async () => {
        throw new Error("unreadable photo");
      }),
    ).rejects.toThrow("unreadable photo");
    // A wedged slot would hang this forever.
    await expect(withAnalysisSlot(async () => "fine")).resolves.toBe("fine");
  });

  it("keeps transfers more parallel than reads", () => {
    expect(uploadLanes()).toBeGreaterThanOrEqual(analysisLanes());
  });
});
