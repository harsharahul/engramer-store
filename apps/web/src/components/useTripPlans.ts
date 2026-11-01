/**
 * The library's trip plans and the account's answers about them, shared by
 * every surface that reads them: the Timeline, the details pane and the
 * Files mirror. Plans are worked out once per change to the library, and
 * the answers are read again whenever a decision lands from anywhere.
 */

import { useEffect, useMemo, useState } from "react";
import { decided, DECISIONS_EVENT, decisionEvents } from "../decisions";
import { planTrips, type TripPlan } from "../intel/agenda";
import { factsFingerprint } from "../intel/trips";
import { useStore } from "../store";

export interface TripContext {
  plans: TripPlan[];
  dismissed: Set<string>;
  excluded: Set<string>;
}

// One planning per library state, however many surfaces ask.
let shared: { fingerprint: string; plans: Promise<TripPlan[]> } | null = null;

export function useTripPlans(extraPlaces?: ReadonlyMap<string, ReadonlySet<string>> | null): TripContext {
  const files = useStore((s) => s.files);
  const account = useStore((s) => s.session?.email ?? "");
  const live = useMemo(() => [...files.values()].filter((file) => !file.trashed), [files]);
  const fingerprint = useMemo(() => factsFingerprint(live), [live]);
  const [plans, setPlans] = useState<TripPlan[]>([]);

  useEffect(() => {
    let stale = false;
    let pending: Promise<TripPlan[]>;
    if (extraPlaces) {
      pending = planTrips(live, Date.now(), { extraPlaces });
    } else {
      if (shared?.fingerprint !== fingerprint) {
        shared = { fingerprint, plans: planTrips(live, Date.now()) };
      }
      pending = shared.plans;
    }
    void pending.then((next) => {
      if (!stale) {
        setPlans(next);
      }
    });
    return () => {
      stale = true;
    };
    // The fingerprint stands for the live files.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fingerprint, extraPlaces]);

  const [answers, setAnswers] = useState(() => ({
    dismissed: decided(account, "dismissedTrips"),
    excluded: decided(account, "tripExclusions"),
  }));
  useEffect(() => {
    const reread = () => setAnswers({ dismissed: decided(account, "dismissedTrips"), excluded: decided(account, "tripExclusions") });
    reread();
    decisionEvents.addEventListener(DECISIONS_EVENT, reread);
    return () => decisionEvents.removeEventListener(DECISIONS_EVENT, reread);
  }, [account]);

  return { plans, ...answers };
}
