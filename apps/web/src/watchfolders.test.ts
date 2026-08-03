import { describe, expect, it } from "vitest";
import { alreadyInLibrary, destinationFor, folderName } from "./watchfolders";

/**
 * The watch-folder path had no tests, and it is where both of the worst
 * bugs lived: every file stored corrupted, and the same files uploaded
 * again on every scan. It crosses a process boundary, which no browser
 * harness can drive, so its decisions are pinned here instead.
 */
describe("deciding whether a watched file is already in the vault", () => {
  const library = [
    { name: "tickets.pdf", size: 530898, trashed: false },
    { name: "old.pdf", size: 1000, trashed: true },
  ];

  it("recognises a file already stored", () => {
    expect(alreadyInLibrary({ name: "tickets.pdf", size: 530898 }, library)).toBe(true);
  });

  it("treats a different size as a different file", () => {
    // The corruption made this permanent: uploads stored a larger, mangled
    // copy, so the size never matched and every scan uploaded it again.
    expect(alreadyInLibrary({ name: "tickets.pdf", size: 1889241 }, library)).toBe(false);
  });

  it("does not count a file in the trash as already stored", () => {
    expect(alreadyInLibrary({ name: "old.pdf", size: 1000 }, library)).toBe(false);
  });

  it("finds nothing in an empty library, which is why the scan must wait for it", () => {
    // Judging against a library that has not loaded is how a refresh
    // re-uploaded everything it already had.
    expect(alreadyInLibrary({ name: "tickets.pdf", size: 530898 }, [])).toBe(false);
  });
});

describe("deciding where a watched file lands", () => {
  const roots = ["/Users/me/sync folder", "/Users/me/sync folder/receipts"];
  const sorted = () => "sorted" as const;
  const mirrored = () => "mirrored" as const;

  const file = { path: "/Users/me/sync folder/2026/tickets.pdf", rel_dirs: ["2026"] };

  it("sorts by kind and tags with the folder's name", () => {
    expect(destinationFor(file, roots, sorted)).toEqual({
      path: ["2026"],
      tags: ["sync folder"],
    });
  });

  it("recreates the folder when asked to keep it", () => {
    expect(destinationFor(file, roots, mirrored)).toEqual({
      path: ["sync folder", "2026"],
    });
  });

  it("attributes a file to the nearest watched folder containing it", () => {
    const nested = { path: "/Users/me/sync folder/receipts/jan.pdf", rel_dirs: [] };
    expect(destinationFor(nested, roots, sorted).tags).toEqual(["receipts"]);
  });

  it("leaves a file alone when no watched folder claims it", () => {
    const stray = { path: "/tmp/elsewhere/file.pdf", rel_dirs: [] };
    expect(destinationFor(stray, roots, sorted)).toEqual({ path: [] });
  });
});

describe("naming a folder", () => {
  it("takes the last segment, whatever the separator or trailing slash", () => {
    expect(folderName("/Users/me/sync folder")).toBe("sync folder");
    expect(folderName("/Users/me/sync folder/")).toBe("sync folder");
    expect(folderName("C:\\Users\\me\\Scans")).toBe("Scans");
  });
});
