/**
 * The trips near now, each read into a trip view: what the Timeline's hero
 * follows and what the bell checks, so the two always speak of the same
 * trip. Only trips within a month ahead or just over are read. Home (for
 * whether a trip leaves the country) is the synced home city, else the
 * library's own guess, the same for every caller.
 */

import { useEffect, useMemo, useState } from "react";
import { homeCityGuess, tripsOf, type TripPlan } from "../intel/agenda";
import { rowsOf, type AgendaRow, type RowFile } from "../intel/agendarows";
import { placeForCity } from "../intel/airports";
import { localDay } from "../intel/instants";
import { BACK_HOME_DAYS, PLANNING_DAYS } from "../intel/moments";
import { assembleTripsEnabled, factsFingerprint } from "../intel/trips";
import type { TripWindow } from "../intel/insights";
import { tripViewOf, windowOf, type TripView } from "../intel/tripview";
import { useStore } from "../store";
import { homeCity } from "../timelineprefs";
import { useSyncedSetting } from "../usesyncedsetting";
import { useTripPlans } from "./useTripPlans";

const DAY_MS = 86_400_000;

// One reading per library, day and home, however many surfaces ask without rows.
let shared: { key: string; views: Promise<TripView[]> } | null = null;

async function readViews(
  live: readonly RowFile[],
  rows: readonly AgendaRow[] | undefined,
  context: { plans: readonly TripPlan[]; dismissed: Set<string>; excluded: Set<string> },
  home: string | undefined,
  now: number,
): Promise<TripView[]> {
  const today = localDay(now);
  const from = localDay(Date.parse(`${today}T12:00:00Z`) - (BACK_HOME_DAYS + 1) * DAY_MS);
  const to = localDay(Date.parse(`${today}T12:00:00Z`) + (PLANNING_DAYS + 1) * DAY_MS);
  const near = tripsOf(live).filter((trip) => trip.start !== undefined && trip.end !== undefined && trip.end >= from && trip.start <= to);
  if (near.length === 0) {
    return [];
  }
  const read =
    rows ??
    (await rowsOf(live, { plans: context.plans, dismissed: context.dismissed, excluded: context.excluded, assembling: assembleTripsEnabled() }, now));
  const city = home ?? (await homeCityGuess(live));
  const homeCountry = city ? (await placeForCity(city))?.country : undefined;
  return Promise.all(
    near.map((trip) => {
      const plan = context.plans.find((candidate) => candidate.tag === trip.tag);
      return tripViewOf(trip, read, { ...(plan ? { plan } : {}), ...(homeCountry ? { homeCountry } : {}) });
    }),
  );
}

/**
 * The near trips' views. A caller that already holds the Timeline's rows
 * and plans passes them; any other surface gets them worked out here.
 */
export function useTripViews(input: { files?: readonly RowFile[]; rows?: readonly AgendaRow[]; plans?: readonly TripPlan[]; now: number }): TripView[] {
  const stored = useStore((s) => s.files);
  const live = useMemo(
    () => (input.files ?? [...(stored?.values() ?? [])]).filter((file) => !file.trashed),
    [input.files, stored],
  );
  const context = useTripPlans();
  const plans = input.plans ?? context.plans;
  const [home] = useSyncedSetting(homeCity);
  const today = localDay(input.now);
  const [views, setViews] = useState<TripView[]>([]);

  useEffect(() => {
    let stale = false;
    const ctx = { plans, dismissed: context.dismissed, excluded: context.excluded };
    let pending: Promise<TripView[]>;
    if (input.rows) {
      pending = readViews(live, input.rows, ctx, home, input.now);
    } else {
      const key = `${factsFingerprint(live)}|${today}|${plans.map((plan) => plan.tag).join(",")}|${home ?? ""}`;
      if (shared?.key !== key) {
        shared = { key, views: readViews(live, undefined, ctx, home, input.now) };
      }
      pending = shared.views;
    }
    void pending.then((read) => {
      if (!stale) {
        setViews(read);
      }
    });
    return () => {
      stale = true;
    };
    // Rows stand for the library and the minute; plans and home for the rest.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, input.rows, plans, home, today]);

  return views;
}

/** The near trips as the checks read them: for the bell, its badge and its notifications. */
export function useTripWindows(now: number, files?: readonly RowFile[]): TripWindow[] {
  const views = useTripViews({ now, ...(files ? { files } : {}) });
  return useMemo(() => views.map(windowOf), [views]);
}
