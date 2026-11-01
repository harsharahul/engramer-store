/**
 * The Timeline's list: one row per dated thing, grouped by day, with the
 * now line where the device's clock falls, trip bands along the rail, and
 * the few questions the library still has, asked in place. It reads only
 * the Timeline's rows; every answer goes through the store or the
 * account's decisions, and nothing is written on render.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Trip } from "../intel/agenda";
import { localDay, localTime, type AgendaRow } from "../intel/agendarows";
import { dayLabel, money } from "../intel/everyday";
import { keepOutOfTrip, rememberTripDismissal } from "../intel/trips";
import { useStore, type FileEntry } from "../store";
import { usePhotoThumb } from "../thumbs";
import { Clock } from "./Clock";
import { Button } from "./ui/button";

export type TimelineFilter = "all" | "trips" | "bills" | "dates";

/** Days of the past shown before "Show earlier"; each press adds MORE_DAYS. */
const PAST_DAYS = 30;
const MORE_DAYS = 90;
/** A gap of this many empty days or more is named. */
const QUIET_DAYS = 3;
const TILES_MAX = 5;
/** How long "Not a trip" can be undone before the refusal is written. */
const UNDO_MS = 30_000;
const DATE_KINDS: ReadonlySet<AgendaRow["kind"]> = new Set(["due", "doc", "event", "trip", "flight", "stay", "parcel"]);
const TILE_FILLS = [
  "linear-gradient(135deg,#1e40af,#93c5fd)",
  "linear-gradient(160deg,#f97316,#fde68a)",
  "linear-gradient(135deg,#0f766e,#5eead4)",
  "linear-gradient(200deg,#ca8a04,#fef3c7)",
  "linear-gradient(135deg,#be185d,#fbcfe8)",
];

