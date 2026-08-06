/**
 * A confirmed trip, presented: the itinerary no single document contains.
 *
 * Everything derives at render time from the members' facts, so a corrected
 * date or a removed file reshapes the card on its own. Legs group into the
 * shapes a traveller recognizes: a flight is one row with both ends, big
 * clocks over small dates over places; a stay or a rental is a short rail
 * of moments. The date is always written out, because "in 7 months" answers
 * how far and never answers when. Times read exactly as the documents
 * printed them, local to their places. The one computed line is the airport
 * lead time, and the map is a handoff to the system rather than a routing
 * request from the app: door-to-door timing would need your location sent
 * somewhere, and this feature refuses that on principle.
 */

import { useEffect, useState } from "react";
import type { FileEntry } from "../store";
import {
  assembleItinerary,
  departureAdvice,
  factsFingerprint,
  tripTitle,
  type ItineraryLeg,
} from "../intel/trips";
import { factToCalendar } from "../intel/ics";
import { triggerDownload } from "../download";
import { whenLabel } from "../intel/describe";
import { BedGlyph, CarGlyph, PlaneGlyph, SparkGlyph, TicketGlyph } from "./Icon";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function shortDay(iso: string): string {
  const at = new Date(`${iso}T00:00:00Z`);
  return `${DAYS[at.getUTCDay()]} ${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]}`;
}

function dayCount(start: string, end: string): number {
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000) + 1;
}

interface End {
  at: string;
  time?: string;
  place?: string;
  factId: string;
  fileId: string;
}

interface Stop {
  what: string;
  at: string;
  time?: string;
  factId: string;
  fileId: string;
  mapPlace?: string;
}

type Seg =
  | { type: "flight"; order: string; designator: string; from?: End; to?: End }
  | { type: "rail"; order: string; mode: "stay" | "car"; place: string; stops: Stop[] }
  | { type: "other"; order: string; leg: ItineraryLeg };

/** Legs folded into traveller-shaped segments, ordered as the trip runs. */
function segmentsOf(legs: ItineraryLeg[]): Seg[] {
  const flights = new Map<string, Extract<Seg, { type: "flight" }>>();
  const rails = new Map<string, Extract<Seg, { type: "rail" }>>();
  const out: Seg[] = [];
  for (const leg of legs) {
    const order = `${leg.at} ${leg.time ?? ""}`;
    if (leg.kind === "flight") {
      const designator = /^Flight\s+([A-Z0-9]{1,3}\s+\S+)/i.exec(leg.title)?.[1] ?? leg.title;
      let seg = flights.get(designator);
      if (!seg) {
        seg = { type: "flight", order, designator };
        flights.set(designator, seg);
        out.push(seg);
      }
      if (order < seg.order) {
        seg.order = order;
      }
      const end = (place?: string): End => ({
        at: leg.at,
        ...(leg.time ? { time: leg.time } : {}),
        ...(place ? { place } : {}),
        factId: leg.factId,
        fileId: leg.fileId,
      });
      const arrives = /\barrives\s+(.+)$/i.exec(leg.title);
      const departs = /\bdeparts\s+(.+)$/i.exec(leg.title);
      const both = /^Flight\s+\S+\s+\S+\s+(.+?)\s+to\s+(.+)$/i.exec(leg.title);
      if (arrives) {
        seg.to = end(arrives[1]);
      } else if (departs) {
        seg.from = end(departs[1]);
      } else if (both) {
        seg.from = end(both[1]);
        seg.to = { ...end(both[2]), time: undefined };
      } else {
        seg.from ??= end();
      }
    } else if (leg.kind === "stay" || leg.kind === "car") {
      const named = /^(Check-(?:in|out)|Pick-up|Drop-off):?\s*(.*)$/i.exec(leg.title);
      const what = named?.[1] ?? leg.title;
      const place = named?.[2]?.trim() ?? "";
      const key = `${leg.kind}:${place || leg.fileId}`;
      let seg = rails.get(key);
      if (!seg) {
        seg = {
          type: "rail",
          order,
          mode: leg.kind,
          place: place || (leg.kind === "car" ? "Rental" : "Stay"),
          stops: [],
        };
        rails.set(key, seg);
        out.push(seg);
      }
      if (order < seg.order) {
        seg.order = order;
      }
      seg.stops.push({
        what,
        at: leg.at,
        ...(leg.time ? { time: leg.time } : {}),
        factId: leg.factId,
        fileId: leg.fileId,
        ...(place ? { mapPlace: place } : {}),
      });
    } else {
      out.push({ type: "other", order, leg });
    }
  }
  return out.sort((a, b) => a.order.localeCompare(b.order));
}

