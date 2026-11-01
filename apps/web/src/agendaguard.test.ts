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
    expect(offenders([/startsWith\(\s*["'`]trip:/, /["']trip:/, /\/\^?trip:/], [join("intel", "trips.ts")])).toEqual([]);
    // The prefix itself: trips.ts defines it, albums.ts reserves it.
    expect(offenders([/\bTRIP_PREFIX\b/], [join("intel", "trips.ts"), "albums.ts"])).toEqual([]);
  });

  it("reads dated kinds only through the model", () => {
    // facts.ts defines them and asks with them (offeredFacts); agenda.ts is the model.
    expect(offenders([/\bDATED_KINDS\b/], [join("intel", "facts.ts"), join("intel", "agenda.ts")])).toEqual([]);
  });

  it("filters tracked dates only through the model", () => {
    // Calls, not imports: a file may use either predicate on its own.
    expect(offenders([/\bisTracked\(.*\bisDated\(/, /\bisDated\(.*\bisTracked\(/], [join("intel", "agenda.ts")])).toEqual([]);
  });

  it("defines isDated once", () => {
    expect(offenders([/\b(?:function|const)\s+isDated\b/], [join("intel", "facts.ts")])).toEqual([]);
  });

  it("the Timeline reads rows, not facts", () => {
    const timeline = sources(join(__dirname, "components"))
      .map((file) => relative(join(__dirname), file))
      .filter((path) => /^components\/(?:Timeline[^/]*|CalendarView)\.tsx$/.test(path));
    const others = sources(join(__dirname)).map((file) => relative(join(__dirname), file)).filter((path) => !timeline.includes(path));
    expect(offenders([/\bitemsOf\(/, /\bofferedFacts\(/], others)).toEqual([]);
  });

  it("the Timeline is the only home for time", () => {
    // The old places are gone, and so is the sort that fed one of them.
    expect(offenders([/kind:\s*"calendar"/, /kind:\s*"expiring"/, /\bsoonestDated\b/], [])).toEqual([]);
    // The Month view lives inside the Timeline.
    expect(offenders([/<CalendarView\b/], [join("components", "TimelineView.tsx")])).toEqual([]);
    // The Timeline is the first place in the sidebar.
    const vault = readFileSync(join(__dirname, "components", "Vault.tsx"), "utf8");
    expect(vault.indexOf('place("timeline"')).toBeGreaterThan(-1);
    expect(vault.indexOf('place("timeline"')).toBeLessThan(vault.indexOf('place("files"'));
  });

  it("plans trips in one place", () => {
    // Whatever assembles or offers a trip reads planTrips' plans.
    expect(offenders([/\bsuggestTrips\(/], [join("intel", "agenda.ts"), join("intel", "trips.ts")])).toEqual([]);
  });
});