const dayNumber = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 86_400_000;
const daysAfter = (iso: string, days: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const tripName = (trip: Trip) => trip.title.split(",")[0]!;

function kept(row: AgendaRow, filter: TimelineFilter): boolean {
  switch (filter) {
    case "trips":
      return row.trip !== undefined || row.kind === "trip";
    case "bills":
      return row.amount !== undefined;
    case "dates":
      return DATE_KINDS.has(row.kind);
    default:
      return true;
  }
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
    : false;
}

export function TimelineList(props: {
  rows: AgendaRow[];
  trips: Trip[];
  homeCity: string;
  now: number;
  filter: TimelineFilter;
  scrollTo?: { day?: string; now?: boolean; nonce: number };
  onInspect(fileId: string): void;
  onOpen(fileId: string): void;
  onToast(text: string): void;
  fileOf?(id: string): FileEntry | undefined;
  /** The file open in the details pane, whose row is marked. */
  selectedFileId?: string;
}) {
  const account = useStore((s) => s.session?.email ?? "");
  const addToTrip = useStore((s) => s.addToTrip);
  const resolveFacts = useStore((s) => s.resolveFacts);
  const confirmTrip = useStore((s) => s.confirmTrip);
  const [earlier, setEarlier] = useState(0);
  const [keptTrips, setKeptTrips] = useState<ReadonlySet<string>>(new Set());
  const [refused, setRefused] = useState<ReadonlySet<string>>(new Set());
  // Refusals waiting out their Undo, written when the time is up or the list closes.
  const waiting = useRef(new Map<string, { keys: string[]; timer: ReturnType<typeof setTimeout> }>());
  const nowRef = useRef<HTMLDivElement>(null);
  const dayRefs = useRef(new Map<string, HTMLDivElement>());

  useEffect(() => {
    const held = waiting.current;
    return () => {
      for (const { keys, timer } of held.values()) {
        clearTimeout(timer);
        rememberTripDismissal(account, keys);
      }
      held.clear();
    };
  }, [account]);

  useEffect(() => {
    const day = props.scrollTo?.day;
    const target = day
      ? [...dayRefs.current.entries()].sort((a, b) => a[0].localeCompare(b[0])).find(([iso]) => iso >= day)?.[1]
      : nowRef.current;
    target?.scrollIntoView?.({ block: day ? "start" : "center", behavior: props.scrollTo && !prefersReducedMotion() ? "smooth" : "auto" });
    // Only a new request scrolls; a re-render never moves the list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.scrollTo?.nonce]);

  const refuse = (row: AgendaRow) => {
    const keys = row.proposal!.dismissKeys;
    const timer = setTimeout(() => {
      waiting.current.delete(row.id);
      rememberTripDismissal(account, keys);
    }, UNDO_MS);
    waiting.current.set(row.id, { keys, timer });
    setRefused((held) => new Set([...held, row.id]));
  };
  const undo = (row: AgendaRow) => {
    clearTimeout(waiting.current.get(row.id)?.timer);
    waiting.current.delete(row.id);
    setRefused((held) => new Set([...held].filter((id) => id !== row.id)));
  };

  const today = localDay(props.now);
  const clock = localTime(props.now);
  // A day asked for further back than the window widens the window to it,
  // and the window stays that wide.
  const reach = useRef<string | undefined>(undefined);
  const asked = props.scrollTo?.day;
  if (asked && (reach.current === undefined || asked < reach.current)) {
    reach.current = asked;
  }
  const shownFrom = daysAfter(today, -(PAST_DAYS + MORE_DAYS * earlier));
  const from = reach.current && reach.current < shownFrom ? reach.current : shownFrom;
  const filtered = props.rows.filter((row) => kept(row, props.filter));
  const hidden = filtered.filter((row) => row.day < from).length;
  const visible = filtered.filter((row) => row.day >= from);
  const spans = props.trips.filter((trip) => trip.start !== undefined && trip.end !== undefined);
  const tripOn = (day: string) => spans.find((trip) => day >= trip.start! && day <= trip.end!);

  // Each trip's band starts and ends on a diamond: its first and last
  // flights, or its first and last rows when it has none.
  const starts = new Set<string>();
  const ends = new Set<string>();
  for (const trip of spans) {
    const own = visible.filter((row) => row.trip?.tag === trip.tag && row.trip.evidence === "exact");
    const inside = own.length > 0 ? own : visible.filter((row) => row.day >= trip.start! && row.day <= trip.end!);
    const flights = inside.filter((row) => row.kind === "flight");
    const marked = flights.length > 0 ? flights : inside;
    if (marked.length > 0) {
      starts.add(marked[0]!.id);
      ends.add(marked[marked.length - 1]!.id);
    }
  }

  const here = tripOn(today);
  const items: ReactNode[] = [];
  let placed = false;
  const placeNow = () => {
    if (placed) {
      return;
    }
    placed = true;
    items.push(
      <div key="now" ref={nowRef} className={`tln-now${here ? " tln-in" : ""}`}>
        <div className="tln-t">
          <Clock />
        </div>
        <div className="tln-rail">
          <span className="tln-dot" />
        </div>
        <div className="tln-ln">
          <span>NOW · {(here ? tripName(here) : props.homeCity).toUpperCase()}</span>
        </div>
      </div>,
    );
  };

  let previous: string | undefined;
  for (const row of visible) {
    const later = row.day > today || (row.day === today && row.time !== undefined && row.time > clock);
    if (row.day !== previous) {
      if (later && row.day > today) {
        placeNow();
      }
      const gap = previous ? dayNumber(row.day) - dayNumber(previous) - 1 : 0;
      if (gap >= QUIET_DAYS) {
        const both = previous !== undefined && tripOn(previous) !== undefined && tripOn(row.day) !== undefined;
        items.push(
          <div key={`gap:${row.day}`} className={`tln-gap${both ? " tln-in" : ""}`}>
            <div />
            <div className="tln-rail" />
            <span>{gap} quiet days</span>
          </div>,
        );
      }
      const trip = tripOn(row.day);
      const day = row.day;
      items.push(
        <div
          key={`day:${day}`}
          ref={(el) => {
            if (el) {
              dayRefs.current.set(day, el);
            } else {
              dayRefs.current.delete(day);
            }
          }}
          className={`tln-dayh${trip ? " tln-in" : ""}`}
        >
          <div />
          <div className="tln-rail" />
          <div className="tln-lbl">
            {dayLabel(day)}
            {day === today && <span className="tln-pill">TODAY</span>}
            {trip && (
              <span className="tln-tday">
                {tripName(trip)} · day {dayNumber(day) - dayNumber(trip.start!) + 1}
              </span>
            )}
          </div>
        </div>,
      );
      previous = row.day;
    }
    if (later) {
      placeNow();
    }
    items.push(
      <TimelineRow
        key={row.id}
        row={row}
        inTrip={tripOn(row.day) !== undefined}
        start={starts.has(row.id)}
        end={ends.has(row.id)}
        kept={keptTrips.has(row.id)}
        refused={refused.has(row.id)}
        selected={props.selectedFileId !== undefined && row.fileIds[0] === props.selectedFileId}
        fileOf={props.fileOf}
        onInspect={() => (row.kind === "photos" ? props.onOpen(row.fileIds[0]!) : props.onInspect(row.fileIds[0]!))}
        onOpenFile={props.onOpen}
        onAdd={() => {
          void addToTrip([row.fileIds[0]!], row.trip!.tag);
          props.onToast(`Added to ${row.trip!.name}. The trip total is updated.`);
        }}
        onNo={() => {
          keepOutOfTrip(account, row.trip!.tag, [row.fileIds[0]!]);
          props.onToast("Kept out of the trip.");
        }}
        onConfirm={() => {
          void resolveFacts(row.fileIds[0]!, { confirm: row.factIds ?? [] });
          props.onToast("Date confirmed. A notice comes a week before.");
        }}
        onKeep={() => {
          setKeptTrips((held) => new Set([...held, row.id]));
          void confirmTrip(row.proposal!);
          props.onToast("Trip kept. Later bookings join it on their own.");
        }}
        onRefuse={() => refuse(row)}
        onUndo={() => undo(row)}
      />,
    );
  }
  placeNow();

  return (
    <div className="tln-list">
      {hidden > 0 && (
        <div className="tln-earlier">
          <Button size="xs" variant="secondary" onClick={() => setEarlier((n) => n + 1)}>
            Show earlier · {hidden}
          </Button>
        </div>
      )}
      {items}
    </div>
  );
}

/** A photo's thumbnail, or a soft gradient while it loads or when it has none. */
export function Tile(props: { file?: FileEntry; index: number; more?: number; onOpen(): void }) {
  const { ref, thumb } = usePhotoThumb<HTMLButtonElement>(
    props.file ?? { id: `tile-${props.index}`, key: new Uint8Array(0), hasThumb: false },
  );
  return (
    <button
      ref={ref}
      type="button"
      className="tln-tile"
      style={{ background: thumb ? `center / cover no-repeat url(${thumb})` : TILE_FILLS[props.index % TILE_FILLS.length] }}
      aria-label={props.file?.name ?? "Photo"}
      onClick={(event) => {
        event.stopPropagation();
        props.onOpen();
      }}
    >
      {props.more ? `+${props.more}` : ""}
    </button>
  );
}

function TimelineRow(props: {
  row: AgendaRow;
  inTrip: boolean;
  start: boolean;
  end: boolean;
  kept: boolean;
  refused: boolean;
  selected: boolean;
  fileOf?(id: string): FileEntry | undefined;
  onInspect(): void;
  onOpenFile(id: string): void;
  onAdd(): void;
  onNo(): void;
  onConfirm(): void;
  onKeep(): void;
  onRefuse(): void;
  onUndo(): void;
}) {
  const { row } = props;
  const stop = (act: () => void) => (event: { stopPropagation(): void }) => {
    event.stopPropagation();
    act();
  };
  const classes = [
    "tln-row",
    `tln-k-${row.kind}`,
    row.past ? "tln-past" : "",
    props.inTrip ? "tln-in" : "",
    props.start ? "tln-start" : "",
    props.end ? "tln-end" : "",
    row.proposal ? "tln-proposal" : "",
  ].filter(Boolean);

  if (row.proposal && props.refused) {
    return (
      <div className={classes.join(" ")} data-id={row.id}>
        <div className="tln-t">{row.time ?? ""}</div>
        <div className="tln-rail">
          <span className="tln-node" />
        </div>
        <div className="tln-ev tln-gone">
          <span className="tln-evs">Not a trip. The dates stay as they were.</span>
          <Button size="xs" variant="ghost" onClick={stop(props.onUndo)}>
            Undo
          </Button>
        </div>
      </div>
    );
  }

  const shown = row.kind === "photos" ? row.fileIds.slice(0, TILES_MAX) : [];
  const more = row.fileIds.length - shown.length;
  return (
    <div className={classes.join(" ")} data-id={row.id}>
      <div className="tln-t">{row.time ?? ""}</div>
      <div className="tln-rail">
        <span className={`tln-node${props.start || props.end ? " tln-dia" : ""}`} />
      </div>
      <div
        className={`tln-ev${props.selected ? " tln-sel" : ""}`}
        role="button"
        tabIndex={0}
        aria-label={row.title}
        aria-pressed={props.selected}
        onClick={props.onInspect}
        onKeyDown={(event) => {
          // Keys pressed on a button inside the card belong to that button.
          if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
            event.preventDefault();
            props.onInspect();
          }
        }}
      >
        <div className="tln-evtop">
          <span className="tln-tag">{row.proposal && props.kept ? "TRIP" : row.tag}</span>
          <span className="tln-chips">
            {row.trip?.evidence === "exact" && <span className="tln-chip tln-chip-trip">{row.trip.name.toUpperCase()}</span>}
            <span className="tln-chip">{row.source}</span>
          </span>
        </div>
        {row.flight ? (
          <div className="tln-board">
            <b>{row.flight.from}</b>
            <span className="tln-tm">{row.flight.dep ?? ""}</span>
            <span className="tln-track">
              <span>{row.flight.number}</span>
            </span>
            <b>{row.flight.to}</b>
            <span className="tln-tm">
              {row.flight.arr ?? ""}
              {row.flight.plusDays > 0 && <sup>+{row.flight.plusDays}</sup>}
            </span>
          </div>
        ) : (
          <div className="tln-evrow">
            <div>
              <div className="tln-evt">{row.proposal && props.kept ? row.title.replace(/\?$/, "") : row.title}</div>
              {row.sub && !row.proposal && <div className="tln-evs">{row.sub}</div>}
            </div>
            {row.amount && <div className="tln-amt">{money(row.amount)}</div>}
          </div>
        )}
        {row.kind === "photos" && (
          <div className="tln-tiles">
            {shown.map((id, index) => (
              <Tile
                key={id}
                file={props.fileOf?.(id)}
                index={index}
                more={index === shown.length - 1 && more > 0 ? more + 1 : undefined}
                onOpen={() => props.onOpenFile(id)}
              />
            ))}
          </div>
        )}
        {row.trip?.evidence === "weak" && (
          <div className="tln-suggest">
            <span>Part of {row.trip.name}? Only the date matches.</span>
            <Button size="xs" onClick={stop(props.onAdd)}>
              Add
            </Button>
            <Button size="xs" variant="ghost" onClick={stop(props.onNo)}>
              No
            </Button>
          </div>
        )}
        {row.ask && (
          <div className="tln-suggest">
            <span>Not confirmed yet.</span>
            <Button size="xs" onClick={stop(props.onConfirm)}>
              Confirm date
            </Button>
          </div>
        )}
        {row.confirmedByYou && <div className="tln-evs tln-ok">Date confirmed by you</div>}
        {row.proposal &&
          (props.kept ? (
            <div className="tln-evs">Kept. Bookings that arrive later join it on their own.</div>
          ) : (
            <>
              <div className="tln-evs">{row.sub}</div>
              <div className="tln-actions">
                <Button size="xs" onClick={stop(props.onKeep)}>
                  Keep trip
                </Button>
                <Button size="xs" variant="ghost" onClick={stop(props.onRefuse)}>
                  Not a trip
                </Button>
              </div>
            </>
          ))}
      </div>
    </div>
  );
}
