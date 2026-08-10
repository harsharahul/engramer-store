import { describe, expect, it } from "vitest";
import { openWithFreshEntry } from "./freshen";
import { IntegrityError } from "./transfer";

type Entry = { id: string; digest: string; shared?: boolean };

const integrityError = () => new IntegrityError(new Uint8Array([1, 2, 3]));

describe("openWithFreshEntry", () => {
  it("passes a clean open through without freshening", async () => {
    let freshened = 0;
    const result = await openWithFreshEntry(
      { id: "f", digest: "x", shared: true } as Entry,
      async () => "bytes",
      async () => {
        freshened += 1;
        return null;
      },
    );
    expect(result).toBe("bytes");
    expect(freshened).toBe(0);
  });

  it("rethrows a non-integrity failure without freshening", async () => {
    let freshened = 0;
    await expect(
      openWithFreshEntry(
        { id: "f", digest: "x", shared: true } as Entry,
        async () => {
          throw new Error("network down");
        },
        async () => {
          freshened += 1;
          return null;
        },
      ),
    ).rejects.toThrow("network down");
    expect(freshened).toBe(0);
  });

  it("does not freshen for a file that is not shared", async () => {
    let freshened = 0;
    await expect(
      openWithFreshEntry(
        { id: "f", digest: "x" } as Entry,
        async () => {
          throw integrityError();
        },
        async () => {
          freshened += 1;
          return null;
        },
      ),
    ).rejects.toBeInstanceOf(IntegrityError);
    expect(freshened).toBe(0);
  });

  it("retries a shared mismatch once with the freshened entry", async () => {
    const seen: string[] = [];
    const result = await openWithFreshEntry(
      { id: "f", digest: "old", shared: true } as Entry,
      async (entry) => {
        seen.push(entry.digest);
        if (entry.digest === "old") {
          throw integrityError();
        }
        return "fresh bytes";
      },
      async () => ({ id: "f", digest: "new", shared: true }),
    );
    expect(result).toBe("fresh bytes");
    expect(seen).toEqual(["old", "new"]);
  });

  it("keeps the original refusal when the entry cannot be freshened", async () => {
    const original = integrityError();
    await expect(
      openWithFreshEntry(
        { id: "f", digest: "old", shared: true } as Entry,
        async () => {
          throw original;
        },
        async () => null,
        { wait: async () => {} },
      ),
    ).rejects.toBe(original);
  });

  it("propagates a mismatch that survives every refresh", async () => {
    let opens = 0;
    await expect(
      openWithFreshEntry(
        { id: "f", digest: "old", shared: true } as Entry,
        async () => {
          opens += 1;
          throw integrityError();
        },
        async () => ({ id: "f", digest: "still-old", shared: true }),
        { wait: async () => {} },
      ),
    ).rejects.toBeInstanceOf(IntegrityError);
    expect(opens).toBe(3);
  });

  it("retries twice with the freshened entry each time", async () => {
    const seen: string[] = [];
    let refreshes = 0;
    const result = await openWithFreshEntry(
      { id: "f", digest: "old", shared: true } as Entry,
      async (entry) => {
        seen.push(entry.digest);
        if (entry.digest !== "new2") {
          throw integrityError();
        }
        return "settled bytes";
      },
      async () => {
        refreshes += 1;
        return { id: "f", digest: `new${refreshes}`, shared: true };
      },
      { wait: async () => {} },
    );
    expect(result).toBe("settled bytes");
    expect(seen).toEqual(["old", "new1", "new2"]);
  });

  it("waits before each retry, never before the first open", async () => {
    const waits: number[] = [];
    let refreshes = 0;
    await openWithFreshEntry(
      { id: "f", digest: "old", shared: true } as Entry,
      async (entry) => {
        if (entry.digest !== "new2") {
          throw integrityError();
        }
        return "bytes";
      },
      async () => {
        refreshes += 1;
        return { id: "f", digest: `new${refreshes}`, shared: true };
      },
      { wait: async (ms) => void waits.push(ms) },
    );
    expect(waits).toEqual([250, 750]);
  });

  it("never waits for an unshared entry or a non-integrity failure", async () => {
    const waits: number[] = [];
    const wait = async (ms: number) => void waits.push(ms);
    await expect(
      openWithFreshEntry(
        { id: "f", digest: "x" } as Entry,
        async () => {
          throw integrityError();
        },
        async () => null,
        { wait },
      ),
    ).rejects.toBeInstanceOf(IntegrityError);
    await expect(
      openWithFreshEntry(
        { id: "f", digest: "x", shared: true } as Entry,
        async () => {
          throw new Error("network down");
        },
        async () => null,
        { wait },
      ),
    ).rejects.toThrow("network down");
    expect(waits).toEqual([]);
  });

  it("gives up after the budget with the ORIGINAL refusal", async () => {
    const original = integrityError();
    let opens = 0;
    await expect(
      openWithFreshEntry(
        { id: "f", digest: "old", shared: true } as Entry,
        async () => {
          opens += 1;
          if (opens === 1) {
            throw original;
          }
          throw integrityError();
        },
        async () => ({ id: "f", digest: "later", shared: true }),
        { wait: async () => {} },
      ),
    ).rejects.toBe(original);
    expect(opens).toBe(3);
  });

  it("stops retrying the moment the freshener returns nothing", async () => {
    const original = integrityError();
    let opens = 0;
    let refreshes = 0;
    await expect(
      openWithFreshEntry(
        { id: "f", digest: "old", shared: true } as Entry,
        async () => {
          opens += 1;
          throw original;
        },
        async () => {
          refreshes += 1;
          return refreshes === 1 ? { id: "f", digest: "new1", shared: true } : null;
        },
        { wait: async () => {} },
      ),
    ).rejects.toBe(original);
    expect(opens).toBe(2);
    expect(refreshes).toBe(2);
  });
});
