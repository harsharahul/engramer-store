import { describe, expect, it } from "vitest";
import { linkStarved } from "./streamhealth";

/**
 * The honest maths behind the "keep it offline instead?" offer: a link
 * measurably slower than a clip's own byte rate cannot play it, and the
 * player should say so once instead of spinning forever. Unknown numbers
 * never accuse; a borderline link gets headroom before being named.
 */
describe("linkStarved", () => {
  const MB = 1024 * 1024;

  it("names a link that cannot carry the clip", () => {
    // A 300MB, 30-second clip needs ~10MB/s; the link delivers 0.25MB/s.
    expect(linkStarved(0.25 * MB, 300 * MB, 30)).toBe(true);
  });

  it("stays quiet when the link comfortably carries it", () => {
    expect(linkStarved(20 * MB, 300 * MB, 30)).toBe(false);
  });

  it("gives a borderline link headroom instead of nagging", () => {
    // Exactly at the clip's rate: playable with buffering wobble; the
    // offer would be noise. Only a clear shortfall speaks.
    expect(linkStarved(10 * MB, 300 * MB, 30)).toBe(false);
  });

  it("never accuses on unknown numbers", () => {
    expect(linkStarved(0, 300 * MB, 30)).toBe(false);
    expect(linkStarved(10 * MB, 300 * MB, null)).toBe(false);
    expect(linkStarved(10 * MB, 300 * MB, 0)).toBe(false);
  });
});
