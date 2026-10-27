/**
 * The one model of dates in the library. Every surface that lists dated
 * things (the bell, system notifications, the Notices panel, the calendar)
 * reads its rows here, each through a named window, so they cannot drift
 * apart: a date that counts counts everywhere, and nowhere else decides
 * what a dated row is.
 */

import { daysUntil } from "./dates";
import { DATED_KINDS, isTracked, type Fact } from "./facts";
import { isTripTag, tripTitle } from "./trips";

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

/** A trip: a shared tag, the files that carry it, and when it runs. */
export interface Trip<F extends AgendaFile = AgendaFile> {
  tag: string;
  title: string;
  members: F[];
  /** Earliest and latest tracked event among the members; absent while none is. */
  start?: string;
  end?: string;
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

/** Every trip in the live files, by tag; a file in two trips belongs to both. */
export function tripsOf<F extends AgendaFile>(files: readonly F[]): Trip<F>[] {
  const byTag = new Map<string, Trip<F>>();
  for (const file of files) {
    if (file.trashed) {
      continue;
    }
    for (const tag of file.tags) {
      if (!isTripTag(tag)) {
        continue;
      }
      let trip = byTag.get(tag);
      if (!trip) {
        trip = { tag, title: tripTitle(tag), members: [] };
        byTag.set(tag, trip);
      }
      trip.members.push(file);
      for (const fact of file.facts) {
        if (fact.kind !== "event" || !isTracked(fact)) {
          continue;
        }
        if (trip.start === undefined || fact.value < trip.start) {
          trip.start = fact.value;
        }
        if (trip.end === undefined || fact.value > trip.end) {
          trip.end = fact.value;
        }
      }
    }
  }
  return [...byTag.values()].sort((a, b) => a.tag.localeCompare(b.tag));
}

/**
 * Whether the library holds anything dated: a trip, or a date that counts.
 * Asked on every render, so it stops at the first one rather than building
 * the lists; the predicates are the ones the lists use.
 */
export function hasAgenda(files: readonly AgendaFile[]): boolean {
  return files.some((file) => !file.trashed && (file.tags.some(isTripTag) || file.facts.some(isTrackedDate)));
}
