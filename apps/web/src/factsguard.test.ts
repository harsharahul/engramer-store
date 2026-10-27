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
