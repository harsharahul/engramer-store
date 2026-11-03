/**
 * A trip's page, over the Timeline: its poster, the route drawn on the
 * device, the itinerary, what is booked there and the trip's checks, what
 * it cost, and every file that belongs to it. Every value opens the file it
 * came from. Everything here is read from the trip's view; nothing is
 * worked out a second way.
 */

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { triggerDownload } from "../download";
import type { AgendaRow, RowFile } from "../intel/agendarows";
import type { LatLon } from "../intel/airports";
import { dayLabel, durationLabel, money } from "../intel/everyday";
import { tripToCalendar } from "../intel/ics";
import { tripChecks } from "../intel/insights";
import type { Leg } from "../intel/legs";
import { pagePosterOf } from "../intel/moments";
import { routeOf } from "../intel/route";
import { tripSources, windowOf, type Stay, type TripView } from "../intel/tripview";
import { useStore, type FileEntry } from "../store";
import { Button } from "./ui/button";
import { RouteArc } from "./RouteArc";
import { Card } from "./TimelineCard";
import { Board } from "./TimelineList";
import { CheckLines, Spend } from "./TripCards";
import { TripPoster } from "./TripPoster";

const MINUTE_MS = 60_000;
const dayNumber = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 86_400_000;
/** "Fri 13". */
const shortDay = (iso: string) => dayLabel(iso).split(" ").slice(0, 2).join(" ");
const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
const plusDays = (leg: Leg) => (leg.dep && leg.arr ? dayNumber(leg.arr.day) - dayNumber(leg.dep.day) : 0);

/** Focus in a field, or a dialog's own Escape, keeps the page open. */
function typing(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
}

export function TripPage(props: {
  view: TripView;
  rows: readonly AgendaRow[];
  files: readonly RowFile[];
  now: number;
  homeZone: string;
  homePlace?: LatLon;
  /** Something is open over the page (a preview, an editor, a menu, Notices): Escape is its. */
  covered?: boolean;
  onClose(): void;
  onInspect(fileId: string): void;
  onOpen(fileId: string): void;
  onToast(text: string): void;
  fileOf?(id: string): FileEntry | undefined;
}) {
  const { view } = props;
  const page = useRef<HTMLDivElement>(null);
  const covered = useRef(props.covered);
  covered.current = props.covered;

  // The page takes focus as it opens, so the keyboard and a screen reader
  // land on it, and gives it back to whatever opened it when it closes.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    page.current?.focus({ preventScroll: true });
    return () => {
      if (opener?.isConnected) {
        opener.focus({ preventScroll: true });
      }
    };
  }, []);

  useEffect(() => {
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented && !covered.current && !typing(event.target)) {
        props.onClose();
      }
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
    // The handler reads the latest onClose through props each time it is added.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.onClose]);

  const poster = pagePosterOf(view, props.now, props.homeZone, props.homePlace);
  const route = routeOf(view, props.now);
  const checks = tripChecks(windowOf(view), [...props.files], props.now);
  const byId = new Map(props.files.map((file) => [file.id, file]));
  const tiles = tripSources(view, props.rows, (id) => byId.get(id));
  const booked = view.booked.filter((row) => !row.ask);

  /** A block that opens a file, by click or by Enter. */
  const opener = (fileId: string) => ({
    role: "button",
    tabIndex: 0,
    onClick: () => props.onInspect(fileId),
    onKeyDown: (event: KeyboardEvent) => {
      if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
        event.preventDefault();
        props.onInspect(fileId);
      }
    },
  });

  // The itinerary in time order: each leg, and each stay where it begins.
  const entries: { at: number; node: ReactNode }[] = [];
  for (const leg of view.legs) {
    if (!leg.dep) {
      continue;
    }
    entries.push({
      at: leg.dep.at,
      node: (
        <div key={`${leg.key}:${leg.dep.at}`} className="tln-leg" {...opener(leg.fileId)}>
          <div className="tln-faint tln-small">{dayLabel(leg.dep.day)}</div>
          <Board from={leg.from} to={leg.to} dep={leg.dep.time} arr={leg.arr?.time} number={leg.designator} plusDays={plusDays(leg)} />
        </div>
      ),
    });
  }
  for (const stay of view.stays) {
    const begins = stay.checkIn ?? stay.checkOut;
    if (begins) {
      entries.push({ at: begins.at, node: <StayLeg key={`stay:${stay.fileId}:${begins.day}`} stay={stay} opener={opener} /> });
    }
  }
  entries.sort((a, b) => a.at - b.at);

  return (
    <div ref={page} className="tln-trip" role="region" aria-label={`${view.city} trip`} tabIndex={-1}>
      <TripPoster poster={poster} back={props.onClose} />
      <div className="tln-tp-grid">
        {route && (
          <Card
            title="Route"
            aside={`${route.km.toLocaleString("en-US")} km${route.outMinutes ? ` · ${durationLabel(route.outMinutes * MINUTE_MS)} out` : ""} · drawn on this device, no map service`}
            className="tln-span2"
          >
            <RouteArc route={route} />
          </Card>
        )}
        {entries.length > 0 && <Card title="Itinerary">{entries.map((entry) => entry.node)}</Card>}
        {(booked.length > 0 || checks.length > 0) && (
          <Card title={`Booked in ${view.city}`}>
            {booked.length > 0 && (
              <div className="tln-tlist">
                {booked.map((row) => (
                  <button key={row.id} type="button" className="tln-trow" onClick={() => props.onInspect(row.fileIds[0]!)}>
                    <span className="tln-mono">
                      {shortDay(row.day)}
                      {row.time ? ` ${row.time}` : ""}
                    </span>
                    <span>{row.title}</span>
                    <span className="tln-faint">{row.amount ? money(row.amount) : ""}</span>
                  </button>
                ))}
              </div>
            )}
            {checks.length > 0 && (
              <>
                <div className="tln-sub">Checks</div>
                <CheckLines checks={checks} onInspect={props.onInspect} />
              </>
            )}
          </Card>
        )}
        <Spend view={view} rows={props.rows} title="Spend" page onToast={props.onToast} onInspect={props.onInspect} />
        {tiles.length > 0 && (
          <Card title="Everything for this trip" aside={count(tiles.length, "item")} className="tln-span2">
            <div className="tln-srcgrid">
              {tiles.map((tile) => (
                <button key={tile.fileId} type="button" className="tln-tsrc" onClick={() => props.onInspect(tile.fileId)}>
                  <span className="tln-chip">{tile.chip}</span>
                  <b>{tile.title}</b>
                  <span className="tln-faint">{dayLabel(tile.day)}</span>
                </button>
              ))}
            </div>
          </Card>
        )}
      </div>
      <TripActions view={view} onClose={props.onClose} onToast={props.onToast} />
    </div>
  );
}

