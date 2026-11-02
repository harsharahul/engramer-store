/**
 * A trip's cards under its poster, one set per moment. Every value comes from
 * the trip view, its checks and the Timeline's rows, and every line opens
 * the file it came from.
 */

import { useEffect, useState } from "react";
import { dayLabel, durationLabel, money } from "../intel/everyday";
import type { AgendaRow } from "../intel/agendarows";
import type { FactEvidence } from "../intel/facts";
import { tripChecks, type Check, type FactfulFile } from "../intel/insights";
import { zonedDay, zonedTime } from "../intel/instants";
import type { Leg } from "../intel/legs";
import { rangeLabel, type Moment } from "../intel/moments";
import { comingUp, tripSpend, windowOf, type Stay, type TripView } from "../intel/tripview";
import { useStore, type FileEntry } from "../store";
import { Until } from "./Clock";
import { Amounts, Card } from "./TimelineCard";
import { Board, Tile } from "./TimelineList";
import { Button } from "./ui/button";

const HOUR_MS = 3_600_000;
/** How near a departure the boarding pass, or the wait for it, shows. */
const PASS_HOURS = 48;

/** A file's evidence blob, read once when asked for. */
function useEvidence(fileId: string | undefined): FactEvidence[] | null {
  const factEvidence = useStore((s) => s.factEvidence);
  const [evidence, setEvidence] = useState<FactEvidence[] | null>(null);
  useEffect(() => {
    let stale = false;
    setEvidence(null);
    if (fileId) {
      void factEvidence(fileId).then((read) => {
        if (!stale) {
          setEvidence(read);
        }
      });
    }
    return () => {
      stale = true;
    };
  }, [fileId, factEvidence]);
  return evidence;
}

