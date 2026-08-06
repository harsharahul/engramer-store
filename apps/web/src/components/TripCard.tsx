/**
 * A confirmed trip, presented: the itinerary no single document contains.
 *
 * Everything derives at render time from the members' facts, so a corrected
 * date or a removed file reshapes the card on its own. Times read exactly as
 * the documents printed them, local to their places. The one computed line
 * is the airport lead time, and the map is a handoff to the system rather
 * than a routing request from the app: door-to-door timing would need your
 * location sent somewhere, and this feature refuses that on principle.
 */

import { useEffect, useState } from "react";
import type { FileEntry } from "../store";
import {
  assembleItinerary,
  departureAdvice,
  tripTitle,
  type ItineraryLeg,
} from "../intel/trips";
import { factToCalendar } from "../intel/ics";
import { triggerDownload } from "../download";
import { whenLabel } from "../intel/describe";
import { SparkGlyph } from "./Icon";

const PLACE_PREFIX = /^(?:Check-(?:in|out)|Pick-up|Drop-off):\s*/;

export function TripCard(props: {
  tag: string;
  members: FileEntry[];
  onOpen: (id: string) => void;
}) {
  const [legs, setLegs] = useState<ItineraryLeg[]>([]);
  const [advice, setAdvice] = useState<{ factId: string; text: string } | null>(null);
  const fingerprint = props.members.map((file) => `${file.id}:${file.facts.length}`).join("|");
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

  const exportLeg = (leg: ItineraryLeg) => {
    const file = props.members.find((member) => member.id === leg.fileId);
    const fact = file?.facts.find((candidate) => candidate.id === leg.factId);
    if (!file || !fact) {
      return;
    }
    const event = factToCalendar(fact, file.name, Date.now());
    triggerDownload(new Blob([event.ics], { type: "text/calendar" }), event.filename);
  };

  const now = Date.now();
  return (
    <div className="intel-group trip-card">
      <h4>
        <SparkGlyph size={12} /> {tripTitle(props.tag)}
      </h4>
      {legs.map((leg) => {
        const place = PLACE_PREFIX.test(leg.title)
          ? leg.title.replace(PLACE_PREFIX, "")
          : null;
        return (
          <div key={`${leg.fileId}:${leg.factId}`} className="trip-leg">
            <div className="intel-row">
              <button className="intel-row-open" onClick={() => props.onOpen(leg.fileId)}>
                <span className="intel-when">
                  {whenLabel(leg.at, now)}
                  {leg.time ? ` · ${leg.time}` : ""}
                </span>
                <span className="intel-what">{leg.title}</span>
              </button>
              <span className="trip-leg-actions">
                {place && (
                  <a
                    className="linky"
                    href={`https://maps.apple.com/?q=${encodeURIComponent(place)}`}
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
                  onClick={() => exportLeg(leg)}
                >
                  Calendar
                </button>
              </span>
            </div>
            {advice?.factId === leg.factId && <p className="trip-advice">{advice.text}</p>}
          </div>
        );
      })}
    </div>
  );
}
