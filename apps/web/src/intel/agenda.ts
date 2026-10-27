/**
 * The one model of dates in the library. Every surface that lists dated
 * things (the bell, system notifications, the Notices panel, the calendar)
 * reads its rows here, each through a named window, so they cannot drift
 * apart: a date that counts counts everywhere, and nowhere else decides
 * what a dated row is.
 */

import { daysUntil } from "./dates";
import { DATED_KINDS, isTracked, type Fact } from "./facts";

export interface AgendaFile {
  id: string;
  tags: readonly string[];
  facts: Fact[];
  trashed: boolean;
}

export interface AgendaItem<F extends AgendaFile = AgendaFile> {
  file: F;
  fact: Fact;
  /** Whole days from today, negative once passed. */
  days: number;
}

/** Which rows a surface asks for. */
export type AgendaWindow = { name: "coming-up" } | { name: "all" };

/** Near enough to say without being asked: a month back, four months on. */
export const COMING_UP = { past: 30, ahead: 120 } as const;

/** A date that counts: tracked, and of a dated kind. */
export function isTrackedDate(fact: Fact): boolean {
  return isTracked(fact) && DATED_KINDS.has(fact.kind);
}

/** The dated rows of the live files in a window, soonest first. */
export function itemsOf<F extends AgendaFile>(files: readonly F[], now: number, window: AgendaWindow): AgendaItem<F>[] {
  const items: AgendaItem<F>[] = [];
  for (const file of files) {
    if (file.trashed) {
      continue;
    }
    for (const fact of file.facts) {
      if (!isTrackedDate(fact)) {
        continue;
      }
      const days = daysUntil(fact.value, now);
      if (window.name === "coming-up" && !(days > -COMING_UP.past && days < COMING_UP.ahead)) {
        continue;
      }
      items.push({ file, fact, days });
    }
  }
  // A row without a time is the whole day, so it leads the timed ones.
  return items.sort(
    (a, b) =>
      a.days - b.days ||
      (a.fact.time ?? "").localeCompare(b.fact.time ?? "") ||
      a.file.id.localeCompare(b.file.id),
  );
}
