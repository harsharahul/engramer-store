/**
 * A trip's cards under its poster, one set per moment. Every value comes from
 * the trip view, its checks and the Timeline's rows, and every line opens
 * the file it came from.
 */

import { dayLabel, money } from "../intel/everyday";
import type { AgendaRow } from "../intel/agendarows";
import { tripChecks, type Check, type FactfulFile } from "../intel/insights";
import type { Leg } from "../intel/legs";
import { rangeLabel, type Moment } from "../intel/moments";
import { comingUp, tripSpend, windowOf, type TripView } from "../intel/tripview";
import { useStore, type FileEntry } from "../store";
import { Amounts, Card } from "./TimelineCard";
import { Tile } from "./TimelineList";
import { Button } from "./ui/button";

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
            <span>{flights.join(" · ")}</span>
          </>
        )}
        {stays.length > 0 && (
          <>
            <span>Stay</span>
            <span>{stays.join(", ")}</span>
          </>
        )}
        {booked.length > 0 && (
          <>
            <span>Booked</span>
            <span>{bookedLine}</span>
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
    default:
      return null;
  }
}
