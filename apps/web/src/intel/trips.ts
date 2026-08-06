/**
 * Trips assembled from what separate documents each half-know.
 *
 * A trip is an entity no single document contains: the flight knows the
 * airports, the hotel knows the nights, and only a reader with the whole
 * library can see that they belong together. Clustering here is
 * deterministic and confirm-first: it reads only facts the owner confirmed
 * or a structured source stated exactly, it proposes rather than asserts,
 * and a confirmed trip becomes nothing more exotic than a shared tag, which
 * the Library machinery already knows how to present. The trip's span and
 * itinerary derive live from the members' facts, so corrections propagate
 * on their own.
 *
 * Three ways in, in order of strength: overlapping date windows, a shared
 * booking-reference tail, and a shared destination. Tails rather than full
 * references, because full identifiers never leave the evidence blob.
 */

import { lookupAirport } from "./airports";
import type { Fact } from "./facts";

export interface TripFile {
  id: string;
  name: string;
  trashed?: boolean;
  facts: Fact[];
}

export interface TripSuggestion {
  /** Stable for a given membership, so a dismissal can be remembered. */
  id: string;
  fileIds: string[];
  start: string;
  end: string;
  destination?: string;
  /** The evidence, in words, for whoever asks why. */
  why: string[];
}

export interface ItineraryLeg {
  at: string;
  time?: string;
  zone?: string;
  title: string;
  fileId: string;
  /** The fact this leg came from, so a card can act on it (calendar export). */
  factId: string;
  /** Airport codes the title mentions, resolved against the table. */
  codes?: string[];
  kind: "flight" | "stay" | "car" | "other";
}

/** Sources whose full-confidence facts may cluster without confirmation. */
const EXACT: ReadonlySet<Fact["source"]> = new Set(["barcode", "mrz", "jsonld", "user"]);

/** Events this many days apart still belong to one candidate. */
const WINDOW_DAYS = 14;
/** Reference and destination bridges reach at most this far. */
const MERGE_GAP_DAYS = 45;
/** A trip this long over is history, not a suggestion. */
const RECENT_PAST_DAYS = 60;

function usable(fact: Fact): boolean {
  if (fact.dismissed) {
    return false;
  }
  return fact.confirmed === true || (fact.confidence === 1 && EXACT.has(fact.source));
}

function dayOf(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y!, (m ?? 1) - 1, d ?? 1) / 86_400_000;
}

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function shown(iso: string): string {
  const [year, month, day] = iso.split("-") as [string, string, string];
  return `${Number(day)} ${MONTHS[Number(month) - 1]} ${year}`;
}

const CODE = /\b([A-Z]{3})\b/g;
const ARRIVAL = /\b(?:to|arrives)\s+([A-Z]{3})\b/;

interface Member {
  file: TripFile;
  events: Fact[];
  start: string;
  end: string;
  tails: Set<string>;
  cities: Set<string>;
  arrivals: Set<string>;
}

/** What one file contributes: its usable events, references and places. */
async function memberOf(file: TripFile): Promise<Member | null> {
  if (file.trashed) {
    return null;
  }
  const events = file.facts.filter((fact) => fact.kind === "event" && usable(fact));
  if (events.length === 0) {
    return null;
  }
  const dates = events.map((fact) => fact.value).sort();
  const tails = new Set<string>();
  for (const fact of file.facts) {
    if (fact.kind === "identifier" && usable(fact)) {
      const tail = fact.masked ?? fact.value;
      if (tail) {
        tails.add(tail);
      }
    }
  }
  const cities = new Set<string>();
  const arrivals = new Set<string>();
  for (const fact of events) {
    const label = fact.label ?? "";
    CODE.lastIndex = 0;
    for (let match = CODE.exec(label); match; match = CODE.exec(label)) {
      const airport = await lookupAirport(match[1]!);
      if (airport) {
        cities.add(airport.city);
      }
    }
    const arriving = ARRIVAL.exec(label);
    if (arriving) {
      const airport = await lookupAirport(arriving[1]!);
      if (airport) {
        arrivals.add(airport.city);
      }
    }
  }
  return { file, events, start: dates[0]!, end: dates[dates.length - 1]!, tails, cities, arrivals };
}

interface Cluster {
  members: Member[];
  start: string;
  end: string;
}

function spanOf(members: Member[]): { start: string; end: string } {
  let start = members[0]!.start;
  let end = members[0]!.end;
  for (const member of members) {
    if (member.start < start) {
      start = member.start;
    }
    if (member.end > end) {
      end = member.end;
    }
  }
  return { start, end };
}