export function TripCard(props: {
  tag: string;
  members: FileEntry[];
  onOpen: (id: string) => void;
}) {
  const [legs, setLegs] = useState<ItineraryLeg[]>([]);
  const [advice, setAdvice] = useState<{ factId: string; text: string } | null>(null);
  const fingerprint = factsFingerprint(props.members);
  useEffect(() => {
    let stale = false;
    const files = props.members.map((file) => ({
      id: file.id,
      name: file.name,
      facts: file.facts,
    }));
    void assembleItinerary(files).then(async (all) => {
      if (stale) {
        return;
      }
      setLegs(all);
      const tip = await departureAdvice(all);
      if (!stale) {
        setAdvice(tip ? { factId: tip.leg.factId, text: tip.text } : null);
      }
    });
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fingerprint]);

  const exportLeg = (factId: string, fileId: string) => {
    const file = props.members.find((member) => member.id === fileId);
    const fact = file?.facts.find((candidate) => candidate.id === factId);
    if (!file || !fact) {
      return;
    }
    const event = factToCalendar(fact, file.name, Date.now());
    triggerDownload(new Blob([event.ics], { type: "text/calendar" }), event.filename);
  };

  const segments = segmentsOf(legs);
  const now = Date.now();
  const start = legs[0]?.at;
  const end = legs[legs.length - 1]?.at;

  const actions = (factId: string, fileId: string, mapPlace?: string) => (
    <span className="trip-leg-actions">
      {mapPlace && (
        <a
          className="linky"
          href={`https://maps.apple.com/?q=${encodeURIComponent(mapPlace)}`}
          target="_blank"
          rel="noreferrer"
          title="Open this place in Maps; the app itself never asks where you are"
        >
          Map
        </a>
      )}
      <button
        className="linky quiet"
        title="Download a calendar event with a reminder built in"
        onClick={() => exportLeg(factId, fileId)}
      >
        Calendar
      </button>
      <button className="linky quiet" title="Open the document" onClick={() => props.onOpen(fileId)}>
        Open
      </button>
    </span>
  );

  return (
    <div className="intel-group trip-card">
      <h4>
        <SparkGlyph size={12} /> {tripTitle(props.tag)}
      </h4>
      {start && end && (
        <p className="trip-range">
          {shortDay(start)} to {shortDay(end)} · {dayCount(start, end)} days · {whenLabel(start, now)}
        </p>
      )}
      {segments.map((seg) => {
        if (seg.type === "flight") {
          const hasAdvice =
            advice && (seg.from?.factId === advice.factId || seg.to?.factId === advice.factId);
          const endView = (end: End | undefined, cap: string, right: boolean) => (
            <div className={`trip-end${right ? " right" : ""}`}>
              {end && (
                <>
                  <span className="trip-cap">{cap}</span>
                  <b className="trip-big">{end.time ?? shortDay(end.at)}</b>
                  {end.time && <span className="trip-sub">{shortDay(end.at)}</span>}
                  {end.place && <span className="trip-sub place">{end.place}</span>}
                </>
              )}
            </div>
          );
          return (
            <div className="trip-seg" key={`f:${seg.designator}`}>
              <span className="trip-eyebrow">
                <PlaneGlyph size={12} /> Flight {seg.designator}
              </span>
              <div className="trip-flight-ends">
                {endView(seg.from, "Departs", false)}
                <span className="trip-flight-line" aria-hidden="true" />
                {endView(seg.to, "Arrives", true)}
              </div>
              {hasAdvice && <p className="trip-advice">{advice.text}</p>}
              {(seg.from ?? seg.to) &&
                actions((seg.from ?? seg.to)!.factId, (seg.from ?? seg.to)!.fileId)}
            </div>
          );
        }
        if (seg.type === "rail") {
          return (
            <div className="trip-seg" key={`r:${seg.place}:${seg.order}`}>
              <span className="trip-eyebrow">
                {seg.mode === "car" ? <CarGlyph size={12} /> : <BedGlyph size={12} />} {seg.place}
              </span>
              <div className="trip-rail">
                {seg.stops.map((stop) => (
                  <div className="trip-stop" key={stop.factId}>
                    <span className="trip-stop-dot" aria-hidden="true" />
                    <div className="trip-stop-main">
                      <b className="trip-big">{shortDay(stop.at)}</b>
                      <span className="trip-cap">
                        {stop.what}
                        {stop.time ? ` · ${stop.time}` : ""}
                      </span>
                    </div>
                    {actions(stop.factId, stop.fileId, stop.mapPlace)}
                  </div>
                ))}
              </div>
            </div>
          );
        }
        return (
          <div className="trip-seg" key={`o:${seg.leg.factId}`}>
            <span className="trip-eyebrow">
              <TicketGlyph size={12} /> Event
            </span>
            <div className="trip-stop-main">
              <b className="trip-big">{shortDay(seg.leg.at)}</b>
              <span className="trip-cap">
                {seg.leg.title}
                {seg.leg.time ? ` · ${seg.leg.time}` : ""}
              </span>
            </div>
            {actions(seg.leg.factId, seg.leg.fileId)}
          </div>
        );
      })}
    </div>
  );
}
