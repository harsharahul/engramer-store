import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The words the app shows use plain punctuation: periods, colons, commas
 * and parentheses, never an em dash or an en dash between clauses. The
 * check reads every source line outside a comment. A dash inside a
 * pattern's character class is how the readers recognise one in a
 * document, and stays.
 */

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return sources(path);
    }
    return /\.(ts|tsx)$/.test(path) && !/\.test\.tsx?$/.test(path) ? [path] : [];
  });
}

const DASH = /[–—]/;
/** A dash listed among the characters a pattern accepts: `[-–/.]`. */
const IN_CLASS = /\[[^\]\n]*[–—][^\]\n]*\]/g;

describe("the words the app shows", () => {
  it("hold no em dash or en dash", () => {
    const root = join(__dirname);
    const found: string[] = [];
    for (const path of sources(root)) {
      readFileSync(path, "utf8")
        .split("\n")
        .forEach((line, index) => {
          const code = line.trim();
          if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")) {
            return;
          }
          if (DASH.test(code.replace(IN_CLASS, ""))) {
            found.push(`${relative(root, path)}:${index + 1}: ${code.slice(0, 100)}`);
          }
        });
    }
    expect(found).toEqual([]);
  });
});
