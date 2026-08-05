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

  it("round-trips several frame vectors and keeps the poster as clip", () => {
    const frames = [1, 2, 3].map((n) => new Float32Array(8).fill(n / 10));
    const bytes = encodeIndexPayload({ text: "drone clip", clips: frames });
    const decoded = decodeIndexPayload(bytes);
    expect(decoded.text).toBe("drone clip");
    expect(decoded.clips).toHaveLength(3);
    expect([...decoded.clips![2]!]).toEqual([...frames[2]!]);
    // The primary vector mirrors the first frame, so older readers that
    // only understand `clip` keep working on multi-frame blobs.
    expect([...decoded.clip!]).toEqual([...frames[0]!]);
  });

  it("keeps a single-vector payload free of the clips array", () => {
    const clip = new Float32Array([0.5, 0.5]);
    const decoded = decodeIndexPayload(encodeIndexPayload({ clip, clips: [clip] }));
    expect(decoded.clips).toBeUndefined();
    expect([...decoded.clip!]).toEqual([0.5, 0.5]);
  });

  it("carries the evidence behind a fact alongside the text", () => {
    const evidence = [
      { id: "f1:expiry:2029-03-12", full: "D12345678", span: "Expires 12 March 2029" },
    ];
    const decoded = decodeIndexPayload(
      encodeIndexPayload({ text: "Expires 12 March 2029", evidence }),
    );
    expect(decoded.text).toBe("Expires 12 March 2029");
    expect(decoded.evidence).toEqual(evidence);
  });

  it("leaves evidence absent when a file has none, rather than storing an empty list", () => {
    expect(decodeIndexPayload(encodeIndexPayload({ text: "plain" })).evidence).toBeUndefined();
    expect(decodeIndexPayload(encodeIndexPayload({ text: "x", evidence: [] })).evidence)
      .toBeUndefined();
  });

  it("still reads a blob written before evidence existed", () => {
    const decoded = decodeIndexPayload(new TextEncoder().encode("legacy search text"));
    expect(decoded.text).toBe("legacy search text");
    expect(decoded.evidence).toBeUndefined();
  });

  it("drops a malformed evidence entry rather than carrying it", () => {
    const decoded = decodeIndexPayload(
      encodeIndexPayload({ evidence: [{ id: "ok" }, { full: "no id" }] as never }),
    );
    expect(decoded.evidence).toEqual([{ id: "ok" }]);
  });

  it("survives corrupt envelope bodies by yielding nothing", () => {
    const bytes = encodeIndexPayload({ text: "ok" });
    const corrupted = bytes.slice(0, bytes.length - 3);
    const decoded = decodeIndexPayload(corrupted);
    expect(decoded.text).toBeUndefined();
    expect(decoded.clip).toBeUndefined();
  });
});
