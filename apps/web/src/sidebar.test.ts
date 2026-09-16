import { describe, expect, it } from "vitest";
import { albumsFrom, type Album } from "./albums";
import { orderCollections } from "./sidebar";

/**
 * User-made collections lead with what the user pinned, then what changed
 * most recently, then the rest by title, so a new or freshly grown album
 * is near the top of its group instead of wherever its name falls.
 */
describe("collection order in the sidebar", () => {
  const album = (title: string, changedAt: number): Album => ({
    tag: `album:${title.toLowerCase()}`,
    title,
    count: 1,
    changedAt,
  });

  it("puts pinned collections first, then the most recently changed, then the rest by title", () => {
    const albums = [album("Zurich", 10), album("Alps", 50), album("Berlin", 30), album("Coast", 30)];
    const ordered = orderCollections(albums, new Set(["album:zurich"]));
    expect(ordered.map((a) => a.title)).toEqual(["Zurich", "Alps", "Berlin", "Coast"]);
  });

  it("orders pinned collections among themselves by title", () => {
    const albums = [album("Zurich", 10), album("Alps", 50)];
    const ordered = orderCollections(albums, new Set(["album:zurich", "album:alps"]));
    expect(ordered.map((a) => a.title)).toEqual(["Alps", "Zurich"]);
  });
});

describe("albumsFrom remembers when an album last changed", () => {
  it("takes the newest member's time", () => {
    const albums = albumsFrom([
      { id: "a", tags: ["album:trip"], mtime: 100 },
      { id: "b", tags: ["album:trip"], mtime: 300 },
      { id: "c", tags: ["album:trip"], mtime: 200 },
    ]);
    expect(albums[0]?.changedAt).toBe(300);
  });
});
