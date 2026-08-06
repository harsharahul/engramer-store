/**
 * The month, with what the vault knows laid onto it.
 *
 * Read-only on purpose: nothing here creates events, because the documents
 * already did. Dots are the dated facts the owner confirmed, capped at three
 * before they become a count; bars are confirmed trips, given lanes the way
 * calendars give overlapping spans lanes, with a chevron where a bar runs
 * off the week. Clicking a day lists what it holds below the grid, and each
 * entry opens the file it came from. A month with nothing shows the plain
 * grid and says so in one line; an empty calendar that invents texture would
 * be the wrong kind of alive.
 *
 * Keyboard follows the ARIA grid pattern: one day holds the tab stop,
 * arrows move it, Home and End reach the week's edges, PageUp and PageDown
 * turn the month, Enter opens the day.
 */

import { useMemo, useRef, useState } from "react";
import type { FileEntry } from "../store";
import { DATED_KINDS, type Fact } from "../intel/facts";
import { describeFact, shown } from "../intel/describe";
import { tripTitle } from "../intel/trips";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
/** Dots up to here; a busier day becomes a number. */
const DOTS_MAX = 3;
/** Lanes drawn before extra spans collapse into a count. */
const LANES_MAX = 4;
const LANE_PX = 18;

interface DayEntry {
  file: FileEntry;
  fact: Fact;
}

interface Trip {
  tag: string;
  title: string;
  start: string;
  end: string;
  lane: number;
}

