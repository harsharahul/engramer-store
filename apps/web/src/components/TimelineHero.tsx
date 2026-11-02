/**
 * The Timeline's hero on an ordinary day: a poster of home (the city, its
 * sky for the hour, the local time, what is left today and this week),
 * then the day's cards, each shown only when it has something to say.
 */

import { useEffect, useState } from "react";
import { localDay, localTime, zonedDay, zonedTime } from "../intel/agendarows";
import { airportForCity } from "../intel/airports";
import { dayLabel, money, skyOf, type Everyday } from "../intel/everyday";
import type { AgendaRow } from "../intel/agendarows";
import { useStore, type FileEntry } from "../store";
import { deviceZone } from "../intel/instants";
import { countryName, posterOf, type Moment } from "../intel/moments";
import { Clock, Until } from "./Clock";
import type { FactfulFile } from "../intel/insights";
import { Amounts, Card } from "./TimelineCard";
import { TripCards } from "./TripCards";
import { TripPoster } from "./TripPoster";
import { Tile } from "./TimelineList";
import { Button } from "./ui/button";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MEMORY_TILES = 6;

/** "1 receipt", "2 receipts". */
const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
/** Countries the poster names by their short form, as people say them. */
function countryOf(code: string): { country?: string } {
  const name = countryName(code);
  return name ? { country: name } : {};
}
const shortDay = (iso: string) => dayLabel(iso).split(" ").slice(0, 2).join(" ");

