/**
 * A trip's cards under its poster, one set per moment. Every value comes from
 * the trip view, its checks and the Timeline's rows, and every line opens
 * the file it came from.
 */

import { Fragment, useEffect, useState } from "react";
import { dayLabel, durationLabel, money } from "../intel/everyday";
import type { AgendaRow } from "../intel/agendarows";
import type { FactEvidence } from "../intel/facts";
import { tripChecks, type Check, type FactfulFile } from "../intel/insights";
import { zonedDay, zonedTime } from "../intel/instants";
import type { Leg } from "../intel/legs";
import { journeyOf, rangeLabel, type Moment } from "../intel/moments";
import { comingUp, tripSpend, windowOf, type Stay, type TripView } from "../intel/tripview";
import { useStore, type FileEntry } from "../store";
import { Until } from "./Clock";
import { Amounts, Card } from "./TimelineCard";
import { Board, Tile } from "./TimelineList";
import { Button } from "./ui/button";

const HOUR_MS = 3_600_000;
/** How near a departure the boarding pass, or the wait for it, shows. */
const PASS_HOURS = 48;

/**
 * The airline's check-in link a departure's evidence holds, read once when
 * the card can use it. Only the link is kept; the rest of the evidence (full
 * references, passages) is never held in the page.
 */
function useCheckinLink(fileId: string | undefined, factId: string | undefined): string | undefined {
  const factEvidence = useStore((s) => s.factEvidence);
  const [link, setLink] = useState<string | undefined>(undefined);
  useEffect(() => {
    let stale = false;
    setLink(undefined);
    if (fileId && factId) {
      void factEvidence(fileId)
        .then((read: FactEvidence[]) => {
          if (!stale) {
            setLink(read.find((entry) => entry.id === factId)?.link);
          }
        })
        .catch(() => {});
    }
    return () => {
      stale = true;
    };
  }, [fileId, factId, factEvidence]);
  return link;
}

