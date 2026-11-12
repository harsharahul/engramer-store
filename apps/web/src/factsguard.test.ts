import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * One predicate decides which facts count: `isTracked`, confirmed by the
 * owner or accepted on evidence. Code that reads `.confirmed` on its own
 * counts only the owner's yes and silently ignores everything accepted, a
 * second definition that drifts. Only intel/facts.ts, which defines the
 * predicates, may read the field.
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

/**
 * A message's own date is what a date with no year is read against. A file
 * is read when it is stored and again when it is saved over or swept; a
 * reading that left the date out would find fewer facts than the first one
 * and drop what the first one found. Every reading states it.
 */
describe("every reading of a file says when a message was written", () => {
  it("passes writtenAt in each scanForFacts call of the store and the upload path", () => {
    const root = join(__dirname);
    const calls = ["store.ts", "transfer.ts"].flatMap((name) => {
      const source = readFileSync(join(root, name), "utf8");
      // The call's own arguments: none is longer than a few lines.
      return [...source.matchAll(/scanForFacts\(\{/g)].map((match) => ({ name, call: source.slice(match.index, match.index + 400) }));
    });
    expect(calls.length).toBeGreaterThanOrEqual(3);
    expect(calls.filter(({ call }) => !call.includes("writtenAt")).map(({ name, call }) => `${name}: ${call.slice(0, 60)}`)).toEqual([]);
  });
});

describe("one predicate decides which facts count", () => {
  it("reads .confirmed nowhere outside intel/facts.ts", () => {
    const root = join(__dirname);
    const offenders = sources(root)
      .filter((file) => relative(root, file) !== join("intel", "facts.ts"))
      .flatMap((file) =>
        readFileSync(file, "utf8")
          .split("\n")
          .map((line, i) => ({ line, i }))
          .filter(({ line }) => /\.confirmed\b/.test(line))
          .map(({ i }) => `${relative(root, file)}:${i + 1}`),
      );
    expect(offenders).toEqual([]);
  });
});
