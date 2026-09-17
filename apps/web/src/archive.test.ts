import { gzipSync, strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { archiveFormat, cleanPath, extractArchive, listArchive } from "./archive";

/**
 * An archive previews as its listing and extracts through the ordinary
 * upload path. Entry paths are cleaned so an archive from a stranger can
 * never name a place outside the folder it is extracted into.
 */

/** A minimal tar: 512-byte headers, data padded to 512, two zero blocks. */
function tar(files: Array<[string, string]>): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const [name, content] of files) {
    const data = strToU8(content);
    const header = new Uint8Array(512);
    header.set(strToU8(name), 0);
    header.set(strToU8("0000644\0"), 100);
    header.set(strToU8(data.length.toString(8).padStart(11, "0") + "\0"), 124);
    header[156] = "0".charCodeAt(0);
    header.set(strToU8("ustar\0"), 257);
    blocks.push(header, data, new Uint8Array((512 - (data.length % 512)) % 512));
  }
  blocks.push(new Uint8Array(1024));
  const total = blocks.reduce((n, b) => n + b.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const block of blocks) {
    out.set(block, offset);
    offset += block.length;
  }
  return out;
}

describe("archives", () => {
  it("recognises the formats it opens", () => {
    expect(archiveFormat("a.zip")).toBe("zip");
    expect(archiveFormat("a.tar")).toBe("tar");
    expect(archiveFormat("a.tar.gz")).toBe("tgz");
    expect(archiveFormat("a.tgz")).toBe("tgz");
    expect(archiveFormat("a.7z")).toBeNull();
  });

  it("lists a zip with its folders implied, skipping Finder litter", () => {
    const zip = zipSync({
      "notes/todo.txt": strToU8("milk"),
      "notes/2026/plan.md": strToU8("# plan"),
      "__MACOSX/notes/._todo.txt": strToU8("x"),
      ".DS_Store": strToU8("x"),
    });
    const listed = listArchive(zip, "notes.zip");
    expect(listed.map((e) => `${e.directory ? "d " : "f "}${e.path}`)).toEqual([
      "d notes",
      "d notes/2026",
      "f notes/2026/plan.md",
      "f notes/todo.txt",
    ]);
    expect(listed.find((e) => e.path === "notes/todo.txt")?.size).toBe(4);
  });

  it("extracts a tar and a gzipped tar", () => {
    const plain = tar([
      ["a.txt", "alpha"],
      ["dir/b.txt", "beta"],
    ]);
    expect(extractArchive(plain, "x.tar").map((e) => e.path)).toEqual(["a.txt", "dir/b.txt"]);
    const gz = gzipSync(plain);
    const entries = extractArchive(gz, "x.tar.gz");
    expect(new TextDecoder().decode(entries[1]!.data)).toBe("beta");
  });

  it("never lets an entry escape the extraction folder", () => {
    expect(cleanPath("../../etc/passwd")).toBe("etc/passwd");
    expect(cleanPath("/abs/path.txt")).toBe("abs/path.txt");
    expect(cleanPath("a\\b\\..\\c.txt")).toBe("a/b/c.txt");
    const zip = zipSync({ "../evil.txt": strToU8("x") });
    expect(extractArchive(zip, "e.zip").map((e) => e.path)).toEqual(["evil.txt"]);
  });

  it("refuses formats it cannot read", () => {
    expect(() => extractArchive(new Uint8Array(10), "a.7z")).toThrow(/not an archive/);
  });
});
