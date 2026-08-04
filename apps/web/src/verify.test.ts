import { beforeAll, describe, expect, it } from "vitest";
import { ready, contentDigest } from "@engramer/crypto";
import { describeVerify, verifyFiles, type VerifiableFile } from "./verify";

describe("verifying a vault", () => {
  beforeAll(async () => {
    await ready();
  });

  const bytes = (seed: number, n = 512) =>
    Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) % 256);

  // Built after ready(), because a digest cannot be taken before then.
  let good: VerifiableFile;
  let damaged: VerifiableFile;
  const legacy: VerifiableFile = { id: "3", name: "old.pdf", size: 512 };
  const broken: VerifiableFile = { id: "4", name: "gone.pdf", size: 512, digest: "x" };
  beforeAll(() => {
    good = { id: "1", name: "good.pdf", size: 512, digest: contentDigest(bytes(1)) };
    damaged = { id: "2", name: "damaged.pdf", size: 512, digest: contentDigest(bytes(2)) };
  });

  const read = async (file: VerifiableFile) => {
    if (file.id === "4") throw new Error("could not decrypt");
    if (file.id === "2") return bytes(99); // not what was recorded
    return bytes(Number(file.id));
  };

  it("separates intact, damaged, unchecked and unreadable", async () => {
    const result = await verifyFiles([good, damaged, legacy, broken], read);
    expect(result.ok).toBe(1);
    expect(result.damaged).toBe(1);
    expect(result.unchecked).toBe(1);
    expect(result.unreadable).toBe(1);
    expect(result.problems.map((p) => p.name).sort()).toEqual(["damaged.pdf", "gone.pdf", "old.pdf"]);
  });

  it("never calls a file without a digest verified", async () => {
    // Blessing it would hide whatever damage it already carries.
    const result = await verifyFiles([legacy], read);
    expect(result.ok).toBe(0);
    expect(result.unchecked).toBe(1);
  });

  it("reports progress for every file and can be stopped", async () => {
    const seen: number[] = [];
    const controller = new AbortController();
    const result = await verifyFiles([good, damaged, legacy], read, {
      onProgress: (p) => seen.push(p.done),
      onVerdict: () => controller.abort(),
      signal: controller.signal,
    });
    expect(seen.length).toBeGreaterThan(0);
    expect(result.ok + result.damaged + result.unchecked).toBe(1);
  });

  it("says what happened in a sentence", async () => {
    const clean = await verifyFiles([good], read);
    expect(describeVerify(clean, false)).toBe("1 file checked, all intact.");
    const mixed = await verifyFiles([good, damaged, legacy, broken], read);
    expect(describeVerify(mixed, false)).toContain("1 file did not match, of 2 checked");
    expect(describeVerify(mixed, true)).toMatch(/^Stopped\. /);
  });
});

describe("ordering the walk", () => {
  it("reads the smallest files first", async () => {
    // A vault that opens with a gigabyte of video shows nothing happening
    // for minutes and reads as a hang.
    const { smallestFirst } = await import("./verify");
    const files = [
      { id: "a", name: "video.mp4", size: 1_000_000_000 },
      { id: "b", name: "note.txt", size: 200 },
      { id: "c", name: "photo.jpg", size: 3_000_000 },
    ];
    expect(smallestFirst(files).map((f) => f.name)).toEqual(["note.txt", "photo.jpg", "video.mp4"]);
    // and leaves the caller's list alone
    expect(files[0]!.name).toBe("video.mp4");
  });

  it("reports bytes as well as counts, so a big file still shows movement", async () => {
    const { verifyFiles } = await import("./verify");
    const seen: number[] = [];
    await verifyFiles(
      [
        { id: "1", name: "small", size: 100 },
        { id: "2", name: "big", size: 900 },
      ],
      async () => new Uint8Array(1),
      { onProgress: (p) => seen.push(p.bytesTotal === 1000 ? p.bytesDone : -1) },
    );
    expect(seen).toContain(0);
    expect(seen).toContain(100);
    expect(seen).toContain(1000);
    expect(seen).not.toContain(-1);
  });
});