const nextDay = (iso: string) => new Date(Date.parse(`${iso}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
const mapsUrl = (place: string) => `https://maps.apple.com/?q=${encodeURIComponent(place)}`;

/** The leg that lands at the trip's destination. */
function landingOf(view: TripView): Leg | undefined {
  return journeyOf(view).arrival;
}

/** "Flight", "Train": how a leg travels, for its card's words. */
const modeWord = (leg: Leg) => leg.mode[0]!.toUpperCase() + leg.mode.slice(1);
const plusDays = (leg: Leg) => (leg.dep && leg.arr ? dayNumber(leg.arr.day) - dayNumber(leg.dep.day) : 0);

const PHOTO_TILES = 6;
const BOOKED_SHOWN = 3;
const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
const dayNumber = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 86_400_000;
const weekday = (iso: string) => dayLabel(iso).split(" ")[0]!;
const shortDay = (iso: string) => dayLabel(iso).split(" ").slice(0, 2).join(" ");
const named = (leg: Leg) => leg.designator || `Your ${leg.mode}`;

/** "7 emails and 1 PDF". */
function sourcesLine(sources: TripView["sources"]): string {
  const parts = [
    sources.email > 0 ? count(sources.email, "email") : "",
    sources.pdf > 0 ? count(sources.pdf, "PDF") : "",
    sources.other > 0 ? count(sources.other, "file") : "",
  ].filter(Boolean);
  return parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : (parts[0] ?? "");
}

export interface TripCardProps {
  moment: Moment;
  rows: readonly AgendaRow[];
  files: readonly FactfulFile[];
  now: number;
  onInspect(fileId: string): void;
  onOpen(fileId: string): void;
  onToast(text: string): void;
  /** Opens a trip's page. */
  onOpenTrip?(tag: string): void;
  fileOf?(id: string): FileEntry | undefined;
}

interface Opens {
  key: string;
  text: string;
  fileId: string;
}

/** A line of values, each opening the file it came from. */
function Links(props: { items: Opens[]; separator: string; more?: number; onInspect(fileId: string): void }) {
  return (
    <div>
      {props.items.map((item, i) => (
        <Fragment key={item.key}>
          {i > 0 && props.separator}
          <button type="button" className="tln-link" onClick={() => props.onInspect(item.fileId)}>
            {item.text}
          </button>
        </Fragment>
      ))}
      {props.more ? ` and ${props.more} more` : ""}
    </div>
  );
}

function TheTrip(props: { view: TripView; onInspect(fileId: string): void }) {
  const { view } = props;
  const { outbound: out, homeward: back } = journeyOf(view);
  const flights: Opens[] = [
    ...(out?.dep?.time ? [{ key: "out", text: `${named(out)} out ${weekday(out.dep.day)} ${out.dep.time}`, fileId: out.fileId }] : []),
    ...(back?.dep?.time ? [{ key: "home", text: `${named(back)} home ${weekday(back.dep.day)} ${back.dep.time}`, fileId: back.fileId }] : []),
  ];
  const stays: Opens[] = view.stays
    .filter((stay) => stay.nights > 0)
    .map((stay, i) => ({ key: `stay${i}`, text: `${stay.name || "Stay"} · ${count(stay.nights, "night")}`, fileId: stay.fileId }));
  const booked: Opens[] = view.booked.map((row) => ({ key: row.id, text: row.title, fileId: row.fileIds[0]! }));
  return (
    <Card title="The trip">
      <div className="tln-title">
        {view.city} · {rangeLabel(view.start, view.end, false)}
      </div>
      <div className="tln-kv tln-kv-gap">
        {flights.length > 0 && (
          <>
            <span>{view.legs.every((leg) => leg.mode === "flight") ? "Flights" : "Journeys"}</span>
            <Links items={flights} separator=" · " onInspect={props.onInspect} />
          </>
        )}
        {stays.length > 0 && (
          <>
            <span>Stay</span>
            <Links items={stays} separator=", " onInspect={props.onInspect} />
          </>
        )}
        {booked.length > 0 && (
          <>
            <span>Booked</span>
            <Links
              items={booked.slice(0, BOOKED_SHOWN)}
              separator=", "
              {...(booked.length > BOOKED_SHOWN ? { more: booked.length - BOOKED_SHOWN } : {})}
              onInspect={props.onInspect}
            />
          </>
        )}
      </div>
      {view.exact && (
        <div className="tln-found">
          <span className="tln-evb tln-evb-exact">FOUND IN YOUR MAIL</span>
          <span className="tln-faint">{sourcesLine(view.sources)}, joined on their own</span>
        </div>
      )}
    </Card>
  );
}

const CHECK_WORD: Record<Check["state"], string> = { ok: "OK", note: "NOTE", warn: "WARN" };

export function Checks(props: { title: string; checks: Check[]; onInspect(fileId: string): void }) {
  if (props.checks.length === 0) {
    return null;
  }
  return (
    <Card title={props.title}>
      <CheckLines checks={props.checks} onInspect={props.onInspect} />
    </Card>
  );
}

/** A trip's check lines, each opening the file it is about: the hero's card and the trip page share them. */
export function CheckLines(props: { checks: Check[]; onInspect(fileId: string): void }) {
  return (
    <div className="tln-clist">
        {props.checks.map((check) => {
          const body = (
            <>
              <span className={`tln-ck tln-ck-${check.state}`}>{CHECK_WORD[check.state]}</span>
              <span>
                <span className="tln-check-title">{check.title}</span>
                {check.text && <span className="tln-faint">{check.text}</span>}
              </span>
            </>
          );
          return check.fileId ? (
            <button key={`${check.ruleId}:${check.title}`} type="button" className="tln-check" onClick={() => props.onInspect(check.fileId!)}>
              {body}
            </button>
          ) : (
            <div key={`${check.ruleId}:${check.title}`} className="tln-check">
              {body}
            </div>
          );
        })}
    </div>
  );
}

/**
 * What the trip cost, per currency and never converted. The hero says how
 * many receipts it read; the trip page (`page`) lists each bill instead.
 */
export function Spend(props: {
  view: TripView;
  rows: readonly AgendaRow[];
  title: string;
  page?: boolean;
  onToast(text: string): void;
  onInspect(fileId: string): void;
}) {
  const addToTrip = useStore((s) => s.addToTrip);
  const spend = tripSpend(props.view, props.rows);
  const waiting = spend.waiting;
  // Nothing spent and nothing waiting: the card would only say "none".
  if (spend.count === 0 && !waiting) {
    return null;
  }
  const add = () => {
    void addToTrip(waiting!.fileIds, props.view.tag);
    props.onToast(`Added to ${props.view.city}. The trip total is updated.`);
  };
  if (props.page) {
    return (
      <Card title={props.title} aside="never converted" className="tln-span2">
        <Amounts sums={spend.sums} />
        {spend.bills.length > 0 && (
          <div className="tln-tlist">
            {spend.bills.map((bill) => (
              <button key={bill.id} type="button" className="tln-trow tln-bill" onClick={() => props.onInspect(bill.fileIds[0]!)}>
                <span className="tln-mono">{shortDay(bill.day)}</span>
                <span>{bill.title}</span>
                <span className="tln-mono">{bill.amount ? money(bill.amount) : ""}</span>
              </button>
            ))}
          </div>
        )}
        {waiting && (
          <div className="tln-suggest">
            <span>
              Waiting for you:{" "}
              <button type="button" className="tln-link" onClick={() => props.onInspect(waiting.fileIds[0]!)}>
                {waiting.title}
                {waiting.amount ? ` ${money(waiting.amount)}` : ""}
              </button>
              , only the date matches.
            </span>
            <Button size="xs" onClick={add}>
              Add
            </Button>
          </div>
        )}
      </Card>
    );
  }
  return (
    <Card title={props.title}>
      <Amounts sums={spend.sums} />
      <div className="tln-faint">
        Read from {spend.count} {spend.count === 1 ? "receipt or booking" : "receipts and bookings"} · never converted
      </div>
      {waiting && (
        <div className="tln-suggest">
          <span>
            1 receipt waits:{" "}
            <button type="button" className="tln-link" onClick={() => props.onInspect(waiting.fileIds[0]!)}>
              {waiting.title}
              {waiting.amount ? ` ${money(waiting.amount)}` : ""}
            </button>
          </span>
          <Button size="xs" onClick={add}>
            Add to trip
          </Button>
        </div>
      )}
    </Card>
  );
}

function ComingUp(props: { rows: AgendaRow[]; onInspect(fileId: string): void }) {
  if (props.rows.length === 0) {
    return null;
  }
  return (
    <Card title="Also coming up">
      <div className="tln-tlist">
        {props.rows.map((row) => (
          <button key={row.id} type="button" className="tln-trow" onClick={() => props.onInspect(row.fileIds[0]!)}>
            <span className="tln-mono">{shortDay(row.day)}</span>
            <span>
              {row.title}
              {row.amount && <span className="tln-faint"> {money(row.amount)}</span>}
            </span>
            <span className="tln-soon">{row.kind === "due" ? "due" : (row.time ?? "")}</span>
          </button>
        ))}
      </div>
    </Card>
  );
}

function WelcomeBack(props: { view: TripView; onOpenTrip?(tag: string): void }) {
  const { view } = props;
  const stats: [number, string][] = [
    [dayNumber(view.end) - dayNumber(view.start) + 1, "day"],
    [view.legs.length, view.legs.every((leg) => leg.mode === "flight") ? "flight" : "journey"],
    [view.stays.reduce((sum, stay) => sum + stay.nights, 0), "night"],
    [view.booked.length, "booking"],
  ];
  return (
    <Card title="Welcome back">
      <div className="tln-title">
        {view.city} · {rangeLabel(view.start, view.end, false)}
      </div>
      <div className="tln-stats">
        {stats
          .filter(([n]) => n > 0)
          .map(([n, noun]) => (
            <div key={noun}>
              <b>{n}</b>
              <span>{count(n, noun).slice(String(n).length + 1)}</span>
            </div>
          ))}
      </div>
      {props.onOpenTrip && (
        <div className="tln-actions">
          <Button size="xs" variant="secondary" onClick={() => props.onOpenTrip!(view.tag)}>
            Open trip
          </Button>
        </div>
      )}
    </Card>
  );
}

function Photos(props: { view: TripView; rows: readonly AgendaRow[]; onOpen(fileId: string): void; fileOf?(id: string): FileEntry | undefined }) {
  const ids = props.rows
    .filter((row) => row.kind === "photos" && row.day >= props.view.start && row.day <= props.view.end)
    .flatMap((row) => row.fileIds);
  if (ids.length === 0) {
    return null;
  }
  const shown = ids.slice(0, PHOTO_TILES);
  return (
    <Card title={`${count(ids.length, "photo")} from these days`}>
      <div className="tln-pgrid">
        {shown.map((id, index) => (
          <Tile
            key={id}
            file={props.fileOf?.(id)}
            index={index}
            more={index === shown.length - 1 && ids.length > shown.length ? ids.length - shown.length + 1 : undefined}
            onOpen={() => props.onOpen(id)}
          />
        ))}
      </div>
    </Card>
  );
}

function CheckIn(props: { moment: Moment; now: number; onInspect(fileId: string): void }) {
  const leg = props.moment.next;
  const usable = leg?.dep !== undefined && props.moment.checkInOpens !== undefined;
  const link = useCheckinLink(usable ? leg!.fileId : undefined, usable ? leg!.dep!.factId : undefined);
  if (!leg?.dep || props.moment.checkInOpens === undefined) {
    return null;
  }
  const opens = props.moment.checkInOpens;
  const opensAt = `${zonedTime(opens, leg.dep.zone)}`;
  const opensOn = dayLabel(zonedDay(opens, leg.dep.zone));
  const open = props.now >= opens;
  return (
    <Card title={open ? "Check-in is open" : "Check-in"}>
      <div className="tln-title">
        {open ? `${named(leg)} · ${dayLabel(leg.dep.day)}${leg.dep.time ? ` ${leg.dep.time}` : ""}` : `Opens ${opensOn} at ${opensAt}`}
      </div>
      <div className="tln-muted">
        Online check-in usually opens 24 hours before departure.{open ? ` It opened at ${opensAt} on ${opensOn}.` : ""}
      </div>
      <div className="tln-actions">
        {link ? (
          <Button size="xs" nativeButton={false} render={<a href={link} target="_blank" rel="noreferrer" />}>
            Check in
          </Button>
        ) : (
          <Button size="xs" variant="secondary" onClick={() => props.onInspect(leg.fileId)}>
            Open booking
          </Button>
        )}
      </div>
    </Card>
  );
}

function BoardingPass(props: { leg: Leg | undefined; now: number; onOpen(fileId: string): void }) {
  const leg = props.leg;
  // Only a flight has a boarding pass to wait for.
  if (leg?.mode !== "flight") {
    return null;
  }
  if (!leg?.dep || leg.dep.at <= props.now || leg.dep.at - props.now > PASS_HOURS * HOUR_MS) {
    return null;
  }
  if (!leg.passFileId) {
    return (
      <Card title="Boarding pass" tone="dashed">
        <div className="tln-muted">It arrives in your mail after check-in, and shows up here on its own.</div>
      </Card>
    );
  }
  const cells = [
    ["Boarding", leg.boardingTime],
    ["Gate", leg.gate],
    ["Seat", leg.seat],
  ].filter((cell): cell is [string, string] => cell[1] !== undefined);
  return (
    <Card title="Boarding pass">
      <div className="tln-pmini">
        <div className="tln-pmini-head">
          <span>BOARDING PASS</span>
          <span>
            {named(leg)} · {dayLabel(leg.dep.day)}
          </span>
        </div>
        <div className="tln-pmini-route">
          <b>{leg.from}</b>
          <i />
          <b>{leg.to}</b>
        </div>
        {cells.length > 0 && (
          <div className="tln-kv tln-pmini-cells">
            {cells.map(([name, value]) => (
              <span key={name} className="tln-pmini-cell">
                {name}
              </span>
            )).flatMap((label, i) => [label, <b key={`${cells[i]![0]}:v`}>{cells[i]![1]}</b>])}
          </div>
        )}
      </div>
      <div className="tln-actions">
        <Button size="xs" onClick={() => props.onOpen(leg.passFileId!)}>
          Show pass
        </Button>
      </div>
    </Card>
  );
}

function LeaveBy(props: { moment: Moment; now: number; onInspect(fileId: string): void }) {
  const leave = props.moment.leaveBy;
  // Once the time to leave has passed, the card has nothing left to say.
  if (!leave || leave.at <= props.now) {
    return null;
  }
  return (
    <Card title={`Leave for ${leave.code} by`}>
      <button type="button" className="tln-big-local tln-plain" onClick={() => props.moment.next && props.onInspect(props.moment.next.fileId)}>
        {zonedTime(leave.at, leave.zone)}
      </button>
      <div className="tln-muted">
        in <Until at={leave.at} /> · {leave.hours} hours before {leave.international ? "an international" : "a domestic"} departure
      </div>
    </Card>
  );
}

function Hotel(props: {
  mode: "stay" | "land" | "out";
  moment: Moment;
  files: readonly FactfulFile[];
  now: number;
  onInspect(fileId: string): void;
}) {
  const view = props.moment.trip!;
  const [revealed, setRevealed] = useState<string | null>(null);
  const factEvidence = useStore((s) => s.factEvidence);
  const landing = landingOf(view);
  const stay: Stay | undefined =
    props.mode === "stay"
      ? (props.moment.night?.stay ?? view.stays[0])
      : props.mode === "land"
        ? (view.stays.find((candidate) => candidate.checkIn?.day === landing?.arr?.day) ?? view.stays[0])
        : view.stays.at(-1);
  // A reference revealed for one stay never shows under the next.
  const shown = stay?.fileId;
  useEffect(() => setRevealed(null), [shown]);
  // Directions need something to search for: an address, else a name.
  const place = stay?.address ?? (stay?.name ? `${stay.name}, ${view.city}` : undefined);
  const directions = place ? (
    <Button size="xs" variant="secondary" nativeButton={false} render={<a href={mapsUrl(place)} target="_blank" rel="noreferrer" />}>
      Directions
    </Button>
  ) : null;
  const confirmation = stay ? (
    <Button size="xs" onClick={() => props.onInspect(stay.fileId)}>
      Open confirmation
    </Button>
  ) : null;

  if (props.mode === "out") {
    const out = stay?.checkOut;
    if (!stay || !out?.time || out.at <= props.now) {
      return null;
    }
    return (
      <Card title="Check out by" className="tln-card-stay">
        <div className="tln-big-local">{out.time}</div>
        <div className="tln-muted">
          in <Until at={out.at} />
          {stay.name ? ` · ${stay.name}` : ""}
        </div>
        <div className="tln-actions">{confirmation}</div>
      </Card>
    );
  }

  if (props.mode === "land") {
    const arr = landing?.arr;
    const checkIn = stay?.checkIn;
    if (!arr && !checkIn) {
      return null;
    }
    const landingLine = arr?.time
      ? checkIn?.time && arr.at < checkIn.at
        ? `${arr.time} · ${durationLabel(checkIn.at - arr.at)} before check-in opens`
        : checkIn?.time
          ? `${arr.time} · after check-in opens`
          : arr.time
      : undefined;
    return (
      <Card title="When you land" className="tln-card-stay">
        {stay?.name && <div className="tln-title">{stay.name}</div>}
        {stay?.address && <div className="tln-muted">{stay.address}</div>}
        <div className="tln-kv tln-kv-gap">
          {checkIn && (
            <>
              <span>Check-in</span>
              <div>
                {dayLabel(checkIn.day)}
                {checkIn.time ? ` · from ${checkIn.time}` : ""}
              </div>
            </>
          )}
          {landingLine && (
            <>
              <span>Landing</span>
              <div>{landingLine}</div>
            </>
          )}
        </div>
        {stay && (
          <div className="tln-actions">
            {confirmation}
            {directions}
          </div>
        )}
      </Card>
    );
  }

  if (!stay) {
    return null;
  }
  const reference = stay.refFactId
    ? props.files.flatMap((file) => file.facts).find((fact) => fact.id === stay.refFactId)
    : undefined;
  const night = props.moment.night;
  return (
    <Card title="Staying" {...(night ? { aside: `Night ${night.n} of ${night.of}` } : {})} className="tln-card-stay">
      {stay.name && <div className="tln-title">{stay.name}</div>}
      {stay.address && <div className="tln-muted">{stay.address}</div>}
      <div className="tln-kv tln-kv-gap">
        {stay.checkOut && (
          <>
            <span>Check-out</span>
            <div>
              {dayLabel(stay.checkOut.day)}
              {stay.checkOut.time ? ` · ${stay.checkOut.time}` : ""}
            </div>
          </>
        )}
        {reference && (
          <>
            <span>Booking</span>
            <div>
              <span className="tln-mono">{revealed ?? `…${reference.masked ?? reference.value}`}</span>{" "}
              {revealed ? (
                <Button size="xs" variant="link" onClick={() => setRevealed(null)}>
                  Hide
                </Button>
              ) : (
                <Button
                  size="xs"
                  variant="link"
                  onClick={async () => {
                    const full = (await factEvidence(stay.fileId)).find((entry) => entry.id === reference.id)?.full;
                    if (full) {
                      setRevealed(full);
                    }
                  }}
                >
                  Reveal
                </Button>
              )}
            </div>
          </>
        )}
      </div>
      <div className="tln-actions">
        {confirmation}
        {directions}
      </div>
    </Card>
  );
}

function InTheAir(props: { moment: Moment; onInspect(fileId: string): void }) {
  const flying = props.moment.flying;
  const view = props.moment.trip!;
  if (!flying?.leg.arr) {
    return null;
  }
  const { leg, progress } = flying;
  const lands = leg.arr!.code ? (view.cities[leg.arr!.code] ?? leg.to) : leg.to;
  return (
    <Card
      title="In the air"
      aside={
        <button type="button" className="tln-link" onClick={() => props.onInspect(leg.fileId)}>
          {named(leg)}
        </button>
      }
    >
      <Board from={leg.from} to={leg.to} dep={leg.dep?.time} arr={leg.arr!.time} number={leg.designator} plusDays={plusDays(leg)} progress={progress} />
      <div className="tln-prog">
        <div className="tln-prog-fill" style={{ width: `${Math.round(progress * 100)}%` }} />
      </div>
      <div className="tln-muted">
        Lands {leg.arr!.time ? `${leg.arr!.time} ` : ""}
        {lands} time · in <Until at={leg.arr!.at} />
      </div>
      <div className="tln-faint">Works offline. Everything on this screen is on this device.</div>
    </Card>
  );
}

function FlightHome(props: { moment: Moment; onInspect(fileId: string): void }) {
  const leg = props.moment.next;
  if (!leg?.dep) {
    return null;
  }
  const leave = props.moment.leaveBy;
  const opens = props.moment.checkInOpens;
  return (
    <Card title={`${modeWord(leg)} home`} aside={dayLabel(leg.dep.day)}>
      <Board from={leg.from} to={leg.to} dep={leg.dep.time} arr={leg.arr?.time} number={leg.designator} plusDays={plusDays(leg)} />
      <div className="tln-kv tln-kv-gap">
        {leave && (
          <>
            <span>Leave by</span>
            <div>
              {zonedTime(leave.at, leave.zone)} · {leave.hours} hours before departure
            </div>
          </>
        )}
        {opens !== undefined && (
          <>
            <span>Check-in</span>
            <div>
              opens {weekday(zonedDay(opens, leg.dep.zone))} {zonedTime(opens, leg.dep.zone)}
            </div>
          </>
        )}
      </div>
      <div className="tln-actions">
        <Button size="xs" variant="secondary" onClick={() => props.onInspect(leg.fileId)}>
          Open booking
        </Button>
      </div>
    </Card>
  );
}

function DestinationDay(props: {
  title: string;
  day: string;
  /** The word for a row with no printed time. */
  when: "today" | "tomorrow";
  rows: readonly AgendaRow[];
  now: number;
  onInspect(fileId: string): void;
}) {
  const rows = props.rows.filter((row) => row.day === props.day && row.kind !== "photos" && row.kind !== "trip");
  if (rows.length === 0) {
    return null;
  }
  return (
    <Card title={props.title}>
      <div className="tln-tlist">
        {rows.map((row) => (
          <button key={row.id} type="button" className={`tln-trow${row.past ? " tln-done" : ""}`} onClick={() => props.onInspect(row.fileIds[0]!)}>
            <span className="tln-mono">{row.time ?? ""}</span>
            <span>
              {row.title}
              {row.amount && <span className="tln-faint"> {money(row.amount)}</span>}
            </span>
            {/* A countdown only to a confirmed, printed time: nothing else is a real instant. */}
            {row.past ? (
              <span className="tln-faint">done</span>
            ) : row.ask ? (
              <span className="tln-faint">not confirmed</span>
            ) : !row.time ? (
              <span className="tln-soon">{props.when}</span>
            ) : row.at > props.now ? (
              <span className="tln-soon">
                in <Until at={row.at} />
              </span>
            ) : (
              <span className="tln-soon">now</span>
            )}
          </button>
        ))}
      </div>
    </Card>
  );
}

/** The cards for where the trip stands. */
export function TripCards(props: TripCardProps) {
  const view = props.moment.trip;
  if (!view) {
    return null;
  }
  const checks = () => tripChecks(windowOf(view), [...props.files], props.now);
  const spent = (title: string) => <Spend key="spend" view={view} rows={props.rows} title={title} onToast={props.onToast} onInspect={props.onInspect} />;
  const next = <ComingUp key="coming" rows={comingUp(props.rows, view, props.now, 2)} onInspect={props.onInspect} />;
  switch (props.moment.kind) {
    case "planning":
      return (
        <>
          <TheTrip view={view} onInspect={props.onInspect} />
          <Checks title="Checks" checks={checks()} onInspect={props.onInspect} />
          {spent("Spent so far")}
          {next}
        </>
      );
    case "home":
      return (
        <>
          <WelcomeBack view={view} {...(props.onOpenTrip ? { onOpenTrip: props.onOpenTrip } : {})} />
          <Photos view={view} rows={props.rows} onOpen={props.onOpen} {...(props.fileOf ? { fileOf: props.fileOf } : {})} />
          {spent("Spent on this trip")}
          {next}
        </>
      );
    case "soon":
      return (
        <>
          <CheckIn moment={props.moment} now={props.now} onInspect={props.onInspect} />
          <BoardingPass leg={props.moment.next} now={props.now} onOpen={props.onOpen} />
          <Checks title="Ready for this trip" checks={checks()} onInspect={props.onInspect} />
          <TheTrip view={view} onInspect={props.onInspect} />
        </>
      );
    case "travel":
      return (
        <>
          <LeaveBy moment={props.moment} now={props.now} onInspect={props.onInspect} />
          <BoardingPass leg={props.moment.next} now={props.now} onOpen={props.onOpen} />
          <Hotel mode="land" moment={props.moment} files={props.files} now={props.now} onInspect={props.onInspect} />
        </>
      );
    case "air": {
      // On the way out, the landing and the destination's tomorrow; on the way home, the flight alone.
      const flying = props.moment.flying?.leg;
      const arrival = journeyOf(view).arrival;
      const outward = flying !== undefined && arrival?.arr !== undefined && flying.dep !== undefined && flying.dep.at < arrival.arr.at;
      return (
        <>
          <InTheAir moment={props.moment} onInspect={props.onInspect} />
          {outward && (
            <>
              <Hotel mode="land" moment={props.moment} files={props.files} now={props.now} onInspect={props.onInspect} />
              <DestinationDay
                title={`Tomorrow in ${view.city}`}
                day={nextDay(zonedDay(props.now, view.zone))}
                when="tomorrow"
                rows={props.rows}
                now={props.now}
                onInspect={props.onInspect}
              />
            </>
          )}
        </>
      );
    }
    case "staying": {
      const today = zonedDay(props.now, view.zone);
      return (
        <>
          <Hotel mode="stay" moment={props.moment} files={props.files} now={props.now} onInspect={props.onInspect} />
          <DestinationDay title={`Today · ${dayLabel(today)}`} day={today} when="today" rows={props.rows} now={props.now} onInspect={props.onInspect} />
          <FlightHome moment={props.moment} onInspect={props.onInspect} />
          {spent("Spent so far")}
        </>
      );
    }
    case "last":
      return (
        <>
          <Hotel mode="out" moment={props.moment} files={props.files} now={props.now} onInspect={props.onInspect} />
          <LeaveBy moment={props.moment} now={props.now} onInspect={props.onInspect} />
          <BoardingPass leg={props.moment.next} now={props.now} onOpen={props.onOpen} />
          {spent("Spent on this trip")}
        </>
      );
    default:
      return null;
  }
}
