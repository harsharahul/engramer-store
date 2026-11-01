/**
 * The one model of dates in the library. Every surface that lists dated
 * things (the bell, system notifications, the Notices panel, the calendar)
 * reads its rows here, each through a named window, so they cannot drift
 * apart: a date that counts counts everywhere, and nowhere else decides
 * what a dated row is.
 */

import { daysUntil } from "./dates";
import { basisOf, DATED_KINDS, isTracked, type DocumentKind, type Fact } from "./facts";
import { isTripTag, RECENT_PAST_DAYS, suggestTrips, tripTag, tripTitle } from "./trips";

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

/** A file as trip planning reads it: its name, and the email it came with. */
export interface PlanFile extends AgendaFile {
  name: string;
  mailParent?: string;
}

/**
 * How a file belongs to a trip on its own: it books the journey, it shares
 * a booking reference with the trip, it came in the same email as part of
 * it, or it is an exact booking for a day the traveller is away.
 */
export type TripEvidence = "booking" | "reference" | "email" | "away";

/** A candidate trip, and how sure each of its documents is. */
export interface TripPlan {
  /** The trip's tag: the one already on its documents, or a new one. */
  tag: string;
  title: string;
  start: string;
  end: string;
  destination?: string;
  /** The earliest file booking a journey exactly; absent when only dates link the files. */
  anchorId?: string;
  /** Files that join on exact evidence, and which. */
  exact: ReadonlyMap<string, TripEvidence>;
  /** Members linked only by their dates, sorted. */
  weak: string[];
  /** The clustering's reasons, in words. */
  why: string[];
  /** What a refusal records: the tag and the anchor, never the member list. */
  dismissKeys: string[];
  /** The clustering's own id, under which refusals were kept before plans existed. */
  legacyId: string;
  /** Ended recently enough to still be offered for a yes. */
  recent: boolean;
}

/** On the owner's word or from a structured source; a model's reading never anchors a trip. */
function exactly(fact: Fact): boolean {
  const basis = basisOf(fact);
  return isTracked(fact) && (basis === "confirmed" || basis === "exact");
}

function travelLeg(fact: Fact): boolean {
  const label = fact.label ?? "";
  return (
    fact.kind === "event" &&
    exactly(fact) &&
    (/^(?:flight|train|bus|boat)\b/i.test(label) ||
      /^(?:pick[- ]?up|drop[- ]?off)\b/i.test(label) ||
      fact.document === "boarding-pass" ||
      fact.document === "car-rental")
  );
}

const BOOKING_REFERENCE = /\b(?:confirmation|booking|reservation|reference|pnr)\b/i;
const AWAY_DOCUMENTS: ReadonlySet<DocumentKind> = new Set([
  "hotel-booking",
  "event-ticket",
  "dining",
  "car-rental",
  "itinerary",
]);

/** The booking-reference tails a file states exactly. */
function bookingTails(file: PlanFile): string[] {
  return file.facts.flatMap((fact) =>
    fact.kind === "identifier" && exactly(fact) && BOOKING_REFERENCE.test(fact.label ?? "")
      ? [fact.masked ?? fact.value]
      : [],
  );
}

/** An exact booking for days strictly inside the journey; a check-out may fall on the way home. */
function bookedWhileAway(file: PlanFile, first: string, last: string): boolean {
  const events = file.facts.filter((fact) => fact.kind === "event" && isTracked(fact));
  return (
    events.length > 0 &&
    events.every(
      (fact) =>
        exactly(fact) &&
        AWAY_DOCUMENTS.has(fact.document) &&
        fact.value > first &&
        (fact.value < last || (fact.value === last && /check-?out/i.test(fact.label ?? ""))),
    )
  );
}

/**
 * Every candidate trip in the library, across all of time, with what links
 * each document to it. Deterministic, and the only caller of the
 * clustering: whatever assembles or offers a trip reads these plans.
 */
