/**
 * The trip's poster on the Timeline: the destination set large, the sky for
 * its sun, and the words of the moment. The words come from posterOf; this
 * only lays them out, with the clock and any countdown ticking in place.
 */

import type { Poster } from "../intel/moments";
import { Clock, Until } from "./Clock";

export function TripPoster(props: { poster: Poster }) {
  const { poster } = props;
  const sky = poster.sky;
  return (
    <div className="tln-poster">
      <div className={`tln-sky tln-sky-${sky}${sky === "night" ? " tln-stars" : ""}`} />
      {poster.code && <div className="tln-wm">{poster.code}</div>}
      <div className="tln-pin">
        <div className="tln-ptop">{poster.top}</div>
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
