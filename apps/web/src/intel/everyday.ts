/**
 * An ordinary day, as the Timeline's hero tells it: what is left today,
 * what comes this week, the one date waiting for a yes, the photos from
 * this day in earlier years, what this month has paid and still owes, and
 * the next trip. Everything derives from the Timeline's rows, so the hero
 * and the list never disagree.
 */

import type { Trip } from "./agenda";
import { localDay, type AgendaRow } from "./agendarows";

/** A sum in one currency, never converted: a decimal string with 2 places. */
export interface Money {
  currency: string;
  value: string;
}

export interface Everyday {
  today: AgendaRow[];
  /** Today's rows still ahead. */
  laterToday: number;
  week: AgendaRow[];
  needsYes?: AgendaRow;
  onThisDay?: { year: number; yearsAgo: number; title: string; fileIds: string[] };
  month: { name: string; paid: Money[]; due: Money[]; receipts: number; bills: number };
  nextTrip?: { title: string; days: number };
}

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
/** The furthest a date may be and still ask for a yes on the hero. */
const ASK_AHEAD_DAYS = 60;
const WEEK_DAYS = 7;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const dayNumber = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / DAY_MS;
const daysAfter = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

/** Sums amounts per currency, in cents so nothing drifts. */
/** Amounts summed per currency, never converted, in cents so nothing drifts. */
export function sum(rows: readonly AgendaRow[]): Money[] {
  const cents = new Map<string, number>();
  for (const row of rows) {
    if (row.amount) {
      cents.set(row.amount.currency, (cents.get(row.amount.currency) ?? 0) + Math.round(Number(row.amount.value) * 100));
    }
  }
  return [...cents.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([currency, total]) => ({ currency, value: (total / 100).toFixed(2) }));
}

export function everydayOf(rows: readonly AgendaRow[], trips: readonly Trip[], now: number): Everyday {
  const today = localDay(now);
  const plain = rows.filter((row) => row.kind !== "photos" && row.kind !== "trip");
  const todays = plain.filter((row) => row.day === today);
  const weekEnd = daysAfter(today, WEEK_DAYS);
  const askEnd = daysAfter(today, ASK_AHEAD_DAYS);
  const month = today.slice(0, 7);
  const paid = rows.filter((row) => row.kind === "bill" && row.amount && row.day.startsWith(month) && row.day <= today);
  // A date nobody said yes to is not counted yet, here as everywhere.
  const due = rows.filter((row) => row.kind === "due" && !row.ask && row.amount && row.day.startsWith(month) && !row.past);

  const memory = rows
    .filter((row) => row.kind === "photos" && row.day.slice(5) === today.slice(5) && row.day < today)
    .sort((a, b) => b.day.localeCompare(a.day))[0];
  let onThisDay: Everyday["onThisDay"];
  if (memory) {
    const year = Number(memory.day.slice(0, 4));
    const trip = trips.find((candidate) => {
      const members = new Set(candidate.members.map((file) => file.id));
      return memory.fileIds.filter((id) => members.has(id)).length * 2 > memory.fileIds.length;
    });
    onThisDay = {
      year,
      yearsAgo: Number(today.slice(0, 4)) - year,
      title: trip ? `${trip.title.split(",")[0]} · ${memory.title}` : memory.title,
      fileIds: memory.fileIds,
    };
  }

  const next = trips
    .filter((trip) => trip.start !== undefined && trip.start > today)
    .sort((a, b) => a.start!.localeCompare(b.start!))[0];
  // Only a row that names its facts can be answered.
  const needsYes = rows.find((row) => row.ask && row.factIds?.length && row.day >= today && row.day <= askEnd);

  return {
    today: todays,
    laterToday: todays.filter((row) => !row.past).length,
    week: plain.filter((row) => row.day > today && row.day <= weekEnd),
    ...(needsYes ? { needsYes } : {}),
    ...(onThisDay ? { onThisDay } : {}),
    month: {
      name: MONTH_NAMES[Number(month.slice(5)) - 1]!,
      paid: sum(paid),
      due: sum(due),
      receipts: paid.length,
      bills: due.length,
    },
    ...(next ? { nextTrip: { title: next.title, days: dayNumber(next.start!) - dayNumber(today) } } : {}),
  };
}

/** How long until something: "1 d 8 h", "10 h 50 m", "4 min". */
export function durationLabel(ms: number): string {
  const left = Math.max(0, ms);
  const days = Math.floor(left / DAY_MS);
  const hours = Math.floor((left % DAY_MS) / HOUR_MS);
  const minutes = Math.floor((left % HOUR_MS) / MINUTE_MS);
  if (days >= 1) {
    return `${days} d ${hours} h`;
  }
  if (hours >= 1) {
    return `${hours} h ${String(minutes).padStart(2, "0")} m`;
  }
  return `${Math.floor(left / MINUTE_MS)} min`;
}

/** "EUR 1,184.00": the currency, then the amount, never converted. */
export function money(amount: Money): string {
  return `${amount.currency} ${Number(amount.value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** "Tue 8 Sep". */
export function dayLabel(iso: string): string {
  const at = new Date(`${iso}T00:00:00Z`);
  return `${WEEKDAYS[at.getUTCDay()]} ${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]}`;
}
