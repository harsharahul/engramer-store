/**
 * The one way a printed date and time become an instant.
 *
 * A time on a ticket is the time where the ticket is used: 18:10 at San
 * Francisco, 14:05 at Lisbon. Reading it as this device's time puts it hours
 * off whenever the device is somewhere else, which is exactly when a traveller
 * needs it right. So every time is read in its own zone: the one the document
 * printed, else its own airport's, else its trip's destination's, else, for
 * something with no place at all, this device's.
 */
import { lookupAirport } from "./airports";
import type { Fact } from "./facts";
import { subjectOf } from "./subject";

const OFFSET = /^([+-])(\d{2}):?(\d{2})$/;

// Asked once a minute, not once per fact: the answer changes only when the
// device crosses a border, and asking is costly across a whole library.
let device: { zone: string; checked: number } | undefined;

/** This device's own zone. */
export function deviceZone(): string {
  const now = Date.now();
  if (!device || now - device.checked > 60_000) {
    device = { zone: Intl.DateTimeFormat().resolvedOptions().timeZone, checked: now };
  }
  return device.zone;
}

// Building a formatter costs far more than using one; a library reads
// thousands of times in a handful of zones.
const formatters = new Map<string, Intl.DateTimeFormat>();
// A name this device cannot read (an invite's "Pacific Standard Time") is
// refused once, not on every reading of every fact that carries it.
const unreadable = new Set<string>();

function formatterFor(zone: string): Intl.DateTimeFormat {
  if (unreadable.has(zone)) {
    throw new RangeError(`unreadable zone: ${zone}`);
  }
  let formatter = formatters.get(zone);
  if (!formatter) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: zone });
    } catch (error) {
      unreadable.add(zone);
      throw error;
    }
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(zone, formatter);
  }
  return formatter;
}

/** How far a named zone is ahead of UTC at an instant, in milliseconds. */
function offsetAt(at: number, zone: string): number {
  const parts = formatterFor(zone).formatToParts(at);
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const wall = Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"), part("second"));
  return wall - Math.floor(at / 1000) * 1000;
}

/**
 * The instant a printed date and time name in a zone: a fixed offset as
 * written ("-08:00", "UTC"), or a named zone with its summer and winter time.
 * No time is the start of that day. A zone this device cannot read falls back
 * to the device's own.
 */
export function instantOf(day: string, time: string | undefined, zone: string): number {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  const [hour, minute] = (time ?? "00:00").split(":").map(Number) as [number, number];
  const wall = Date.UTC(year, month - 1, date, hour, minute);
  if (zone === "UTC" || zone === "Z") {
    return wall;
  }
  const fixed = OFFSET.exec(zone);
  if (fixed) {
    const minutes = Number(fixed[2]) * 60 + Number(fixed[3]);
    return wall - (fixed[1] === "-" ? -minutes : minutes) * 60_000;
  }
  if (zone === deviceZone()) {
    // The device's own clock rules are built in, and far cheaper to ask.
    return new Date(year, month - 1, date, hour, minute).getTime();
  }
  try {
    // Two passes: the offset at a first guess, then at the instant that guess
    // gives, which settles a time near a change of clocks.
    const first = wall - offsetAt(wall, zone);
    const second = wall - offsetAt(first, zone);
    return second;
  } catch {
    return new Date(year, month - 1, date, hour, minute).getTime();
  }
}

const pad = (n: number) => String(n).padStart(2, "0");

/** The device-local date of an instant, as an ISO day. */
export function localDay(ms: number): string {
  const at = new Date(ms);
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/** The device-local time of an instant, as HH:MM. */
export function localTime(ms: number): string {
  const at = new Date(ms);
  return `${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/**
 * The start of the hour an instant falls in, on the device's own clock. A
 * moment coarse enough to key a memo by and still inside the device's day:
 * the start of a UTC hour is the day before for up to 45 minutes after
 * midnight where the clock is half an hour off UTC.
 */
export function hourOf(ms: number): number {
  const at = new Date(ms);
  at.setMinutes(0, 0, 0);
  return at.getTime();
}

/** Whether a fact states an instant: a calendar file's time, with the zone it is in. */
export function statesInstant(fact: Pick<Fact, "source" | "time" | "zone">): boolean {
  return fact.source === "ics" && fact.time !== undefined && fact.zone !== undefined && fact.zone !== "";
}

/** What a booking's date is: a stay, a rental, a journey. Its clock is its place's. */
const PLACED: ReadonlySet<string> = new Set(["check-in", "check-out", "pick-up", "drop-off", "depart", "arrive"]);

/** Where a fact is being shown: whether its file is part of a trip. */
export interface Shown {
  inTrip: boolean;
}

/**
 * Whether a fact is shown as an instant, in this device's zone. A meeting's
 * invite is: a call at 17:00 in New York is at 14:00 in San Francisco, and
 * every calendar shows it so. Something that happens in a place is not, and
 * keeps that place's clock wherever it is read: a booking (a flight's 18:10
 * is its airport's, whether booking data or a calendar file states it), and
 * an invite in a trip's file (a tour at 09:00 in Tokyo is on the trip's day).
 */
export function isInstant(fact: Fact, where: Shown): boolean {
  return statesInstant(fact) && !where.inTrip && !PLACED.has(subjectOf(fact)?.role ?? "");
}

/**
 * The day and the time a fact is shown at, the one rule for every surface:
 * the Timeline's row, the details pane, the bell and a notification. An
 * instant is shown in this device's zone; anything else as its document
 * printed it.
 */
export function shownWhen(fact: Fact, where: Shown): { day: string; time?: string } {
  if (!isInstant(fact, where)) {
    return { day: fact.value, ...(fact.time ? { time: fact.time } : {}) };
  }
  const at = instantOf(fact.value, fact.time, fact.zone!);
  return { day: localDay(at), time: localTime(at) };
}

/** The date of an instant in a named zone, as an ISO day; the device's when the zone is unknown. */
export function zonedDay(ms: number, zone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);
  } catch {
    return localDay(ms);
  }
}

/** The time of an instant in a named zone, as HH:MM; the device's when the zone is unknown. */
export function zonedTime(ms: number, zone: string): string {
  try {
    return new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(ms);
  } catch {
    return localTime(ms);
  }
}

/** The zone a fact's printed time belongs to. */
export async function zoneOf(fact: Fact, ctx: { tripZone?: string }): Promise<string> {
  if (fact.zone) {
    return fact.zone;
  }
  const code = subjectOf(fact)?.code;
  const airport = code ? await lookupAirport(code) : null;
  return airport?.zone ?? ctx.tripZone ?? deviceZone();
}
