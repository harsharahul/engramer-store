import { describe, expect, it } from "vitest";
import { isCurrentRuntimeAsset, isRuntimeAssetPath, warmList } from "./runtimeassets";

describe("runtime asset identification", () => {
  it("recognizes every runtime mount and nothing else", () => {
    expect(isRuntimeAssetPath("/ort/1.2.3/ort-wasm.wasm")).toBe(true);
    expect(isRuntimeAssetPath("/ocr/5.1.1-6.0.0/worker.min.js")).toBe(true);
    expect(isRuntimeAssetPath("/zxing/3.1.2/zxing_reader.wasm")).toBe(true);
    expect(isRuntimeAssetPath("/gliner-ort/1.19.0/ort-wasm.mjs")).toBe(true);
    expect(isRuntimeAssetPath("/assets/index-abc.js")).toBe(false);
    expect(isRuntimeAssetPath("/api/files/x/data")).toBe(false);
    expect(isRuntimeAssetPath("/models/clip/model.onnx")).toBe(false);
  });

  it("keeps current-version entries and the stable language data, evicts the rest", () => {
    const bases = ["/ort/2.0.0/", "/ocr/6.0.0-6.0.0/"];
    expect(isCurrentRuntimeAsset("/ort/2.0.0/runtime.wasm", bases)).toBe(true);
    expect(isCurrentRuntimeAsset("/ort/1.9.0/runtime.wasm", bases)).toBe(false);
    expect(isCurrentRuntimeAsset("/ocr/5.0.0-5.0.0/worker.min.js", bases)).toBe(false);
    expect(isCurrentRuntimeAsset("/ocr/eng.traineddata.gz", bases)).toBe(true);
  });

  it("warms only what the enabled features will load", () => {
    expect(warmList({ semantic: false, ocr: false })).toEqual([]);
    const semantic = warmList({ semantic: true, ocr: false });
    expect(semantic.some((u) => u.includes("asyncify.wasm"))).toBe(true);
    expect(semantic.some((u) => u.includes("tesseract"))).toBe(false);
    const both = warmList({ semantic: true, ocr: true });
    expect(both).toContain("/ocr/eng.traineddata.gz");
    expect(both.some((u) => u.includes("worker.min.js"))).toBe(true);
  });
});
