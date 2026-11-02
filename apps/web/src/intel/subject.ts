/**
 * What a fact is about: which flight, stay, rental or place a date belongs to.
 *
 * A fact's label is the document's own words, kept for display and for the
 * fact's identity. Meaning does not belong in display text: each reader words
 * its labels its own way, and code that parses labels back into meaning ends
 * up with one dialect per reader and one parser per caller, which drift. So
 * every reader states the meaning once, here, as data, and every caller reads
 * it through `subjectOf`.
 *
 * Facts stored before readers wrote a subject still carry their meaning in the
 * label. `subjectOf` reads it out of the label in exactly one place, so stored
 * facts need no second reading.
 */
import type { Fact } from "./facts";

export type Role =
  | "depart"
  | "arrive"
  | "check-in"
  | "check-out"
  | "pick-up"
  | "drop-off"
  | "start"
  | "end"
  | "opens"
  | "by"
  | "reference";

export type Mode = "flight" | "train" | "bus" | "boat";

export interface Subject {
  role: Role;
  mode?: Mode;
  /** The airline as its code, or an operator's name ("TP", "FlixBus"). */
  carrier?: string;
  /** The flight or train number ("236"). */
  number?: string;
  /** This stop's airport code. */
  code?: string;
  /** The other end's code, when the same source names both ends (a boarding pass). */
  otherEnd?: string;
  /** The place as printed: a hotel, a station, a venue. */
  place?: string;
  address?: string;
  seat?: string;
  gate?: string;
  boardingGroup?: string;
  /** "HH:MM", local to the departure. */
  boardingTime?: string;
  /** Facts read from one reservation in one file share this index. */
  reservation?: number;
}

const ROLES: ReadonlySet<string> = new Set<Role>([
  "depart",
  "arrive",
  "check-in",
  "check-out",
  "pick-up",
  "drop-off",
  "start",
  "end",
  "opens",
  "by",
  "reference",
]);
const MODES: ReadonlySet<string> = new Set<Mode>(["flight", "train", "bus", "boat"]);

// Subjects ride in synced metadata, so every field is bounded.
const PLACE_MAX = 60;
const ADDRESS_MAX = 120;
const CARRIER_MAX = 40;
const SHORT_MAX = 6;
const CODE = /^[A-Z]{3}$/;
const NUMBER = /^\d{1,4}[A-Z]?$/;
const SEAT = /^\d{1,3}[A-Z]$/;
const CLOCK = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const RESERVATIONS_MAX = 100;

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed && trimmed.length <= max ? trimmed : undefined;
}

function shaped(value: unknown, pattern: RegExp): string | undefined {
  return typeof value === "string" && pattern.test(value) ? value : undefined;
}

/**
 * A subject with every field checked and bounded, or nothing when its role is
 * not one this version knows. A bad field is left out; the rest stands.
 */
export function cleanSubject(raw: unknown): Subject | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const given = raw as Record<string, unknown>;
  if (typeof given["role"] !== "string" || !ROLES.has(given["role"])) {
    return undefined;
  }
  const fields: Partial<Subject> = {
    mode: typeof given["mode"] === "string" && MODES.has(given["mode"]) ? (given["mode"] as Mode) : undefined,
    carrier: text(given["carrier"], CARRIER_MAX),
    number: shaped(given["number"], NUMBER),
    code: shaped(given["code"], CODE),
    otherEnd: shaped(given["otherEnd"], CODE),
    place: text(given["place"], PLACE_MAX),
    address: text(given["address"], ADDRESS_MAX),
    seat: shaped(given["seat"], SEAT),
    gate: text(given["gate"], SHORT_MAX),
    boardingGroup: text(given["boardingGroup"], SHORT_MAX),
    boardingTime: shaped(given["boardingTime"], CLOCK),
    reservation:
      typeof given["reservation"] === "number" &&
      Number.isInteger(given["reservation"]) &&
      given["reservation"] >= 0 &&
      given["reservation"] < RESERVATIONS_MAX
        ? given["reservation"]
        : undefined,
  };
  const subject: Subject = { role: given["role"] as Role };
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      (subject as unknown as Record<string, unknown>)[key] = value;
    }
  }
  return subject;
}

