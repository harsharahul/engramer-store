import { describe, expect, it } from "vitest";
import { decodeIndexPayload, encodeIndexPayload } from "./indexblob";

describe("index blob envelope", () => {
  it("round-trips text and embedding together", () => {
    const clip = new Float32Array(512).map((_, i) => Math.sin(i));
    const bytes = encodeIndexPayload({ text: "lease casa verde", clip });
    const decoded = decodeIndexPayload(bytes);
    expect(decoded.text).toBe("lease casa verde");
    expect(decoded.clip).toBeDefined();
    expect(decoded.clip!.length).toBe(512);
    for (let i = 0; i < 512; i += 37) {
      expect(decoded.clip![i]).toBeCloseTo(clip[i]!, 5);
    }
  });

  it("round-trips text-only and embedding-only payloads", () => {
    expect(decodeIndexPayload(encodeIndexPayload({ text: "just words" }))).toEqual({
      text: "just words",
    });
    const clip = new Float32Array([0.25, -0.5, 1]);
    const decoded = decodeIndexPayload(encodeIndexPayload({ clip }));
    expect(decoded.text).toBeUndefined();
    expect([...decoded.clip!]).toEqual([0.25, -0.5, 1]);
  });

  it("reads legacy blobs as plain search text", () => {
    const legacy = new TextEncoder().encode("plain legacy search text");
    expect(decodeIndexPayload(legacy)).toEqual({ text: "plain legacy search text" });
  });

  it("treats legacy text that resembles the magic as legacy text", () => {
    // Only the exact magic prefix switches parsing; near-misses stay text.
    const nearMiss = new TextEncoder().encode("EIDX2 is not our format");
    expect(decodeIndexPayload(nearMiss).text).toBe("EIDX2 is not our format");
  });

  it("survives corrupt envelope bodies by yielding nothing", () => {
    const bytes = encodeIndexPayload({ text: "ok" });
    const corrupted = bytes.slice(0, bytes.length - 3);
    const decoded = decodeIndexPayload(corrupted);
    expect(decoded.text).toBeUndefined();
    expect(decoded.clip).toBeUndefined();
  });
});
