/**
 * The one model of dates in the library. Every surface that lists dated
 * things (the bell, system notifications, the Notices panel, the calendar)
 * reads its rows here, each through a named window, so they cannot drift
 * apart: a date that counts counts everywhere, and nowhere else decides
 * what a dated row is.
 */

import { daysUntil } from "./dates";
import { shown } from "./describe";
import { basisOf, DATED_KINDS, isTracked, type DocumentKind, type Fact } from "./facts";
import {
  isTripTag,
  legPlaces,
  RECENT_PAST_DAYS,
  suggestTrips,
  tripTag,
  tripTitle,
  type TripSuggestion,
} from "./trips";

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
 * Whether a trip is still worth saying: not yet a month over, the same
 * reach back as Coming up. Years of imported mail hold many past trips,
 * and none of them is news.
 */
export function isTripCurrent(trip: Trip<AgendaFile>, now: number): boolean {
  return trip.end === undefined || daysUntil(trip.end, now) > -COMING_UP.past;
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
  const drafts: Draft[] = [];
  for (const candidate of candidates) {
    const members = candidate.fileIds.flatMap((id) => byId.get(id) ?? []);
    const journeys = await journeysOf(members, tailsOf);
    if (journeys.length === 0) {
      // Nothing booked exactly: the candidate is offered whole, by date.
      drafts.push({
        candidate,
        own: members.map((file) => file.id),
        minted: tripTag(candidate),
        start: candidate.start,
        end: candidate.end,
        ...(candidate.destination ? { destination: candidate.destination } : {}),
        exact: new Map(),
        weak: members.map((file) => file.id).sort(),
        why: candidate.why,
      });
      continue;
    }
    // A cluster of dates can hold several journeys; each is its own trip,
    // and what falls between them belongs to none.
    const booked = new Set(journeys.flatMap((journey) => journey.map((booking) => booking.file.id)));
    for (const journey of journeys) {
      const first = journey.reduce((at, booking) => (booking.start < at ? booking.start : at), journey[0]!.start);
      const last = journey.reduce((at, booking) => (booking.end > at ? booking.end : at), journey[0]!.end);
      const exact = new Map<string, TripEvidence>(journey.map((booking) => [booking.file.id, "booking"]));
      const weak: string[] = [];
      for (const file of members) {
        if (booked.has(file.id)) {
          continue;
        }
        if (bookedWhileAway(file, first, last)) {
          exact.set(file.id, "away");
        } else if (
          file.facts
            .filter((fact) => fact.kind === "event" && isTracked(fact))
            .every((fact) => fact.value >= first && fact.value <= last)
        ) {
          weak.push(file.id);
        }
      }
      const own = [...exact.keys(), ...weak];
      walkExactLinks(exact, { byId, tailsOf, byTail, children }, first, last);
      const destination = (await legPlaces(journey.flatMap((booking) => booking.legs))).destination;
      drafts.push({
        candidate,
        own,
        minted: tripTag({ id: candidate.id, fileIds: [], start: first, end: last, why: [], ...(destination ? { destination } : {}) }),
        start: first,
        end: last,
        ...(destination ? { destination } : {}),
        anchorId: journey[0]!.file.id,
        exact,
        weak: weak.sort(),
        why: [`dates fall together, ${shown(first)} to ${shown(last)}`, ...(destination ? [`both point at ${destination}`] : [])],
      });
    }
  }
  return finishPlans(drafts, byId, now);
}

/** A booking reference or a shared email reaches this far either side of a journey. */
const JOIN_REACH_DAYS = 45;

const dayNumber = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 86_400_000;

/** One file's exact travel legs, when they run and where they start and end. */
interface Booking {
  file: PlanFile;
  legs: Fact[];
  start: string;
  end: string;
  from?: string;
  to?: string;
  tails: string[];
}

/**
 * The journeys among a candidate's files: bookings whose legs overlap,
 * that share a booking reference, or where one sets out from the city a
 * one-way booking arrived in. A round trip home ends its journey, so a
 * commuter's weekly flights stay separate trips.
 */
async function journeysOf(members: readonly PlanFile[], tailsOf: ReadonlyMap<string, string[]>): Promise<Booking[][]> {
  const bookings: Booking[] = [];
  for (const file of members) {
    const legs = file.facts.filter(travelLeg);
    if (legs.length === 0) {
      continue;
    }
    const dates = legs.map((fact) => fact.value).sort();
    const { from, to } = await legPlaces(legs);
    bookings.push({
      file,
      legs,
      start: dates[0]!,
      end: dates[dates.length - 1]!,
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      tails: tailsOf.get(file.id) ?? [],
    });
  }
  bookings.sort((a, b) => a.start.localeCompare(b.start) || a.file.id.localeCompare(b.file.id));
  const parent = bookings.map((_, i) => i);
  const root = (i: number): number => (parent[i] === i ? i : (parent[i] = root(parent[i]!)));
  for (let i = 0; i < bookings.length; i++) {
    for (let j = i + 1; j < bookings.length; j++) {
      const a = bookings[i]!;
      const b = bookings[j]!;
      const overlaps = b.start <= a.end;
      const shared = a.tails.some((tail) => b.tails.includes(tail));
      const continues =
        a.to !== undefined &&
        a.to !== a.from &&
        b.from === a.to &&
        dayNumber(b.start) - dayNumber(a.end) <= JOIN_REACH_DAYS;
      if (overlaps || shared || continues) {
        parent[root(j)] = root(i);
      }
    }
  }
  const groups = new Map<number, Booking[]>();
  bookings.forEach((booking, i) => groups.set(root(i), [...(groups.get(root(i)) ?? []), booking]));
  return [...groups.values()];
}

