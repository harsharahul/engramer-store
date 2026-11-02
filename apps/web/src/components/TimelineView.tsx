/**
 * The Timeline place: the hero on the left, and on the right the list or
 * the Month view under one view bar. Everything it shows comes from the
 * Timeline's rows, worked out once here and read by both columns.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { homeCityGuess, tripsOf } from "../intel/agenda";
import { localDay, rowsOf, type AgendaRow } from "../intel/agendarows";
import { everydayOf } from "../intel/everyday";
import { momentOf } from "../intel/moments";
import { assembleTripsEnabled } from "../intel/trips";
import { useStore, type FileEntry } from "../store";
import { homeCity } from "../timelineprefs";
import { useSyncedSetting } from "../usesyncedsetting";
import { CalendarView } from "./CalendarView";
import { TimelineHero } from "./TimelineHero";
import { TimelineList, type TimelineFilter } from "./TimelineList";
import { useFindConnections } from "./useFindConnections";
import { useTripPlans } from "./useTripPlans";
import { useTripView, useTripViews } from "./useTripViews";
import { Button } from "./ui/button";

const FILTERS: { key: TimelineFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "trips", label: "Trips" },
  { key: "bills", label: "Bills" },
  { key: "dates", label: "Dates" },
];
/** Structure (the now line, what is past) refreshes this often; clocks tick on their own. */
const MINUTE_MS = 60_000;

/** The city of the device's time zone, the last guess for home. */
function zoneCity(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return zone.split("/").pop()!.replace(/_/g, " ");
  } catch {
    return "Home";
  }
}

