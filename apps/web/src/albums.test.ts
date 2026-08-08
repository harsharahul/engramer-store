import { describe, expect, it } from "vitest";
import {
  albumSlug,
  albumTag,
  albumTitle,
  albumsFrom,
  isAlbumTag,
  isReservedTag,
} from "./albums";

describe("albumSlug", () => {
  it("lowercases and hyphenates like the trip slug", () => {
    expect(albumSlug("Holidays 2026")).toBe("holidays-2026");
    expect(albumSlug("  Röme &  Paris!! ")).toBe("r-me-paris");
    expect(albumSlug("---")).toBe("");
  });
});

describe("albumTag", () => {
  it("prefixes the slug", () => {
    expect(albumTag("Holidays 2026")).toBe("album:holidays-2026");
  });

  it("returns null when nothing survives slugging", () => {
    expect(albumTag("   ")).toBeNull();
    expect(albumTag("!!!")).toBeNull();
  });
});

describe("albumTitle", () => {
  it("round-trips a name through the tag readably", () => {
    expect(albumTitle(albumTag("holidays 2026")!)).toBe("Holidays 2026");
    expect(albumTitle("album:new-york")).toBe("New York");
  });

  it("leaves non-album tags untouched", () => {
    expect(albumTitle("trip:rome-2026-03")).toBe("trip:rome-2026-03");
    expect(albumTitle("receipts")).toBe("receipts");
  });
});

describe("isAlbumTag / isReservedTag", () => {
  it("recognizes the namespaces", () => {
    expect(isAlbumTag("album:x")).toBe(true);
    expect(isAlbumTag("album:")).toBe(false);
    expect(isAlbumTag("albums")).toBe(false);
    expect(isReservedTag("album:x")).toBe(true);
    expect(isReservedTag("trip:rome-2026-03")).toBe(true);
    expect(isReservedTag("holiday")).toBe(false);
  });
});

describe("albumsFrom", () => {
  const files = [
    { id: "a", tags: ["album:beach", "sunny"], mtime: 10 },
    { id: "b", tags: ["album:beach", "album:city"], mtime: 30 },
    { id: "c", tags: ["album:city", "trip:rome-2026-03"], mtime: 20 },
    { id: "d", tags: ["receipts"], mtime: 99 },
  ];

  it("counts members, picks the newest cover, sorts by title", () => {
    expect(albumsFrom(files)).toEqual([
      { tag: "album:beach", title: "Beach", count: 2, coverFileId: "b" },
      { tag: "album:city", title: "City", count: 2, coverFileId: "b" },
    ]);
  });

  it("ignores trip tags and free tags", () => {
    expect(albumsFrom([files[2]!, files[3]!]).map((a) => a.tag)).toEqual(["album:city"]);
  });

  it("tolerates missing mtime", () => {
    expect(albumsFrom([{ id: "x", tags: ["album:misc"] }])[0]!.coverFileId).toBe("x");
  });
});