/**
 * Adds what links to a journey exactly: a document sharing a booking
 * reference with it, and the email a member came in or the files that
 * came with it, transitively. Only near the journey: a dated document
 * joins when one of its dates falls within the reach, and an undated one
 * only through its email, because a four-character tail recurs over years.
 */
function walkExactLinks(
  exact: Map<string, TripEvidence>,
  index: {
    byId: ReadonlyMap<string, PlanFile>;
    tailsOf: ReadonlyMap<string, string[]>;
    byTail: ReadonlyMap<string, string[]>;
    children: ReadonlyMap<string, string[]>;
  },
  first: string,
  last: string,
): void {
  const low = dayNumber(first) - JOIN_REACH_DAYS;
  const high = dayNumber(last) + JOIN_REACH_DAYS;
  const near = (file: PlanFile, evidence: TripEvidence) => {
    const dates = file.facts.filter((fact) => DATED_KINDS.has(fact.kind) && !fact.dismissed).map((fact) => dayNumber(fact.value));
    return dates.length === 0 ? evidence === "email" : dates.some((day) => day >= low && day <= high);
  };
  const queue = [...exact.keys()].sort();
  const join = (id: string | undefined, evidence: TripEvidence) => {
    const file = id === undefined ? undefined : index.byId.get(id);
    if (file && !exact.has(file.id) && near(file, evidence)) {
      exact.set(file.id, evidence);
      queue.push(file.id);
    }
  };
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    for (const tail of index.tailsOf.get(next) ?? []) {
      for (const id of index.byTail.get(tail) ?? []) {
        join(id, "reference");
      }
    }
    join(index.byId.get(next)!.mailParent, "email");
    for (const id of index.children.get(next) ?? []) {
      join(id, "email");
    }
  }
}

/** A plan before its tag is settled. */
interface Draft {
  candidate: TripSuggestion;
  /** Its own members, whose tags name it; files pulled in by a link never do. */
  own: string[];
  minted: string;
  start: string;
  end: string;
  destination?: string;
  anchorId?: string;
  exact: Map<string, TripEvidence>;
  weak: string[];
  why: string[];
}

/**
 * Settles each plan's tag: the trip tag its own members carry most, else
 * a new one, made distinct from every other trip so two journeys never
 * share a name (a second Lisbon trip that month reads "Lisbon 2").
 */
function finishPlans(drafts: readonly Draft[], byId: ReadonlyMap<string, PlanFile>, now: number): TripPlan[] {
  const holders = new Map<string, Set<string>>();
  for (const file of byId.values()) {
    for (const tag of file.tags.filter(isTripTag)) {
      const held = holders.get(tag) ?? new Set<string>();
      held.add(file.id);
      holders.set(tag, held);
    }
  }
  const ordered = [...drafts].sort(
    (a, b) => a.start.localeCompare(b.start) || (a.anchorId ?? a.weak[0] ?? "").localeCompare(b.anchorId ?? b.weak[0] ?? ""),
  );
  const taken = new Set<string>();
  return ordered.map((draft) => {
    const counts = new Map<string, number>();
    for (const id of draft.own) {
      for (const tag of byId.get(id)?.tags.filter(isTripTag) ?? []) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }
    let tag = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
    if (tag === undefined) {
      const own = new Set(draft.own);
      const free = (name: string) => !taken.has(name) && [...(holders.get(name) ?? [])].every((id) => own.has(id));
      tag = draft.minted;
      for (let n = 2; !free(tag); n++) {
        tag = draft.minted.replace(/-(\d{4}-\d{2})$/, `-${n}-$1`);
      }
    }
    taken.add(tag);
    return {
      tag,
      title: tripTitle(tag),
      start: draft.start,
      end: draft.end,
      ...(draft.destination ? { destination: draft.destination } : {}),
      ...(draft.anchorId ? { anchorId: draft.anchorId } : {}),
      exact: new Map([...draft.exact].sort((a, b) => a[0].localeCompare(b[0]))),
      weak: draft.weak,
      why: draft.why,
      dismissKeys: draft.anchorId ? [tag, `anchor:${draft.anchorId}`] : [`anchor:${draft.weak[0]}`],
      legacyId: draft.candidate.id,
      recent: daysUntil(draft.end, now) >= -RECENT_PAST_DAYS,
    };
  });
}

/**
 * Where the owner most likely lives: the city most of their exact
 * journeys set out from, ties settled alphabetically. Undefined when no
 * journey says.
 */
export async function homeCityGuess(files: readonly PlanFile[]): Promise<string | undefined> {
  const counts = new Map<string, number>();
  for (const file of files) {
    if (file.trashed) {
      continue;
    }
    const legs = file.facts.filter(travelLeg);
    const from = legs.length > 0 ? (await legPlaces(legs)).from : undefined;
    if (from) {
      counts.set(from, (counts.get(from) ?? 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
}

/**
 * Whether the owner refused this trip: by its tag or anchor, by the id a
 * refusal was kept under before plans, or, refused while it was dates
 * only, by a file still in it (any member of a date-only plan; one that
 * links exactly to a journey). A new receipt never brings it back, and
 * refusing a few local documents never hides a journey that later lists
 * them as date-only.
 */
export function isPlanDismissed(plan: TripPlan, dismissed: ReadonlySet<string>): boolean {
  const keyed = plan.anchorId !== undefined ? [...plan.exact.keys()] : plan.weak;
  return (
    plan.dismissKeys.some((key) => dismissed.has(key)) ||
    dismissed.has(plan.legacyId) ||
    keyed.some((id) => dismissed.has(`anchor:${id}`))
  );
}