export function TimelineView(props: {
  files: FileEntry[];
  factsOn: boolean;
  /** A day, now, or a trip's page asked for from elsewhere; a new nonce asks again. */
  focus?: { day?: string; now?: boolean; trip?: string; nonce: number };
  onInspect(fileId: string): void;
  onOpen(fileId: string): void;
  onToast(text: string): void;
  onTurnOnDates(): void;
  /** Opens a trip's page; the list stays where it is behind it. */
  onOpenTrip?(tag: string): void;
  /** Closes the trip's page. */
  onCloseTrip?(): void;
  /** The file open in the details pane, marked on the list. */
  selectedFileId?: string;
}) {
  const storeFiles = useStore((s) => s.files);
  const scroller = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), MINUTE_MS);
    return () => clearInterval(timer);
  }, []);
  const today = localDay(now);
  const [mode, setMode] = useState<"timeline" | "month">("timeline");
  const [filter, setFilter] = useState<TimelineFilter>("all");
  const [month, setMonth] = useState(() => ({ y: Number(today.slice(0, 4)), m: Number(today.slice(5, 7)) - 1 }));
  const [scrollTo, setScrollTo] = useState<{ day?: string; now?: boolean; nonce: number }>({ now: true, nonce: 0 });
  const go = (target: { day?: string; now?: boolean }) => {
    setMode("timeline");
    // A day asked for shows everything on it, whatever the filter was.
    if (target.day) {
      setFilter("all");
    }
    setScrollTo((held) => ({ ...target, nonce: held.nonce + 1 }));
  };

  // A request from elsewhere: Go to now, or a date opened from Notices. A
  // trip's page opens over the list and leaves it where it was.
  useEffect(() => {
    if (props.focus && !props.focus.trip) {
      go(props.focus);
    }
    // Only a new request moves the view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.focus?.nonce]);

  const connections = useFindConnections(props.files);
  const { plans, dismissed, excluded } = useTripPlans(connections.linked);
  const assembling = assembleTripsEnabled();
  const [rows, setRows] = useState<AgendaRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let stale = false;
    void rowsOf(props.files, { plans, dismissed, excluded, assembling }, now).then((next) => {
      if (!stale) {
        setRows(next);
        setLoaded(true);
      }
    });
    return () => {
      stale = true;
    };
  }, [props.files, plans, dismissed, excluded, assembling, now]);

  // Once the rows first arrive, the list opens where it was asked to (a
  // date from Notices), or at now.
  useEffect(() => {
    if (loaded) {
      const asked = props.focus?.day ? { day: props.focus.day } : { now: true };
      setScrollTo((held) => ({ ...asked, nonce: held.nonce + 1 }));
    }
    // Only the first arrival of rows; later requests come through go().
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  const trips = useMemo(() => tripsOf(props.files), [props.files]);
  const everyday = useMemo(() => everydayOf(rows, trips, now), [rows, trips, now]);

  const [setHome] = useSyncedSetting(homeCity);
  const [guess, setGuess] = useState<string | undefined>();
  useEffect(() => {
    let stale = false;
    void homeCityGuess(props.files).then((city) => {
      if (!stale) {
        setGuess(city);
      }
    });
    return () => {
      stale = true;
    };
  }, [props.files]);
  const home = setHome ?? guess ?? zoneCity();

  // The hero follows a near trip through its moments; otherwise it is the ordinary day.
  // Rows go in only once read: an empty first list would draw a trip with no legs.
  const views = useTripViews({ ...(loaded ? { rows } : {}), plans, now });
  const moment = useMemo(() => (views ? momentOf(views, now) : undefined), [views, now]);

  // The trip whose page is open, near or far. A trip taken apart meanwhile
  // (here or on another device) closes its page.
  const tripTag = props.focus?.trip;
  const tripView = useTripView(tripTag, { ...(loaded ? { rows } : {}), plans, now });
  useEffect(() => {
    if (tripTag && tripView === null) {
      props.onCloseTrip?.();
    }
    // Only a trip that turns out not to exist closes the page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tripTag, tripView]);

  // The Month view opens at its top, wherever the list was scrolled.
  useEffect(() => {
    if (mode === "month" && scroller.current) {
      scroller.current.scrollTop = 0;
    }
  }, [mode]);

  const turn = (delta: number) =>
    setMonth((held) => {
      const at = new Date(Date.UTC(held.y, held.m + delta, 1));
      return { y: at.getUTCFullYear(), m: at.getUTCMonth() };
    });

  return (
    <div className="tln-view">
      <aside className="tln-side">
        <TimelineHero
          everyday={everyday}
          moment={moment}
          rows={rows}
          files={props.files}
          homeCity={home}
          now={now}
          factsOn={props.factsOn}
          onInspect={props.onInspect}
          onOpen={props.onOpen}
          onToast={props.onToast}
          onTurnOnDates={props.onTurnOnDates}
          {...(props.onOpenTrip ? { onOpenTrip: props.onOpenTrip } : {})}
          fileOf={(id) => storeFiles.get(id)}
        />
      </aside>
      <section className="tln-main">
        <div className="tln-bar">
          <h2>Timeline</h2>
          <div className="tln-seg" role="group" aria-label="View">
            <Button size="xs" variant={mode === "timeline" ? "secondary" : "ghost"} aria-pressed={mode === "timeline"} onClick={() => setMode("timeline")}>
              Timeline
            </Button>
            <Button size="xs" variant={mode === "month" ? "secondary" : "ghost"} aria-pressed={mode === "month"} onClick={() => setMode("month")}>
              Month
            </Button>
          </div>
          {mode === "timeline" ? (
            <div className="tln-filters" role="group" aria-label="Show">
              {FILTERS.map(({ key, label }) => (
                <button key={key} type="button" className={`tln-chipf${filter === key ? " tln-on" : ""}`} aria-pressed={filter === key} onClick={() => setFilter(key)}>
                  {label}
                </button>
              ))}
            </div>
          ) : (
            <div className="tln-filters">
              <Button size="xs" variant="secondary" onClick={() => turn(-1)}>
                Previous
              </Button>
              <Button size="xs" variant="secondary" onClick={() => turn(1)}>
                Next
              </Button>
            </div>
          )}
          <div className="tln-bar-end">
            {connections.canLink && (
              <Button size="xs" variant="ghost" disabled={connections.linking} onClick={() => void connections.find()}>
                {connections.linking ? "Looking…" : "Find connections"}
              </Button>
            )}
            <Button size="xs" onClick={() => go({ now: true })}>
              Now
            </Button>
          </div>
        </div>
        <div ref={scroller} className="tln-scroll">
          {mode === "timeline" ? (
            <TimelineList
              rows={rows}
              trips={trips}
              homeCity={home}
              now={now}
              filter={filter}
              scrollTo={scrollTo}
              onInspect={props.onInspect}
              onOpen={props.onOpen}
              onToast={props.onToast}
              {...(props.onOpenTrip ? { onOpenTrip: props.onOpenTrip } : {})}
              fileOf={(id) => storeFiles.get(id)}
              {...(props.selectedFileId ? { selectedFileId: props.selectedFileId } : {})}
            />
          ) : (
            <CalendarView rows={rows} trips={trips} month={month} today={today} onDay={(iso) => go({ day: iso })} onMonth={turn} />
          )}
        </div>
      </section>
    </div>
  );
}
