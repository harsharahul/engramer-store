import { describe, expect, it, vi } from "vitest";
import { boundedRun, folderPlan, fromDirectoryInput, pathKey, type TreeFile } from "./uploader";
import { ApiError, withRetry } from "./api";

function tree(path: string[], name = "f.txt"): TreeFile {
  return { file: new File(["x"], name), path };
}

describe("folderPlan", () => {
  it("lists every distinct folder, parents before children, once", () => {
    const items = [
      tree(["a"]),
      tree(["a", "b"]),
      tree(["a", "b"]),
      tree(["c", "d", "e"]),
      tree([]),
    ];
    const plan = folderPlan(items);
    expect(plan).toEqual([["a"], ["c"], ["a", "b"], ["c", "d"], ["c", "d", "e"]]);
  });

  it("does not confuse names containing spaces with nesting", () => {
    const plan = folderPlan([tree(["a b"]), tree(["a", "b"])]);
    expect(plan).toHaveLength(3);
    expect(pathKey(["a b"])).not.toBe(pathKey(["a", "b"]));
  });
});

describe("fromDirectoryInput", () => {
  it("derives folder paths from webkitRelativePath", () => {
    const file = new File(["x"], "notes.txt");
    Object.defineProperty(file, "webkitRelativePath", { value: "trip/photos/notes.txt" });
    const [item] = fromDirectoryInput([file]);
    expect(item!.path).toEqual(["trip", "photos"]);
  });
});

describe("boundedRun", () => {
  it("processes everything with at most the given concurrency", async () => {
    let inFlight = 0;
    let peak = 0;
    const seen: number[] = [];
    await boundedRun([...Array(20).keys()], 4, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      seen.push(n);
      inFlight--;
    });
    expect(seen).toHaveLength(20);
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
  });

  it("keeps going when an item fails", async () => {
    const done: number[] = [];
    await boundedRun([1, 2, 3], 2, async (n) => {
      if (n === 2) {
        throw new Error("boom");
      }
      done.push(n);
    }).catch(() => {});
    // The failing lane rejects, but other lanes complete their queues.
    expect(done).toContain(1);
  });
});

describe("withRetry", () => {
  it("retries throttled requests and honors Retry-After", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const promise = withRetry(async () => {
      calls++;
      if (calls < 3) {
        throw new ApiError(429, "too many attempts", 10);
      }
      return "ok";
    });
    await vi.advanceTimersByTimeAsync(50);
    await expect(promise).resolves.toBe("ok");
    expect(calls).toBe(3);
    vi.useRealTimers();
  });

  it("does not retry non-throttle failures", async () => {
    let calls = 0;
    await expect(
      withRetry(async () => {
        calls++;
        throw new ApiError(404, "not found");
      }),
    ).rejects.toThrow("not found");
    expect(calls).toBe(1);
  });
});