function isoOf(y: number, m: number, d: number): string {
  return `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function partsOf(iso: string): { y: number; m: number; d: number } {
  const [y, m, d] = iso.split("-").map(Number);
  return { y: y!, m: m! - 1, d: d! };
}

function shiftDays(iso: string, days: number): string {
  const { y, m, d } = partsOf(iso);
  const at = new Date(Date.UTC(y, m, d + days));
  return isoOf(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
}

/** Greedy first-free-lane, the interval trick every calendar uses. */
export function laneTrips(raw: Omit<Trip, "lane">[]): Trip[] {
  const sorted = [...raw].sort(
    (a, b) => a.start.localeCompare(b.start) || b.end.localeCompare(a.end),
  );
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

export function CalendarView(props: { files: FileEntry[]; onOpen: (id: string) => void }) {
  const today = new Date();
  const todayIso = isoOf(today.getFullYear(), today.getMonth(), today.getDate());
  const [cursor, setCursor] = useState({ y: today.getFullYear(), m: today.getMonth() });
  const [focused, setFocused] = useState(todayIso);
  const [selected, setSelected] = useState<string | null>(null);
  const cells = useRef(new Map<string, HTMLButtonElement>());

  const live = props.files.filter((file) => !file.trashed);

  const byDay = useMemo(() => {
    const map = new Map<string, DayEntry[]>();
    for (const file of live) {
      for (const fact of file.facts) {
        if (fact.confirmed && !fact.dismissed && DATED_KINDS.has(fact.kind)) {
          map.set(fact.value, [...(map.get(fact.value) ?? []), { file, fact }]);
        }
      }
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live.map((f) => `${f.id}:${f.facts.length}`).join("|")]);

  const trips = useMemo(() => {
    const byTag = new Map<string, string[]>();
    for (const file of live) {
      for (const tag of file.tags) {
        if (!tag.startsWith("trip:")) {
          continue;
        }
        const dates = file.facts
          .filter((fact) => fact.kind === "event" && !fact.dismissed && fact.confirmed)
          .map((fact) => fact.value);
        byTag.set(tag, [...(byTag.get(tag) ?? []), ...dates]);
      }
    }
    const raw = [...byTag.entries()]
      .filter(([, dates]) => dates.length > 0)
      .map(([tag, dates]) => {
        const sorted = [...dates].sort();
        return { tag, title: tripTitle(tag), start: sorted[0]!, end: sorted[sorted.length - 1]! };
      });
    return laneTrips(raw);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live.map((f) => `${f.id}:${f.tags.join()}:${f.facts.length}`).join("|")]);

  // The visible weeks: leading blanks, the days, trailing blanks.
  const weeks = useMemo(() => {
    const firstDow = new Date(Date.UTC(cursor.y, cursor.m, 1)).getUTCDay();
    const days = new Date(Date.UTC(cursor.y, cursor.m + 1, 0)).getUTCDate();
    const all: (string | null)[] = [
      ...Array.from({ length: firstDow }, () => null),
      ...Array.from({ length: days }, (_, i) => isoOf(cursor.y, cursor.m, i + 1)),
    ];
    while (all.length % 7 !== 0) {
      all.push(null);
    }
    const rows: (string | null)[][] = [];
    for (let i = 0; i < all.length; i += 7) {
      rows.push(all.slice(i, i + 7));
    }
    return rows;
  }, [cursor]);

  const monthHasMarks = useMemo(() => {
    const prefix = `${cursor.y}-${String(cursor.m + 1).padStart(2, "0")}`;
    return (
      [...byDay.keys()].some((iso) => iso.startsWith(prefix)) ||
      trips.some((trip) => trip.start.slice(0, 7) <= prefix && trip.end.slice(0, 7) >= prefix)
    );
  }, [byDay, trips, cursor]);

  const turn = (delta: number) => {
    const m = cursor.m + delta;
    const at = new Date(Date.UTC(cursor.y, m, 1));
    setCursor({ y: at.getUTCFullYear(), m: at.getUTCMonth() });
  };

  const focusDay = (iso: string) => {
    const { y, m } = partsOf(iso);
    if (y !== cursor.y || m !== cursor.m) {
      setCursor({ y, m });
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
      Home: () => focusDay(shiftDays(iso, -new Date(iso).getUTCDay())),
      End: () => focusDay(shiftDays(iso, 6 - new Date(iso).getUTCDay())),
      PageUp: () => turn(-1),
      PageDown: () => turn(1),
    };
    const move = moves[event.key];
    if (move) {
      event.preventDefault();
      move();
    }
  };

  const selectedEntries = selected ? (byDay.get(selected) ?? []) : [];

  return (
    <div className="calendar" aria-label="Calendar of tracked dates">
      <header className="cal-nav">
        <button className="btn btn-small btn-quiet" onClick={() => turn(-1)} aria-label="Previous month">
          ‹
        </button>
        <h3>
          {MONTHS[cursor.m]} {cursor.y}
        </h3>
        <button className="btn btn-small btn-quiet" onClick={() => turn(1)} aria-label="Next month">
          ›
        </button>
        <button
          className="btn btn-small"
          onClick={() => {
            setCursor({ y: today.getFullYear(), m: today.getMonth() });
            focusDay(todayIso);
          }}
        >
          Today
        </button>
      </header>

      <div role="grid" aria-label={`${MONTHS[cursor.m]} ${cursor.y}`} className="cal-grid">
        <div role="row" className="cal-head">
          {WEEKDAYS.map((day) => (
            <span role="columnheader" key={day} aria-label={day}>
              <span className="cal-head-full">{day}</span>
              <span className="cal-head-min">{day[0]}</span>
            </span>
          ))}
        </div>
        {weeks.map((week, w) => {
          const weekStart = week.find((iso) => iso) ?? "";
          const weekEnd = [...week].reverse().find((iso) => iso) ?? "";
          const segments = trips
            .filter((trip) => trip.start <= weekEnd && trip.end >= weekStart)
            .map((trip) => {
              const from = week.findIndex((iso) => iso && iso >= trip.start);
              let to = week.length - 1;
              while (to >= 0 && (!week[to] || week[to]! > trip.end)) {
                to--;
              }
              return { trip, from: Math.max(from, 0), to, opens: trip.start >= weekStart, closes: trip.end <= weekEnd };
            })
            .filter((seg) => seg.to >= seg.from);
          const lanes = Math.min(
            segments.reduce((most, seg) => Math.max(most, seg.trip.lane + 1), 0),
            LANES_MAX,
          );
          const overflow = segments.filter((seg) => seg.trip.lane >= LANES_MAX).length;
          return (
            <div key={w} className="cal-week">
              {lanes > 0 && (
                <div className="cal-spans" style={{ height: lanes * LANE_PX }} role="presentation">
                  {segments
                    .filter((seg) => seg.trip.lane < LANES_MAX)
                    .map((seg) => (
                      <button
                        key={seg.trip.tag}
                        className={`cal-span${seg.opens ? "" : " cont-left"}${seg.closes ? "" : " cont-right"}`}
                        style={{
                          left: `${(seg.from / 7) * 100}%`,
                          width: `${((seg.to - seg.from + 1) / 7) * 100}%`,
                          top: seg.trip.lane * LANE_PX,
                        }}
                        title={seg.trip.title}
                        onClick={() => setSelected(seg.trip.start)}
                      >
                        {seg.opens ? seg.trip.title : "›"}
                      </button>
                    ))}
                  {overflow > 0 && <span className="cal-span-more">+{overflow}</span>}
                </div>
              )}
              <div role="row" className="cal-days">
                {week.map((iso, i) =>
                  iso ? (
                    <button
                      key={iso}
                      role="gridcell"
                      ref={(el) => {
                        if (el) {
                          cells.current.set(iso, el);
                        } else {
                          cells.current.delete(iso);
                        }
                      }}
                      tabIndex={iso === focused ? 0 : -1}
                      aria-label={`${shown(iso)}${byDay.get(iso)?.length ? `, ${byDay.get(iso)!.length} tracked` : ""}`}
                      aria-selected={iso === selected}
                      className={`cal-day${iso === todayIso ? " today" : ""}${iso === selected ? " selected" : ""}`}
                      onKeyDown={(event) => onKey(event, iso)}
                      onClick={() => {
                        setFocused(iso);
                        setSelected(iso === selected ? null : iso);
                      }}
                    >
                      <span className="cal-daynum">{partsOf(iso).d}</span>
                      {(byDay.get(iso)?.length ?? 0) > 0 &&
                        ((byDay.get(iso)!.length > DOTS_MAX) ? (
                          <span className="cal-count">{byDay.get(iso)!.length}</span>
                        ) : (
                          <span className="cal-dots">
                            {byDay.get(iso)!.map((entry) => (
                              <i key={`${entry.file.id}:${entry.fact.id}`} />
                            ))}
                          </span>
                        ))}
                    </button>
                  ) : (
                    <span key={`blank-${w}-${i}`} role="gridcell" aria-hidden className="cal-day blank" />
                  ),
                )}
              </div>
            </div>
          );
        })}
      </div>

      {!monthHasMarks && <p className="cal-quiet">No tracked dates this month.</p>}

      {selected && selectedEntries.length > 0 && (
        <div className="cal-daylist">
          <h4>{shown(selected)}</h4>
          {selectedEntries.map((entry) => (
            <button
              key={`${entry.file.id}:${entry.fact.id}`}
              className="intel-row-open"
              onClick={() => props.onOpen(entry.file.id)}
            >
              <span className="intel-what">{describeFact(entry.fact)}</span>
              <span className="intel-file">{entry.file.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