const nextDay = (iso: string) => new Date(Date.parse(`${iso}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
const mapsUrl = (place: string) => `https://maps.apple.com/?q=${encodeURIComponent(place)}`;

/** The leg that lands at the trip's destination. */
function landingOf(view: TripView): Leg | undefined {
  return view.legs.find((leg) => leg.arr && leg.arr.code !== undefined && leg.arr.code === view.code) ?? view.legs.find((leg) => leg.arr);
}

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
  fileOf?(id: string): FileEntry | undefined;
}

function TheTrip(props: { view: TripView; onInspect(fileId: string): void }) {
  const { view } = props;
  const out = view.legs.find((leg) => leg.dep);
  const back = view.legs.length > 1 ? view.legs.at(-1) : undefined;
  const flights = [
    out?.dep?.time ? `${named(out)} out ${weekday(out.dep.day)} ${out.dep.time}` : "",
    back?.dep?.time ? `${named(back)} home ${weekday(back.dep.day)} ${back.dep.time}` : "",
  ].filter(Boolean);
  const stays = view.stays.filter((stay) => stay.nights > 0).map((stay) => `${stay.name || "Stay"} · ${count(stay.nights, "night")}`);
  const booked = view.booked.map((row) => row.title);
  const bookedLine =
    booked.length > BOOKED_SHOWN ? `${booked.slice(0, BOOKED_SHOWN).join(", ")} and ${booked.length - BOOKED_SHOWN} more` : booked.join(", ");
  return (
    <Card title="The trip">
      <div className="tln-title">
        {view.city} · {rangeLabel(view.start, view.end, false)}
      </div>
      <div className="tln-kv tln-kv-gap">
        {flights.length > 0 && (
          <>
            <span>Flights</span>
            <div>{flights.join(" · ")}</div>
          </>
        )}
        {stays.length > 0 && (
          <>
            <span>Stay</span>
            <div>{stays.join(", ")}</div>
          </>
        )}
        {booked.length > 0 && (
          <>
            <span>Booked</span>
            <div>{bookedLine}</div>
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
    </Card>
  );
}

function Spend(props: { view: TripView; rows: readonly AgendaRow[]; title: string; onToast(text: string): void }) {
  const addToTrip = useStore((s) => s.addToTrip);
  const spend = tripSpend(props.view, props.rows);
  const waiting = spend.waiting;
  return (
    <Card title={props.title}>
      <Amounts sums={spend.sums} />
      <div className="tln-faint">
        Read from {spend.count} {spend.count === 1 ? "receipt or booking" : "receipts and bookings"} · never converted
      </div>
      {waiting && (
        <div className="tln-suggest">
          <span>
            1 receipt waits: {waiting.title}
            {waiting.amount ? ` ${money(waiting.amount)}` : ""}
          </span>
          <Button
            size="xs"
            onClick={() => {
              void addToTrip(waiting.fileIds, props.view.tag);
              props.onToast(`Added to ${props.view.city}. The trip total is updated.`);
            }}
          >
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

function WelcomeBack(props: { view: TripView }) {
  const { view } = props;
  const stats: [number, string][] = [
    [dayNumber(view.end) - dayNumber(view.start) + 1, "day"],
    [view.legs.length, "flight"],
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
  const evidence = useEvidence(leg?.fileId);
  if (!leg?.dep || props.moment.checkInOpens === undefined) {
    return null;
  }
  const opens = props.moment.checkInOpens;
  const opensAt = `${zonedTime(opens, leg.dep.zone)}`;
  const opensOn = dayLabel(zonedDay(opens, leg.dep.zone));
  const open = props.now >= opens;
  const link = evidence?.find((entry) => entry.id === leg.dep!.factId)?.link;
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

function LeaveBy(props: { moment: Moment }) {
  const leave = props.moment.leaveBy;
  if (!leave) {
    return null;
  }
  return (
    <Card title={`Leave for ${leave.code} by`}>
      <div className="tln-big-local">{zonedTime(leave.at, leave.zone)}</div>
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
  const directions = stay ? (
    <Button size="xs" variant="secondary" nativeButton={false} render={<a href={mapsUrl(stay.address ?? `${stay.name}, ${view.city}`)} target="_blank" rel="noreferrer" />}>
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
    if (!stay || !out?.time) {
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

function InTheAir(props: { moment: Moment }) {
  const flying = props.moment.flying;
  const view = props.moment.trip!;
  if (!flying?.leg.arr) {
    return null;
  }
  const { leg, progress } = flying;
  const lands = leg.arr!.code ? (view.cities[leg.arr!.code] ?? leg.to) : leg.to;
  return (
    <Card title="In the air" aside={named(leg)}>
      <Board from={leg.from} to={leg.to} dep={leg.dep?.time} arr={leg.arr!.time} number={leg.designator} plusDays={0} progress={progress} />
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
    <Card title="Flight home" aside={dayLabel(leg.dep.day)}>
      <Board from={leg.from} to={leg.to} dep={leg.dep.time} arr={leg.arr?.time} number={leg.designator} plusDays={0} />
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

function DestinationDay(props: { title: string; day: string; rows: readonly AgendaRow[]; now: number; onInspect(fileId: string): void }) {
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
            {row.past ? (
              <span className="tln-faint">done</span>
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
  const spent = (title: string) => <Spend key="spend" view={view} rows={props.rows} title={title} onToast={props.onToast} />;
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
          <WelcomeBack view={view} />
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
          <LeaveBy moment={props.moment} />
          <BoardingPass leg={props.moment.next} now={props.now} onOpen={props.onOpen} />
          <Hotel mode="land" moment={props.moment} files={props.files} onInspect={props.onInspect} />
        </>
      );
    case "air":
      return (
        <>
          <InTheAir moment={props.moment} />
          <Hotel mode="land" moment={props.moment} files={props.files} onInspect={props.onInspect} />
          <DestinationDay
            title={`Tomorrow in ${view.city}`}
            day={nextDay(zonedDay(props.now, view.zone))}
            rows={props.rows}
            now={props.now}
            onInspect={props.onInspect}
          />
        </>
      );
    case "staying": {
      const today = zonedDay(props.now, view.zone);
      return (
        <>
          <Hotel mode="stay" moment={props.moment} files={props.files} onInspect={props.onInspect} />
          <DestinationDay title={`Today · ${dayLabel(today)}`} day={today} rows={props.rows} now={props.now} onInspect={props.onInspect} />
          <FlightHome moment={props.moment} onInspect={props.onInspect} />
          {spent("Spent so far")}
        </>
      );
    }
    case "last":
      return (
        <>
          <Hotel mode="out" moment={props.moment} files={props.files} onInspect={props.onInspect} />
          <LeaveBy moment={props.moment} />
          <BoardingPass leg={props.moment.next} now={props.now} onOpen={props.onOpen} />
          {spent("Spent on this trip")}
        </>
      );
    default:
      return null;
  }
}
