/**
 * The trips near now, each read into a trip view: what the Timeline's hero
 * follows and what the bell checks, so the two always speak of the same
 * trip. Only trips within a month ahead or just over are read.
 */

import { useEffect, useMemo, useState } from "react";
import { tripsOf, type TripPlan } from "../intel/agenda";
import { rowsOf, type AgendaRow } from "../intel/agendarows";
import { airportForCity } from "../intel/airports";
import { localDay } from "../intel/instants";
import { BACK_HOME_DAYS, PLANNING_DAYS } from "../intel/moments";
import { assembleTripsEnabled } from "../intel/trips";
import { tripViewOf, type TripView } from "../intel/tripview";
import { useStore } from "../store";
import { useTripPlans } from "./useTripPlans";

const DAY_MS = 86_400_000;

/**
 * The near trips' views. A caller that already holds the Timeline's rows
 * and plans passes them; any other surface gets them worked out here.
 */
export function useTripViews(input: { rows?: readonly AgendaRow[]; plans?: readonly TripPlan[]; homeCity?: string; now: number }): TripView[] {
  const files = useStore((s) => s.files);
  const live = useMemo(() => [...files.values()].filter((file) => !file.trashed), [files]);
  const shared = useTripPlans();
  const plans = input.plans ?? shared.plans;
  const today = localDay(input.now);
  const [views, setViews] = useState<TripView[]>([]);

  useEffect(() => {
    let stale = false;
    void (async () => {
      const from = localDay(Date.parse(`${today}T12:00:00Z`) - (BACK_HOME_DAYS + 1) * DAY_MS);
      const to = localDay(Date.parse(`${today}T12:00:00Z`) + (PLANNING_DAYS + 1) * DAY_MS);
      const near = tripsOf(live).filter((trip) => trip.start !== undefined && trip.end !== undefined && trip.end >= from && trip.start <= to);
      if (near.length === 0) {
        if (!stale) {
          setViews([]);
        }
        return;
      }
      const rows =
        input.rows ??
        (await rowsOf(live, { plans, dismissed: shared.dismissed, excluded: shared.excluded, assembling: assembleTripsEnabled() }, input.now));
      const homeCountry = input.homeCity ? (await airportForCity(input.homeCity))?.country : undefined;
      const read = await Promise.all(
        near.map((trip) =>
          tripViewOf(trip, rows, {
            ...(plans.find((plan) => plan.tag === trip.tag) ? { plan: plans.find((plan) => plan.tag === trip.tag)! } : {}),
            ...(homeCountry ? { homeCountry } : {}),
          }),
        ),
      );
      if (!stale) {
        setViews(read);
      }
    })();
    return () => {
      stale = true;
    };
    // Rows stand for the library and the minute; plans and home for the rest.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, input.rows, plans, input.homeCity, today]);

  return views;
}
