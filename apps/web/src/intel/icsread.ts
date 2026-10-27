/**
 * Reading a calendar invite (RFC 5545): each event's own start and end.
 *
 * An invite is the sender's calendar speaking, the same tier as booking
 * data: facts leave at full confidence and are exempt from prose grounding.
 * Times are kept as written: a time with a named zone keeps the zone's name,
 * a time ending in Z is UTC, and nothing is converted. A cancelled invite
 * states nothing worth tracking.
 */

import { isRealDate } from "./dates";
import { MAX_FACTS_PER_FILE, factId, type DocumentKind, type Fact } from "./facts";

const LABEL_MAX = 60;
/** A zone name longer than this is not one; it would only bloat synced metadata. */
const ZONE_MAX = 64;
const TICKETED = /\b(?:tickets?|concert|show|match|game|performance|admission|screening)\b/i;

interface Property {
  params: Record<string, string>;
  value: string;
}

/** One content line split into name, parameters and value; quoted parameter values may hold ":" or ";". */
function parseLine(line: string): [string, Property] | undefined {
  let quoted = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      quoted = !quoted;
    } else if (char === ":" && !quoted) {
      colon = i;
      break;
    }
  }
  if (colon < 0) {
    return undefined;
  }
  const [name, ...rawParams] = line.slice(0, colon).split(";");
  const params: Record<string, string> = {};
  for (const param of rawParams) {
    const eq = param.indexOf("=");
    if (eq > 0) {
      params[param.slice(0, eq).toUpperCase()] = param.slice(eq + 1).replace(/^"|"$/g, "");
    }
  }
  return [name!.toUpperCase(), { params, value: line.slice(colon + 1) }];
}

function unescapeText(value: string): string {
  return value.replace(/\\([nN])/g, " ").replace(/\\([\\;,])/g, "$1").replace(/\s+/g, " ").trim();
}

/** A DATE or DATE-TIME value as a fact stores it. */
function stamp(property: Property): { value: string; time?: string; zone?: string; allDay: boolean } | undefined {
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})\d{2}(Z)?)?$/.exec(property.value.trim());
  if (!match) {
    return undefined;
  }
  const value = `${match[1]}-${match[2]}-${match[3]}`;
  if (!isRealDate(value)) {
    return undefined;
  }
  if (!match[4]) {
    return { value, allDay: true };
  }
  if (Number(match[4]) > 23 || Number(match[5]) > 59) {
    return undefined;
  }
  const zone = match[6] ? "UTC" : property.params["TZID"]?.slice(0, ZONE_MAX);
  return { value, time: `${match[4]}:${match[5]}`, ...(zone ? { zone } : {}), allDay: false };
}

export function icsFacts(raw: string): Fact[] {
  if (!/BEGIN:VCALENDAR/i.test(raw)) {
    return [];
  }
  // Long lines continue on the next line after one space or tab.
  const lines = raw.replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
  const facts: Fact[] = [];
  let event: Map<string, Property> | null = null;
  for (const line of lines) {
    const parsed = parseLine(line);
    if (!parsed) {
      continue;
    }
    const [name, property] = parsed;
    if (name === "METHOD" && property.value.trim().toUpperCase() === "CANCEL") {
      return [];
    }
    if (name === "BEGIN" && property.value.trim().toUpperCase() === "VEVENT") {
      event = new Map();
    } else if (name === "END" && property.value.trim().toUpperCase() === "VEVENT" && event) {
      facts.push(...eventFacts(event));
      event = null;
    } else if (event && !event.has(name)) {
      event.set(name, property);
    }
  }
  return facts.slice(0, MAX_FACTS_PER_FILE);
}

function eventFacts(event: Map<string, Property>): Fact[] {
  const status = event.get("STATUS")?.value.trim().toUpperCase();
  const start = event.get("DTSTART") && stamp(event.get("DTSTART")!);
  if (status === "CANCELLED" || !start) {
    return [];
  }
  const summary = unescapeText(event.get("SUMMARY")?.value ?? "").slice(0, LABEL_MAX) || "Event";
  const document: DocumentKind = TICKETED.test(summary) ? "event-ticket" : "other";
  const fact = (at: NonNullable<ReturnType<typeof stamp>>, label: string): Fact => ({
    id: factId("event", `${at.value} ${label.toLowerCase()}`),
    kind: "event",
    document,
    value: at.value,
    ...(at.time ? { time: at.time } : {}),
    ...(at.zone ? { zone: at.zone } : {}),
    label,
    source: "ics",
    confidence: 1,
  });
  const facts = [fact(start, summary)];
  const end = event.get("DTEND") && stamp(event.get("DTEND")!);
  // A whole-day event's end is the next day by definition: not a date of its own.
  if (end && !end.allDay && (end.value !== start.value || end.time !== start.time)) {
    facts.push(fact(end, `${summary} ends`));
  }
  return facts;
}
