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
      ),
    ).rejects.toBe(original);
  });

  it("propagates a mismatch that survives the refresh", async () => {
    let opens = 0;
    await expect(
      openWithFreshEntry(
        { id: "f", digest: "old", shared: true } as Entry,
        async () => {
          opens += 1;
          throw integrityError();
        },
        async () => ({ id: "f", digest: "still-old", shared: true }),
      ),
    ).rejects.toBeInstanceOf(IntegrityError);
    expect(opens).toBe(2);
  });
});