function gapDays(a: Cluster, b: Cluster): number {
  return Math.max(dayOf(b.start) - dayOf(a.end), dayOf(a.start) - dayOf(b.end), 0);
}

function shares(a: Cluster, b: Cluster, of: (m: Member) => Set<string>): string | null {
  for (const left of a.members) {
    for (const right of b.members) {
      for (const token of of(left)) {
        if (of(right).has(token)) {
          return token;
        }
      }
    }
  }
  return null;
}

/** Merges clusters wherever the given evidence bridges them, to fixpoint. */
function mergeWhere(clusters: Cluster[], bridge: (a: Cluster, b: Cluster) => boolean): Cluster[] {
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const a = clusters[i]!;
        const b = clusters[j]!;
        if (gapDays(a, b) <= MERGE_GAP_DAYS && bridge(a, b)) {
          const members = [...a.members, ...b.members];
          clusters.splice(j, 1);
          clusters.splice(i, 1, { members, ...spanOf(members) });
          merged = true;
          break outer;
        }
      }
    }
  }
  return clusters;
}

/** The most frequent entry, ties settled alphabetically for stability. */
function commonest(all: string[]): string | undefined {
  const counts = new Map<string, number>();
  for (const entry of all) {
    counts.set(entry, (counts.get(entry) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
}

/**
 * Every group of documents that looks like one trip, ready to be offered.
 * Deterministic: the same library always yields the same suggestions.
 */
export async function suggestTrips(files: TripFile[], now: number): Promise<TripSuggestion[]> {
  const members: Member[] = [];
  for (const file of files) {
    const member = await memberOf(file);
    if (member) {
      members.push(member);
    }
  }
  members.sort((a, b) => a.start.localeCompare(b.start) || a.file.id.localeCompare(b.file.id));

  // Overlapping windows first: events near each other in time belong to one
  // candidate unless something says otherwise.
  const clusters: Cluster[] = [];
  for (const member of members) {
    const current = clusters[clusters.length - 1];
    if (current && dayOf(member.start) <= dayOf(current.end) + WINDOW_DAYS) {
      current.members.push(member);
      Object.assign(current, spanOf(current.members));
    } else {
      clusters.push({ members: [member], start: member.start, end: member.end });
    }
  }
  // Then the bridges: a shared reference tail, a shared destination.
  mergeWhere(clusters, (a, b) => shares(a, b, (m) => m.tails) !== null);
  mergeWhere(clusters, (a, b) => shares(a, b, (m) => m.arrivals) !== null);

  const nowDay = now / 86_400_000;
  const suggestions: TripSuggestion[] = [];
  for (const cluster of clusters) {
    if (cluster.members.length < 2) {
      continue;
    }
    // A thousand old documents hold many past trips; none is a suggestion.
    if (dayOf(cluster.end) < nowDay - RECENT_PAST_DAYS) {
      continue;
    }
    const fileIds = cluster.members.map((member) => member.file.id).sort();
    const destination =
      commonest(cluster.members.flatMap((m) => [...m.arrivals])) ??
      commonest(
        cluster.members
          .flatMap((m) => [...m.cities])
          .filter((city, _, all) => all.indexOf(city) !== all.lastIndexOf(city)),
      );
    const why = [`dates fall together, ${shown(cluster.start)} to ${shown(cluster.end)}`];
    const tailCounts = new Map<string, number>();
    for (const member of cluster.members) {
      for (const tail of member.tails) {
        tailCounts.set(tail, (tailCounts.get(tail) ?? 0) + 1);
      }
    }
    for (const [tail, count] of tailCounts) {
      if (count >= 2) {
        why.push(`share a reference ending ${tail}`);
      }
    }
    if (destination) {
      why.push(`both point at ${destination}`);
    }
    suggestions.push({
      id: `trip:${fileIds.join("+")}`,
      fileIds,
      start: cluster.start,
      end: cluster.end,
      ...(destination ? { destination } : {}),
      why,
    });
  }
  return suggestions.sort((a, b) => a.start.localeCompare(b.start));
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/** The shared tag a confirmation writes: the trip's name in the Library. */
export function tripTag(suggestion: TripSuggestion): string {
  const where = suggestion.destination ? slug(suggestion.destination) : suggestion.start;
  return `trip:${where}-${suggestion.start.slice(0, 7)}`;
}

function legKind(fact: Fact): ItineraryLeg["kind"] {
  const label = fact.label ?? "";
  if (/^flight\b/i.test(label) || fact.document === "boarding-pass") {
    return "flight";
  }
  if (/^check[- ]?(in|out)\b/i.test(label) || fact.document === "hotel-booking") {
    return "stay";
  }
  if (/^(pick[- ]?up|drop[- ]?off)\b/i.test(label) || fact.document === "car-rental") {
    return "car";
  }
  return "other";
}

/** Airport codes resolved into the words a person recognizes. */
async function inCityWords(label: string): Promise<{ text: string; codes: string[] }> {
  let text = label;
  const codes: string[] = [];
  const seen = new Set<string>();
  CODE.lastIndex = 0;
  for (let match = CODE.exec(label); match; match = CODE.exec(label)) {
    const code = match[1]!;
    if (seen.has(code)) {
      continue;
    }
    seen.add(code);
    const airport = await lookupAirport(code);
    if (airport) {
      codes.push(code);
      text = text.split(code).join(`${airport.city} (${code})`);
    }
  }
  return { text, codes };
}

/**
 * The trip's timeline, derived from the members' facts at render time. Legs
 * sort by date and clock as printed; times stay local to their places, which
 * is honest ordering rather than instant ordering, and the zones ride along
 * for anything that needs the real instant.
 */
export async function assembleItinerary(members: TripFile[]): Promise<ItineraryLeg[]> {
  const legs: ItineraryLeg[] = [];
  for (const file of members) {
    for (const fact of file.facts) {
      if (fact.kind !== "event" || !usable(fact)) {
        continue;
      }
      const { text, codes } = await inCityWords(fact.label ?? "Event");
      legs.push({
        at: fact.value,
        ...(fact.time ? { time: fact.time } : {}),
        ...(fact.zone ? { zone: fact.zone } : {}),
        title: text,
        fileId: file.id,
        factId: fact.id,
        ...(codes.length > 0 ? { codes } : {}),
        kind: legKind(fact),
      });
    }
  }
  legs.sort((a, b) => `${a.at} ${a.time ?? ""}`.localeCompare(`${b.at} ${b.time ?? ""}`));
  return legs;
}

/**
 * The static lead-time line: three hours for an international departure,
 * two for a domestic one. Computed only when the flight's airports resolve,
 * because an airport the table cannot place makes the arithmetic a guess,
 * and this card never guesses. Deliberately not "leave now": door-to-door
 * timing would need a routing service and your location, and the card
 * offers a Maps handoff instead.
 */
export async function departureAdvice(
  legs: ItineraryLeg[],
): Promise<{ leg: ItineraryLeg; text: string } | null> {
  for (const leg of legs) {
    if (leg.kind !== "flight" || !leg.time || !/\bdeparts?\b|\bto\b/i.test(leg.title)) {
      continue;
    }
    // Every leg of one flight shares a title prefix; their codes together
    // name both ends even when this leg only mentions one.
    const prefix = leg.title.split(/\s+(?:departs|arrives)\s+/i)[0]!;
    const codes = new Set<string>();
    for (const other of legs) {
      if (other.kind === "flight" && other.title.startsWith(prefix)) {
        for (const code of other.codes ?? []) {
          codes.add(code);
        }
      }
    }
    const countries = new Set<string>();
    for (const code of codes) {
      const airport = await lookupAirport(code);
      if (airport) {
        countries.add(airport.country);
      }
    }
    if (codes.size < 2 || countries.size === 0) {
      continue;
    }
    const international = countries.size > 1;
    const [hour, minute] = leg.time.split(":").map(Number);
    const total = hour! * 60 + minute! - (international ? 180 : 120);
    if (total < 0) {
      continue;
    }
    const at = `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
    return {
      leg,
      text: `${international ? "International" : "Domestic"} departure, so be at the airport by ${at}.`,
    };
  }
  return null;
}

/** The tag rendered back into words: "trip:new-york-2027-03" reads as a title. */
export function tripTitle(tag: string): string {
  const match = /^trip:(.+)-(\d{4})-(\d{2})$/.exec(tag);
  if (!match) {
    return tag;
  }
  const words = match[1]!
    .split("-")
    .map((word) => (word ? word[0]!.toUpperCase() + word.slice(1) : word))
    .join(" ");
  return `${words}, ${MONTHS[Number(match[3]) - 1]} ${match[2]}`;
}

const DISMISSED_KEY = "engram-trips-dismissed";

/**
 * Per-device memory of refused groupings. A dismissal is a view preference
 * rather than vault data; the worst case of keeping it local is that another
 * device asks the same question once.
 */
export function dismissedTrips(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}

export function rememberTripDismissal(id: string): void {
  try {
    const all = dismissedTrips();
    all.add(id);
    localStorage.setItem(DISMISSED_KEY, JSON.stringify([...all]));
  } catch {
    // Best-effort; the worst case is asking again.
  }
}
