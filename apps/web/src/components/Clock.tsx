/**
 * Text that keeps time: the clock and countdowns on the Timeline. Each
 * one re-renders only itself, once a second, so a ticking clock never
 * redraws the list around it.
 */

import { useEffect, useState } from "react";
import { localTime } from "../intel/agendarows";
import { durationLabel } from "../intel/everyday";

function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** The device's local time, HH:MM. */
export function Clock() {
  return <span className="tln-tick">{localTime(useNow())}</span>;
}

/** How long until an instant: "1 d 8 h", "10 h 50 m", "4 min". */
export function Until(props: { at: number }) {
  return <span className="tln-tick">{durationLabel(props.at - useNow())}</span>;
}
