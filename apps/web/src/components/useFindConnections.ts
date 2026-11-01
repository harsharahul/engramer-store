/**
 * "Find connections": the entity pass, strictly on request. It reads the
 * already-decrypted search text of files with an event, asks the local
 * extractor for places, and hands them to trip planning as extra places;
 * nothing it finds is stored anywhere.
 */

import { useState } from "react";
import { lookupAirport } from "../intel/airports";
import { entitiesEnabled, extractEntities } from "../intel/entities";
import { isTripTag } from "../intel/trips";
import { useStore, type FileEntry } from "../store";

export function useFindConnections(files: readonly FileEntry[]) {
  const warmSearchIndex = useStore((s) => s.warmSearchIndex);
  const [linking, setLinking] = useState(false);
  const [linked, setLinked] = useState<Map<string, Set<string>> | null>(null);
  const loose = files.filter(
    (file) => !file.trashed && file.facts.some((fact) => fact.kind === "event" && !fact.dismissed) && !file.tags.some(isTripTag),
  );

  const find = async () => {
    setLinking(true);
    try {
      await warmSearchIndex();
      const fresh = useStore.getState().files;
      const extra = new Map<string, Set<string>>();
      for (const file of loose) {
        const text = fresh.get(file.id)?.text;
        if (!text) {
          continue;
        }
        const spans = await extractEntities(text.slice(0, 2000), ["airport", "city"]);
        const places = new Set<string>();
        for (const span of spans) {
          if (span.label === "airport" && /^[A-Za-z]{3}$/.test(span.text)) {
            const airport = await lookupAirport(span.text);
            if (airport) {
              places.add(airport.city);
            }
          } else if (span.label === "city") {
            places.add(span.text.trim());
          }
        }
        if (places.size > 0) {
          extra.set(file.id, places);
        }
      }
      setLinked(extra);
    } catch {
      // The model may still be downloading, or absent on this deployment;
      // the button stays and a second press tries again.
    } finally {
      setLinking(false);
    }
  };

  return { canLink: entitiesEnabled() && linked === null && loose.length >= 2, linking, linked, find };
}