export function TimelineHero(props: {
  everyday: Everyday;
  /** Where a near trip stands; the ordinary day when absent or "everyday". */
  moment?: Moment;
  rows?: readonly AgendaRow[];
  /** The library, for the trip's checks. */
  files?: readonly FactfulFile[];
  homeCity: string;
  now: number;
  factsOn: boolean;
  onInspect(fileId: string): void;
  onOpen(fileId: string): void;
  onToast(text: string): void;
  onTurnOnDates(): void;
  fileOf?(id: string): FileEntry | undefined;
}) {
  const resolveFacts = useStore((s) => s.resolveFacts);
  const [place, setPlace] = useState<{ code: string; zone: string; country?: string } | null>(null);
  useEffect(() => {
    let stale = false;
    setPlace(null);
    void airportForCity(props.homeCity).then((airport) => {
      if (stale || !airport) {
        return;
      }
      setPlace({ code: airport.code, zone: airport.zone, ...countryOf(airport.country) });
    });
    return () => {
      stale = true;
    };
  }, [props.homeCity]);

  const { everyday } = props;
  // The poster is home: its date, time and sky are home's, even away.
  const home = place?.zone;
  const posterDay = home ? zonedDay(props.now, home) : localDay(props.now);
  const posterHour = Number((home ? zonedTime(props.now, home) : localTime(props.now)).slice(0, 2));
  const sky = skyOf(posterHour);
  const today = localDay(props.now);
  const yes = everyday.needsYes;

  const moment = props.moment;
  if (moment && moment.kind !== "everyday" && moment.trip) {
    const view = moment.trip;
    const photos = (props.rows ?? [])
      .filter((row) => row.kind === "photos" && row.day >= view.start && row.day <= view.end)
      .reduce((sum, row) => sum + row.fileIds.length, 0);
    const poster = posterOf(moment, props.now, home ?? deviceZone(), { photos });
    return (
      <div className="tln-hero">
        {poster && <TripPoster poster={poster} />}
        <TripCards
          moment={moment}
          rows={props.rows ?? []}
          files={props.files ?? []}
          now={props.now}
          onInspect={props.onInspect}
          onOpen={props.onOpen}
          onToast={props.onToast}
          {...(props.fileOf ? { fileOf: props.fileOf } : {})}
        />
      </div>
    );
  }

  return (
    <div className="tln-hero">
      <div className="tln-poster">
        <div className={`tln-sky tln-sky-${sky}${sky === "night" ? " tln-stars" : ""}`} />
        {place && <div className="tln-wm">{place.code}</div>}
        <div className="tln-pin">
          <div className="tln-ptop">Today</div>
          <div className="tln-pstate">
            <div className="tln-big">{WEEKDAYS[new Date(`${posterDay}T00:00:00Z`).getUTCDay()]}</div>
            <div className="tln-cap">
              {everyday.laterToday} later today · {everyday.week.length} this week
            </div>
          </div>
          <div className={`tln-city${props.homeCity.length > 8 ? " tln-long" : ""}`}>{props.homeCity}</div>
          <div className="tln-pmeta">
            {place?.country ? `${place.country} · ` : ""}
            {dayLabel(posterDay)} · <Clock {...(home ? { zone: home } : {})} /> in {props.homeCity}
          </div>
        </div>
      </div>

      {!props.factsOn ? (
        <Card title="Dates" tone="dashed">
          <div className="tln-muted">
            Dates are not read yet. Turn on Read dates in documents to see your bills, bookings and trips here.
          </div>
          <div className="tln-actions">
            <Button size="xs" onClick={props.onTurnOnDates}>
              Turn on
            </Button>
          </div>
        </Card>
      ) : (
        <>
          <Card title={`Today · ${dayLabel(today)}`}>
            {everyday.today.length === 0 ? (
              <div className="tln-muted">Nothing dated today.</div>
            ) : (
              <div className="tln-tlist">
                {everyday.today.map((row) => (
                  <button key={row.id} type="button" className={`tln-trow${row.past ? " tln-done" : ""}`} onClick={() => props.onInspect(row.fileIds[0]!)}>
                    <span className="tln-mono">{row.time ?? ""}</span>
                    <span>
                      {row.title}
                      {row.amount && <span className="tln-faint"> {money(row.amount)}</span>}
                    </span>
                    {row.past ? (
                      <span className="tln-faint">{row.kind === "bill" ? "paid" : "done"}</span>
                    ) : row.time ? (
                      <span className="tln-soon">
                        in <Until at={row.at} />
                      </span>
                    ) : (
                      <span className="tln-soon">today</span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </Card>

          {everyday.week.length > 0 && (
            <Card title="This week">
              <div className="tln-tlist">
                {everyday.week.map((row) => (
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
          )}

          {yes && (
            <Card title="Needs a yes" tone="yes">
              <div className="tln-title">{yes.title}</div>
              <div className="tln-muted">
                {dayLabel(yes.day)}
                {yes.amount ? ` · ${money(yes.amount)}` : ""}
              </div>
              <div className="tln-faint">{yes.sub ? `${yes.sub}. ` : ""}Nothing is tracked until you say yes.</div>
              <div className="tln-actions">
                <Button
                  size="xs"
                  onClick={() => {
                    void resolveFacts(yes.fileIds[0]!, { confirm: yes.factIds ?? [] });
                    props.onToast("Date confirmed. A notice comes a week before.");
                  }}
                >
                  Confirm date
                </Button>
                <Button
                  size="xs"
                  variant="secondary"
                  onClick={() => {
                    void resolveFacts(yes.fileIds[0]!, { dismiss: yes.factIds ?? [] });
                    props.onToast("Dismissed. It will not come back.");
                  }}
                >
                  Not right
                </Button>
              </div>
            </Card>
          )}

          {everyday.onThisDay && (
            <Card title={`On this day · ${everyday.onThisDay.year}`}>
              <div className="tln-title">{everyday.onThisDay.title}</div>
              <div className="tln-muted">
                {everyday.onThisDay.yearsAgo === 1 ? "A year ago today" : `${everyday.onThisDay.yearsAgo} years ago today`}, from your library
              </div>
              <div className="tln-tiles">
                {everyday.onThisDay.fileIds.slice(0, MEMORY_TILES).map((id, index, shown) => (
                  <Tile
                    key={id}
                    file={props.fileOf?.(id)}
                    index={index}
                    more={
                      index === shown.length - 1 && everyday.onThisDay!.fileIds.length > shown.length
                        ? everyday.onThisDay!.fileIds.length - shown.length + 1
                        : undefined
                    }
                    onOpen={() => props.onOpen(id)}
                  />
                ))}
              </div>
              <div className="tln-actions">
                <Button size="xs" variant="secondary" onClick={() => props.onOpen(everyday.onThisDay!.fileIds[0]!)}>
                  Open memory
                </Button>
              </div>
            </Card>
          )}

          <Card title={`${everyday.month.name} so far`}>
            <div className="tln-kv">
              <span>Paid</span>
              <Amounts sums={everyday.month.paid} />
              <span>Still due</span>
              <Amounts sums={everyday.month.due} />
            </div>
            <div className="tln-faint">
              Read from {count(everyday.month.receipts, "receipt")} and {count(everyday.month.bills, "bill")} · never converted
            </div>
          </Card>

          {everyday.nextTrip ? (
            <Card title="Trips">
              <div className="tln-muted">
                {everyday.nextTrip.title} · in {count(everyday.nextTrip.days, "day")}
              </div>
            </Card>
          ) : (
            <Card title="Trips" tone="dashed">
              <div className="tln-muted">No trips planned. When a booking lands in your mail, the trip appears here on its own.</div>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
