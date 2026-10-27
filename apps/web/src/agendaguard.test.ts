import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Dates and trips have one model (intel/agenda.ts) and one predicate each
 * for what a trip tag is and which kinds are dated. A surface that writes
 * its own copy drifts from the others: the bell, the calendar and the
 * Notices panel once each had one. These guards keep the copies out.
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

/** Lines matching any pattern, as path:line, in files outside the allowed ones. */
function offenders(patterns: RegExp[], allowed: string[]): string[] {
  const root = join(__dirname);
  return sources(root)
    .filter((file) => !allowed.includes(relative(root, file)))
    .flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .map((line, i) => ({ line, i }))
        .filter(({ line }) => patterns.some((pattern) => pattern.test(line)))
        .map(({ i }) => `${relative(root, file)}:${i + 1}`),
    );
}

describe("one model for dates and trips", () => {
  it("tests a trip tag only through isTripTag", () => {
    // A notice key built as `trip:${tag}` is the notice namespace, not a tag test.
    expect(offenders([/startsWith\(\s*["'`]trip:/, /["']trip:/], [join("intel", "trips.ts")])).toEqual([]);
  });

  it("reads dated kinds only through the model", () => {
    expect(offenders([/\bDATED_KINDS\b/], [join("intel", "facts.ts"), join("intel", "agenda.ts")])).toEqual([]);
  });

  it("defines isDated once", () => {
    expect(offenders([/\b(?:function|const)\s+isDated\b/], [join("intel", "facts.ts")])).toEqual([]);
  });
});
