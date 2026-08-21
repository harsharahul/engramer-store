import { describe, expect, it } from "vitest";
import { isMediaFetch, isStreamableMime, mediaResponseHeaders } from "./mediapolicy";

describe("isStreamableMime", () => {
  it("accepts video and audio types only", () => {
    expect(isStreamableMime("video/mp4")).toBe(true);
    expect(isStreamableMime("audio/mpeg")).toBe(true);
    expect(isStreamableMime("VIDEO/quicktime")).toBe(true);
  });

  it("refuses everything a browser could execute or render as a document", () => {
    expect(isStreamableMime("text/html")).toBe(false);
    expect(isStreamableMime("image/svg+xml")).toBe(false);
    expect(isStreamableMime("application/pdf")).toBe(false);
    expect(isStreamableMime("application/octet-stream")).toBe(false);
    expect(isStreamableMime("")).toBe(false);
    // A declared type with a suffix trick is still not media.
    expect(isStreamableMime("text/html; charset=video/mp4")).toBe(false);
  });
});

describe("isMediaFetch", () => {
  it("allows requests made by media elements", () => {
    expect(isMediaFetch({ mode: "no-cors", destination: "video" })).toBe(true);
    expect(isMediaFetch({ mode: "no-cors", destination: "audio" })).toBe(true);
  });

  it("refuses navigations and every non-media destination", () => {
    expect(isMediaFetch({ mode: "navigate", destination: "document" })).toBe(false);
    expect(isMediaFetch({ mode: "navigate", destination: "" })).toBe(false);
    expect(isMediaFetch({ mode: "cors", destination: "" })).toBe(false);
    expect(isMediaFetch({ mode: "no-cors", destination: "iframe" })).toBe(false);
    expect(isMediaFetch({ mode: "no-cors", destination: "image" })).toBe(false);
    expect(isMediaFetch({ mode: "no-cors", destination: "script" })).toBe(false);
    // A media destination claimed on a navigation is still a navigation.
    expect(isMediaFetch({ mode: "navigate", destination: "video" })).toBe(false);
  });
});

describe("mediaResponseHeaders", () => {
  it("pins the served type and forbids the response from acting as a document", () => {
    const headers = mediaResponseHeaders("video/mp4");
    expect(headers["content-type"]).toBe("video/mp4");
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["content-security-policy"]).toContain("sandbox");
    expect(headers["content-security-policy"]).toContain("default-src 'none'");
    expect(headers["cross-origin-resource-policy"]).toBe("same-origin");
  });
});