/**
 * Export to calendar, and Not a trip. Taking a trip apart cannot be
 * undone, so it asks once, in place.
 */
function TripActions(props: { view: TripView; onClose(): void; onToast(text: string): void }) {
  const undoTrip = useStore((s) => s.undoTrip);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const { view } = props;
  // Done only when every member left the trip; a change that failed (offline)
  // is said, and the trip stays on screen as it still is.
  const takeApart = async () => {
    setBusy(true);
    const changed = await undoTrip(view.tag).catch(() => -1);
    setBusy(false);
    if (changed < view.memberIds.length) {
      setAsking(false);
      props.onToast("Some files could not be changed, so the trip is still here. Try again when you are online.");
      return;
    }
    props.onToast("The trip comes apart. The files stay where they are.");
    props.onClose();
  };
  // A trip with nothing dated to export offers no export: the file would be empty.
  const exportable = tripToCalendar(view, 0).ics.includes("BEGIN:VEVENT");

  if (asking) {
    return (
      <div className="tln-actions tln-trip-actions">
        <span className="tln-faint">Take this trip apart? The files stay where they are.</span>
        <Button size="xs" variant="destructive" disabled={busy} onClick={() => void takeApart()}>
          Take apart
        </Button>
        <Button size="xs" variant="secondary" disabled={busy} onClick={() => setAsking(false)}>
          Keep trip
        </Button>
      </div>
    );
  }
  return (
    <div className="tln-actions tln-trip-actions">
      {exportable && (
        <Button
          size="xs"
          variant="secondary"
          onClick={() => {
            const event = tripToCalendar(view, Date.now());
            triggerDownload(new Blob([event.ics], { type: "text/calendar" }), event.filename);
            props.onToast(`Saved ${event.filename}. Open it to add the trip to your calendar.`);
          }}
        >
          Export to calendar
        </Button>
      )}
      <Button size="xs" variant="ghost" onClick={() => setAsking(true)}>
        Not a trip
      </Button>
    </div>
  );
}

function StayLeg(props: { stay: Stay; opener(fileId: string): Record<string, unknown> }) {
  const { stay } = props;
  const when =
    stay.checkIn && stay.checkOut ? `${shortDay(stay.checkIn.day)} to ${dayLabel(stay.checkOut.day)}` : dayLabel((stay.checkIn ?? stay.checkOut)!.day);
  const details = [
    stay.checkIn?.time ? `In from ${stay.checkIn.time}` : undefined,
    stay.checkOut?.time ? `out by ${stay.checkOut.time}` : undefined,
    stay.address,
  ].filter(Boolean);
  return (
    <div className="tln-leg" {...props.opener(stay.fileId)}>
      <div className="tln-faint tln-small">{when}</div>
      <div className="tln-evt">{stay.nights > 0 ? `${stay.name} · ${count(stay.nights, "night")}` : stay.name}</div>
      {details.length > 0 && <div className="tln-evs">{details.join(" · ")}</div>}
    </div>
  );
}
