/**
 * The Timeline's hero on an ordinary day: a poster of home (the city, its
 * sky for the hour, the local time, what is left today and this week),
 * then the day's cards, each shown only when it has something to say.
 */

import { useEffect, useState } from "react";
import { localDay } from "../intel/agendarows";
import { airportForCity } from "../intel/airports";
import { dayLabel, money, skyOf, type Everyday, type Money } from "../intel/everyday";
import type { AgendaRow } from "../intel/agendarows";
import { useStore, type FileEntry } from "../store";
import { Clock, Until } from "./Clock";
import { Tile } from "./TimelineList";
import { Button } from "./ui/button";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MEMORY_TILES = 6;

const instantOf = (row: AgendaRow) => new Date(`${row.day}T${row.time ?? "00:00"}:00`).getTime();
const shortDay = (iso: string) => dayLabel(iso).split(" ").slice(0, 2).join(" ");

function Amounts(props: { sums: Money[] }) {
  if (props.sums.length === 0) {
    return <div className="tln-money">none</div>;
  }
  return (
    <div className="tln-money">
      {props.sums.map((sum) => (
        <div key={sum.currency}>
          <small>{sum.currency}</small>
          <b>{money(sum).slice(sum.currency.length + 1)}</b>
        </div>
      ))}
    </div>
  );
}

function Card(props: { title: string; tone?: "yes" | "dashed"; children: React.ReactNode }) {
  return (
    <section className={`tln-card${props.tone ? ` tln-card-${props.tone}` : ""}`}>
      <div className="tln-hd">{props.title}</div>
      {props.children}
    </section>
  );
}

export function TimelineHero(props: {
  everyday: Everyday;
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
  const [place, setPlace] = useState<{ code: string; country?: string } | null>(null);
  useEffect(() => {
    let stale = false;
    void airportForCity(props.homeCity).then((airport) => {
      if (stale || !airport) {
        return;
      }
      let country: string | undefined;
      try {
        country = new Intl.DisplayNames(["en"], { type: "region" }).of(airport.country) ?? undefined;
      } catch {
        country = undefined;
      }
      setPlace({ code: airport.code, ...(country ? { country } : {}) });
    });
    return () => {
      stale = true;
    };
  }, [props.homeCity]);

  const { everyday } = props;
  const at = new Date(props.now);
  const sky = skyOf(at.getHours());
  const today = localDay(props.now);
  const yes = everyday.needsYes;

  return (
    <div className="tln-hero">
      <div className="tln-poster">
        <div className={`tln-sky tln-sky-${sky}${sky === "night" ? " tln-stars" : ""}`} />
        {place && <div className="tln-wm">{place.code}</div>}
        <div className="tln-pin">
          <div className="tln-ptop">Today</div>
          <div className="tln-pstate">
            <div className="tln-big">{WEEKDAYS[at.getDay()]}</div>
            <div className="tln-cap">
              {everyday.laterToday} later today · {everyday.week.length} this week
            </div>
          </div>
          <div className={`tln-city${props.homeCity.length > 8 ? " tln-long" : ""}`}>{props.homeCity}</div>
          <div className="tln-pmeta">
            {place?.country ? `${place.country} · ` : ""}
            {dayLabel(today)} · <Clock /> in {props.homeCity}
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
                        in <Until at={instantOf(row)} />
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
              Read from {everyday.month.receipts} receipts and {everyday.month.bills} bills · never converted
            </div>
          </Card>

          {everyday.nextTrip ? (
            <Card title="Trips">
              <div className="tln-muted">
                {everyday.nextTrip.title} · in {everyday.nextTrip.days} days
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