/** "TP 236": the carrier and number together, when either is known. */
export function designatorOf(subject: Subject): string | undefined {
  return [subject.carrier, subject.number].filter(Boolean).join(" ") || undefined;
}

// The label forms readers wrote before they stated subjects, read here and
// nowhere else.
const LEG = /^(flight|train|bus|boat)\b\s*(.*?)\s*\b(departs|arrives)\b\s*(.*)$/i;
const PASS = /^Flight\s+(.+?)\s+([A-Z]{3}) to ([A-Z]{3})$/;
const STAY = /^check[- ]?(in|out)\b(?:[^:]*:\s*(.+))?/i;
const CAR = /^(pick[- ]?up|drop[- ]?off)\b(?:[^:]*:\s*(.+))?/i;
const TABLE = /^table at\s+(.+)$/i;
const ENDS = /\sends$/i;
const DEPARTS = /^depart(?:ure|s)?\b/i;
const ARRIVES = /^arriv(?:al|es)?\b/i;
const REFERENCE = /\b(?:confirmation|booking|reservation|reference|pnr)\b/i;
/** What readers wrote when a booking named no place. */
const UNNAMED: ReadonlySet<string> = new Set(["the stay", "the rental", "the event", "the restaurant"]);

function service(designator: string): Pick<Subject, "carrier" | "number"> {
  const words = designator.trim().split(/\s+/).filter(Boolean);
  const last = words.at(-1);
  if (last && NUMBER.test(last)) {
    const carrier = words.slice(0, -1).join(" ");
    return { ...(carrier ? { carrier } : {}), number: last };
  }
  return words.length > 0 ? { carrier: words.join(" ") } : {};
}

function stop(where: string): Pick<Subject, "code" | "place"> {
  const trimmed = where.trim();
  if (CODE.test(trimmed)) {
    return { code: trimmed };
  }
  return trimmed ? { place: trimmed.slice(0, PLACE_MAX) } : {};
}

function named(place: string | undefined): Pick<Subject, "place"> {
  const trimmed = place?.trim();
  return trimmed && !UNNAMED.has(trimmed.toLowerCase()) ? { place: trimmed.slice(0, PLACE_MAX) } : {};
}

function fromLabel(fact: Fact): Subject | undefined {
  const label = (fact.label ?? "").trim();
  if (fact.kind === "identifier") {
    return REFERENCE.test(label) ? { role: "reference" } : undefined;
  }
  if (fact.kind !== "event") {
    return undefined;
  }
  const pass = PASS.exec(label);
  if (pass) {
    return { role: "depart", mode: "flight", ...service(pass[1]!), code: pass[2]!, otherEnd: pass[3]! };
  }
  const leg = LEG.exec(label);
  if (leg) {
    return {
      role: leg[3]!.toLowerCase() === "departs" ? "depart" : "arrive",
      mode: leg[1]!.toLowerCase() as Mode,
      ...service(leg[2]!),
      ...stop(leg[4]!),
    };
  }
  const stay = STAY.exec(label);
  if (stay) {
    return { role: stay[1]!.toLowerCase() === "in" ? "check-in" : "check-out", ...named(stay[2]) };
  }
  const car = CAR.exec(label);
  if (car) {
    return { role: /^pick/i.test(car[1]!) ? "pick-up" : "drop-off", ...named(car[2]) };
  }
  const table = TABLE.exec(label);
  if (table) {
    return { role: "start", ...named(table[1]) };
  }
  if (fact.document === "delivery") {
    return { role: /opens/i.test(label) ? "opens" : "by" };
  }
  if (ENDS.test(label)) {
    return { role: "end" };
  }
  if (DEPARTS.test(label)) {
    return { role: "depart" };
  }
  if (ARRIVES.test(label)) {
    return { role: "arrive" };
  }
  return undefined;
}

/** What a fact is about: the subject its reader stated, else what its label says. */
export function subjectOf(fact: Fact): Subject | undefined {
  return cleanSubject(fact.subject) ?? fromLabel(fact);
}
