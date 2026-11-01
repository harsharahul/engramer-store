/**
 * The Timeline's Month view: the month with what the library knows laid
 * onto it. Trips run as a strip across their days, named on the first day
 * of each week they cross; any other day shows its first row's title and a
 * dot per row in that row's colour. Choosing a day opens it on the list.
 * It reads the Timeline's rows, the same ones the list shows.
 *
 * Keyboard follows the ARIA grid pattern: one day holds the tab stop,
 * arrows move it, Home and End reach the week's edges, PageUp and PageDown
 * turn the month, Enter opens the day.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { Trip } from "../intel/agenda";
import type { AgendaRow } from "../intel/agendarows";
import { shown } from "../intel/describe";

const WEEKDAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const DOTS_MAX = 8;
/** Strips drawn per day before overlapping trips stop stacking. */
const LANES_MAX = 3;

interface LanedTrip {
  tag: string;
  title: string;
  start: string;
  end: string;
  lane: number;
}

function isoOf(y: number, m: number, d: number): string {
  const at = new Date(Date.UTC(y, m, d));
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, "0")}-${String(at.getUTCDate()).padStart(2, "0")}`;
}

function shiftDays(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  return isoOf(y!, m! - 1, d! + days);
}

const weekday = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay();

/** Greedy first-free-lane, the interval trick every calendar uses. */
export function laneTrips(raw: Omit<LanedTrip, "lane">[]): LanedTrip[] {
  const sorted = [...raw].sort((a, b) => a.start.localeCompare(b.start) || b.end.localeCompare(a.end));
  const laneFreeAfter: string[] = [];
  return sorted.map((trip) => {
    let lane = laneFreeAfter.findIndex((free) => free < trip.start);
    if (lane === -1) {
      lane = laneFreeAfter.length;
      laneFreeAfter.push(trip.end);
    } else {
      laneFreeAfter[lane] = trip.end;
    }
    return { ...trip, lane };
  });
}

export function CalendarView(props: {
  rows: AgendaRow[];
  trips: Trip[];
  month: { y: number; m: number };
  today: string;
  onDay(iso: string): void;
  onMonth(delta: number): void;
}) {
  const { y, m } = props.month;
  const first = isoOf(y, m, 1);
  const [focused, setFocused] = useState(() => (props.today.startsWith(first.slice(0, 7)) ? props.today : first));
  const cells = useRef(new Map<string, HTMLDivElement>());

  // A month turned from outside keeps the tab stop inside it.
  useEffect(() => {
    if (!focused.startsWith(first.slice(0, 7))) {
      setFocused(first);
    }
  }, [first, focused]);

  const byDay = useMemo(() => {
    const map = new Map<string, AgendaRow[]>();
    for (const row of props.rows) {
      const held = map.get(row.day) ?? [];
      held.push(row);
      map.set(row.day, held);
    }
    return map;
  }, [props.rows]);

  const trips = useMemo(
    () => laneTrips(props.trips.flatMap(({ tag, title, start, end }) => (start && end ? [{ tag, title, start, end }] : []))),
    [props.trips],
  );

  // Whole weeks from the Sunday before the 1st to the Saturday after the last day.
  const days = useMemo(() => {
    const start = shiftDays(first, -weekday(first));
    const last = isoOf(y, m + 1, 0);
    const end = shiftDays(last, 6 - weekday(last));
    const all: string[] = [];
    for (let day = start; day <= end; day = shiftDays(day, 1)) {
      all.push(day);
    }
    return all;
  }, [first, y, m]);

  const focusDay = (iso: string) => {
    if (iso.slice(0, 7) !== first.slice(0, 7)) {
      props.onMonth(iso < first ? -1 : 1);
    }
    setFocused(iso);
    requestAnimationFrame(() => cells.current.get(iso)?.focus());
  };

  const onKey = (event: React.KeyboardEvent, iso: string) => {
    const moves: Record<string, () => void> = {
      ArrowLeft: () => focusDay(shiftDays(iso, -1)),
      ArrowRight: () => focusDay(shiftDays(iso, 1)),
      ArrowUp: () => focusDay(shiftDays(iso, -7)),
      ArrowDown: () => focusDay(shiftDays(iso, 7)),
      Home: () => focusDay(shiftDays(iso, -weekday(iso))),
      End: () => focusDay(shiftDays(iso, 6 - weekday(iso))),
      PageUp: () => props.onMonth(-1),
      PageDown: () => props.onMonth(1),
      Enter: () => props.onDay(iso),
      " ": () => props.onDay(iso),
    };
    const move = moves[event.key];
    if (move) {
      event.preventDefault();
      move();
    }
  };

  const title = `${MONTHS[m]} ${y}`;
  return (
    <div className="mon" aria-label="Month">
      <div className="mon-head">
        <h3>{title}</h3>
        <span>Trips, bookings, bills and dates. Click a day to open it on the timeline.</span>
      </div>
      <div className="mon-grid" role="grid" aria-label={title}>
        {WEEKDAYS.map((day) => (
          <div key={day} className="mon-dow" role="columnheader">
            {day}
          </div>
        ))}
        {days.map((iso) => {
          const rows = byDay.get(iso) ?? [];
          const covering = trips.filter((trip) => iso >= trip.start && iso <= trip.end && trip.lane < LANES_MAX);
          const opens = (trip: LanedTrip) => iso === trip.start || weekday(iso) === 0;
          const closes = (trip: LanedTrip) => iso === trip.end || weekday(iso) === 6;
          const lead = covering.find((trip) => trip.lane === 0) ?? covering[0];
          const classes = [
            "mon-cell",
            iso.slice(0, 7) === first.slice(0, 7) ? "" : "mon-out",
            iso === props.today ? "mon-today" : "",
            lead ? "mon-trip" : "",
            lead && opens(lead) ? "mon-ts" : "",
            lead && closes(lead) ? "mon-te" : "",
          ].filter(Boolean);
          return (
            <div
              key={iso}
              data-day={iso}
              role="gridcell"
              tabIndex={iso === focused ? 0 : -1}
              ref={(el) => {
                if (el) {
                  cells.current.set(iso, el);
                } else {
                  cells.current.delete(iso);
                }
              }}
              aria-label={`${shown(iso)}${rows.length ? `, ${rows.length} on the timeline` : ""}`}
              className={classes.join(" ")}
              onClick={() => {
                setFocused(iso);
                props.onDay(iso);
              }}
              onKeyDown={(event) => onKey(event, iso)}
            >
              <div className="mon-n">{Number(iso.slice(8))}</div>
              {covering.map((trip) => (
                <span
                  key={trip.tag}
                  className={`mon-strip${opens(trip) ? " mon-strip-ts" : ""}${closes(trip) ? " mon-strip-te" : ""}`}
                  style={{ top: 28 + trip.lane * 20 }}
                >
                  {opens(trip) && <span className="mon-lab">{trip.title.split(",")[0]!.toUpperCase()}</span>}
                </span>
              ))}
              {covering.length === 0 && rows[0] && <div className="mon-t">{rows[0].title}</div>}
              <div className="mon-dots">
                {rows.slice(0, DOTS_MAX).map((row) => (
                  <i key={row.id} className={`tln-k-${row.kind}`} />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
