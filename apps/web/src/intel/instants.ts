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

function formatterFor(zone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(zone);
  if (!formatter) {
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
