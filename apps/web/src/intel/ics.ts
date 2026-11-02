/**
 * A tracked date as a calendar event, built entirely on this device.
 *
 * This is the bridge across the reminder gap: real notification
 * infrastructure needs either a native shell or a push relay, but every
 * platform already carries a calendar the owner trusts. Handing one event to
 * it is the same privacy shape as Open in Maps, a choice the owner makes,
 * one fact at a time, with no server anywhere in the path.
 *
 * The event is all-day on the fact's date unless the document gave a time,
 * and carries an alarm the day before at nine in the morning, because a
 * reminder that fires as the thing expires is a notification, not a
 * reminder.
 */

import type { Fact } from "./facts";
import { describeFact } from "./describe";
import type { TripView } from "./tripview";

/** RFC 5545 wants CRLF line endings and escaped text. */
function escapeText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}

function compact(iso: string): string {
  return iso.replace(/-/g, "");
}

export interface CalendarEvent {
  /** The .ics file contents. */
  ics: string;
  /** A name for the download. */
  filename: string;
}

/**
 * One fact as one event. `stamp` is the moment of export, passed in rather
 * than read from a clock so this stays a pure function.
 */
export function factToCalendar(fact: Fact, fileName: string, stamp: number): CalendarEvent {
  const summary = describeFact(fact);
  const uid = `${fact.id.replace(/[^A-Za-z0-9:-]/g, "")}@engram-store`;
  const stamped = new Date(stamp).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Engram Store//Document facts//EN",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${stamped}`,
  ];
  if (fact.time) {
    // A time the document gave is local to whatever the document describes,
    // so it is written as floating local time rather than pinned to UTC:
    // wrong-zone-but-visible beats confidently shifted by five hours.
    const [hh, mm] = fact.time.split(":");
    lines.push(`DTSTART:${compact(fact.value)}T${hh}${mm}00`);
  } else {
    lines.push(`DTSTART;VALUE=DATE:${compact(fact.value)}`);
  }
  lines.push(
    `SUMMARY:${escapeText(summary)}`,
    `DESCRIPTION:${escapeText(`From ${fileName}, tracked in Engram Store.`)}`,
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    `DESCRIPTION:${escapeText(summary)}`,
    // The day before, at nine in the morning local time.
    "TRIGGER:-PT15H",
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  );
  return {
    ics: lines.join("\r\n") + "\r\n",
    filename: `${summary.replace(/[^A-Za-z0-9 _-]/g, "").trim().slice(0, 60) || "tracked-date"}.ics`,
  };
}

/** An instant in UTC, as RFC 5545 writes it: 20261113T021000Z. */
function utc(at: number): string {
  return new Date(at).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/** The day after an ISO day; an all-day event ends on the day it no longer covers. */
function dayAfter(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

/**
 * A whole trip as one calendar file: each leg at its real instants, with an
 * alarm at leave-by; each stay as all-day nights from check-in to check-out;
 * each booking. A date nobody has said yes to stays out. UIDs come from the
 * trip and the item, never the moment of export, so exporting again updates
 * the same events instead of adding copies.
 */
export function tripToCalendar(view: TripView, stamp: number): CalendarEvent {
  const slug = (text: string) => text.replace(/[^A-Za-z0-9-]+/g, "-");
  const uid = (part: string) => `UID:${slug(view.tag)}-${slug(part)}@engram-store`;
  const stamped = `DTSTAMP:${utc(stamp)}`;
  const events: string[][] = [];

  view.legs.forEach((leg, i) => {
    if (leg.ask || !leg.dep) {
      return;
    }
    const name = leg.designator || leg.mode.charAt(0).toUpperCase() + leg.mode.slice(1);
    const lines = [uid(leg.key), stamped];
    if (leg.dep.time) {
      lines.push(`DTSTART:${utc(leg.dep.at)}`);
      if (leg.arr?.time && leg.arr.at > leg.dep.at) {
        lines.push(`DTEND:${utc(leg.arr.at)}`);
      }
    } else {
      lines.push(`DTSTART;VALUE=DATE:${compact(leg.dep.day)}`);
    }
    lines.push(`SUMMARY:${escapeText(`${name} ${leg.from} to ${leg.to}`)}`, `LOCATION:${escapeText(leg.dep.place)}`);
    const advice = view.leaveBy[i];
    if (advice && leg.dep.time) {
      lines.push(
        "BEGIN:VALARM",
        "ACTION:DISPLAY",
        `DESCRIPTION:${escapeText(`Leave for ${leg.dep.code ?? leg.from}`)}`,
        `TRIGGER:-PT${Math.round((leg.dep.at - advice.at) / 60_000)}M`,
        "END:VALARM",
      );
    }
    events.push(lines);
  });

  for (const stay of view.stays) {
    if (!stay.checkIn) {
      continue;
    }
    const last = stay.checkOut && stay.checkOut.day > stay.checkIn.day ? stay.checkOut.day : dayAfter(stay.checkIn.day);
    events.push([
      uid(`stay-${stay.fileId}`),
      stamped,
      `DTSTART;VALUE=DATE:${compact(stay.checkIn.day)}`,
      `DTEND;VALUE=DATE:${compact(last)}`,
      `SUMMARY:${escapeText(stay.name)}`,
      `LOCATION:${escapeText(stay.address ?? stay.name)}`,
    ]);
  }

  for (const row of view.booked) {
    if (row.ask) {
      continue;
    }
    events.push([
      uid(row.id),
      stamped,
      row.time ? `DTSTART:${utc(row.at)}` : `DTSTART;VALUE=DATE:${compact(row.day)}`,
      `SUMMARY:${escapeText(row.title)}`,
    ]);
  }

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Engram Store//Trips//EN",
    ...events.flatMap((event) => ["BEGIN:VEVENT", ...event, "END:VEVENT"]),
    "END:VCALENDAR",
  ];
  const name = `${view.city}-${view.start}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return { ics: lines.join("\r\n") + "\r\n", filename: `${name || "trip"}.ics` };
}
