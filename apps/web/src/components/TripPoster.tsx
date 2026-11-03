/**
 * The trip's poster on the Timeline: the destination set large, the sky for
 * its sun, and the words of the moment. The words come from posterOf; this
 * only lays them out, with the clock and any countdown ticking in place.
 */

import type { KeyboardEvent } from "react";
import type { Poster } from "../intel/moments";
import { Clock, Until } from "./Clock";
import { Button } from "./ui/button";

export function TripPoster(props: {
  poster: Poster;
  /** Opens the trip's page. */
  onOpen?(): void;
  /** On the trip's page: the top line becomes the way back. */
  back?(): void;
}) {
  const { poster, onOpen } = props;
  const sky = poster.sky;
  const opens = onOpen
    ? {
        role: "button",
        tabIndex: 0,
        title: "Open the trip",
        onClick: onOpen,
        onKeyDown: (event: KeyboardEvent) => {
          if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
            event.preventDefault();
            onOpen();
          }
        },
      }
    : {};
  return (
    <div className={`tln-poster${onOpen ? " tln-poster-opens" : ""}`} {...opens}>
      <div className={`tln-sky tln-sky-${sky}${sky === "night" ? " tln-stars" : ""}`} />
      {poster.code && <div className="tln-wm">{poster.code}</div>}
      <div className="tln-pin">
        <div className="tln-ptop">
          {props.back ? (
            <Button size="xs" variant="ghost" className="tln-glassb" onClick={props.back}>
              Back to Timeline
            </Button>
          ) : (
            poster.top
          )}
        </div>
        <div className="tln-pstate">
          <div className="tln-big">{poster.big}</div>
          <div className="tln-cap">
            {poster.until ? (
              <>
                {poster.until.lead} <Until at={poster.until.at} />
              </>
            ) : (
              poster.cap
            )}
          </div>
        </div>
        <div className={`tln-city${poster.city.length > 8 ? " tln-long" : ""}`}>{poster.city}</div>
        <div className="tln-pmeta">
          {poster.lead}
          {poster.clockZone && (
            <>
              {" · "}
              <Clock zone={poster.clockZone} /> {poster.tail}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