export async function planTrips(
  files: readonly PlanFile[],
  now: number,
  opts?: { extraPlaces?: ReadonlyMap<string, ReadonlySet<string>> },
): Promise<TripPlan[]> {
  const live = files.filter((file) => !file.trashed);
  const byId = new Map(live.map((file) => [file.id, file]));
  // Who shares a booking reference, and which email holds which files,
  // indexed once: a library of mail holds many past trips.
  const tailsOf = new Map<string, string[]>();
  const byTail = new Map<string, string[]>();
  const children = new Map<string, string[]>();
  for (const file of live) {
    const tails = bookingTails(file);
    tailsOf.set(file.id, tails);
    for (const tail of tails) {
      byTail.set(tail, [...(byTail.get(tail) ?? []), file.id]);
    }
    if (file.mailParent !== undefined) {
      children.set(file.mailParent, [...(children.get(file.mailParent) ?? []), file.id]);
    }
  }
  const candidates = await suggestTrips(live, now, opts?.extraPlaces, { recentPastDays: Infinity });
  const plans: TripPlan[] = [];
  for (const candidate of candidates) {
    const members = candidate.fileIds.flatMap((id) => byId.get(id) ?? []);
    const exact = new Map<string, TripEvidence>();
    let anchor: { id: string; at: string } | undefined;
    let first: string | undefined;
    let last: string | undefined;
    for (const file of members) {
      const legs = file.facts.filter(travelLeg).map((fact) => fact.value).sort();
      if (legs.length === 0) {
        continue;
      }
      exact.set(file.id, "booking");
      const earliest = legs[0]!;
      const latest = legs[legs.length - 1]!;
      if (!anchor || earliest < anchor.at || (earliest === anchor.at && file.id < anchor.id)) {
        anchor = { id: file.id, at: earliest };
      }
      first = first === undefined || earliest < first ? earliest : first;
      last = last === undefined || latest > last ? latest : last;
    }
    if (first !== undefined && last !== undefined) {
      for (const file of members) {
        if (!exact.has(file.id) && bookedWhileAway(file, first, last)) {
          exact.set(file.id, "away");
        }
      }
    }
    // A shared booking reference or a shared email pulls a document in from
    // anywhere in the library, and what it pulls in can pull in more.
    const queue = [...exact.keys()].sort();
    const join = (id: string | undefined, evidence: TripEvidence) => {
      if (id !== undefined && byId.has(id) && !exact.has(id)) {
        exact.set(id, evidence);
        queue.push(id);
      }
    };
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      for (const tail of tailsOf.get(next) ?? []) {
        for (const id of byTail.get(tail) ?? []) {
          join(id, "reference");
        }
      }
      join(byId.get(next)!.mailParent, "email");
      for (const id of children.get(next) ?? []) {
        join(id, "email");
      }
    }
    const weak = members.map((file) => file.id).filter((id) => !exact.has(id)).sort();
    const counts = new Map<string, number>();
    for (const id of [...exact.keys(), ...weak]) {
      for (const tag of byId.get(id)!.tags) {
        if (isTripTag(tag)) {
          counts.set(tag, (counts.get(tag) ?? 0) + 1);
        }
      }
    }
    const tag =
      [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? tripTag(candidate);
    plans.push({
      tag,
      title: tripTitle(tag),
      start: candidate.start,
      end: candidate.end,
      ...(candidate.destination ? { destination: candidate.destination } : {}),
      ...(anchor ? { anchorId: anchor.id } : {}),
      exact: new Map([...exact].sort((a, b) => a[0].localeCompare(b[0]))),
      weak,
      why: candidate.why,
      dismissKeys: anchor ? [tag, `anchor:${anchor.id}`] : [`anchor:${weak[0]}`],
      legacyId: candidate.id,
      recent: daysUntil(candidate.end, now) >= -RECENT_PAST_DAYS,
    });
  }
  return plans;
}

/**
 * Whether the owner refused this trip: by its tag or anchor, by the id a
 * refusal was kept under before plans, or while it was dates only, by any
 * file still in it. A new receipt or a new booking never brings it back.
 */
export function isPlanDismissed(plan: TripPlan, dismissed: ReadonlySet<string>): boolean {
  return (
    plan.dismissKeys.some((key) => dismissed.has(key)) ||
    dismissed.has(plan.legacyId) ||
    [...plan.exact.keys(), ...plan.weak].some((id) => dismissed.has(`anchor:${id}`))
  );
}
