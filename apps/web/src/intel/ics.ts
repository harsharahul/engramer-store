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
