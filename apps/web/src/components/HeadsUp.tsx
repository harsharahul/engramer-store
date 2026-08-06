/**
 * Facts waiting on an answer, above the files.
 *
 * This is the only part of the intelligence that sits in the file area, and it
 * earns that position by being temporary: every card here disappears the
 * moment it is answered, so it is a queue that empties rather than a panel
 * that lives there. Everything the library merely knows lives in the details
 * panel instead, where it cannot push anyone's files off the screen.
 *
 * A document is one card, however many dates it mentions, so several
 * candidates present as a question rather than a pile; this is what keeps
 * the paper with five dates honest and the screen calm. At volume, whole
 * groups can be answered at once, one metadata write per file. Collapsed to
 * a single line by default: someone who has just uploaded a folder of
 * documents wants to see the folder.
 */

import { useEffect, useState } from "react";
import type { FileEntry } from "../store";
import { useStore } from "../store";
import type { Fact } from "../intel/facts";
import { offeredFacts } from "../intel/facts";
import { swappedReading } from "../intel/dates";
import { describeFact, shown, withArticle } from "../intel/describe";
import {
  dismissedTrips,
  factsFingerprint,
  rememberTripDismissal,
  suggestTrips,
  tripTag,
  tripTitle,
  type TripSuggestion,
} from "../intel/trips";
import { entitiesEnabled, extractEntities } from "../intel/entities";
import { lookupAirport } from "../intel/airports";
import { PlaneGlyph, SparkGlyph, XGlyph } from "./Icon";

/** More than this and the bar stays shut until asked; one is not a queue. */
const COLLAPSE_ABOVE = 1;
const FILES_AT_ONCE = 6;
/** Above this many pending facts, group answers become available. */
const BULK_ABOVE = 8;

interface FileGroup {
  file: FileEntry;
  facts: Fact[];
}

function groupByFile(files: FileEntry[], now: number): FileGroup[] {
  const byId = new Map(files.map((file) => [file.id, file]));
  const groups: FileGroup[] = [];
  for (const { fileId, fact } of offeredFacts(files, now)) {
    const last = groups[groups.length - 1];
    if (last && last.file.id === fileId) {
      last.facts.push(fact);
    } else {
      groups.push({ file: byId.get(fileId)!, facts: [fact] });
    }
  }
  return groups;
}

export function HeadsUp(props: {
  files: FileEntry[];
  onOpen: (fileId: string) => void;
  onConfirm: (fileId: string, factId: string, value?: string) => void;
  onDismiss: (fileId: string, factId: string) => void;
}) {
  const resolveFacts = useStore((s) => s.resolveFacts);
  const [open, setOpen] = useState(false);
  const [resolving, setResolving] = useState(false);
  const now = Date.now();
  const groups = groupByFile(props.files, now);
  if (groups.length === 0) {
    return null;
  }
  const total = groups.reduce((sum, group) => sum + group.facts.length, 0);
  const collapsed = groups.length > COLLAPSE_ABOVE && !open;

  /** Answers every offered fact the same way, one write per file. */
  const resolveAll = async (how: "confirm" | "dismiss") => {
    setResolving(true);
    try {
      for (const group of groups) {
        await resolveFacts(group.file.id, { [how]: group.facts.map((fact) => fact.id) });
      }
    } finally {
      setResolving(false);
    }
  };

  return (
    <section className="pending" aria-label="Dates worth tracking">
      <button className="pending-summary" onClick={() => setOpen(!open)} aria-expanded={!collapsed}>
        <SparkGlyph size={13} />
        <span>
          {groups.length === 1
            ? `One document has ${total === 1 ? "a date" : "dates"} worth tracking`
            : `${groups.length} documents have dates worth tracking`}
        </span>
        <span className="pending-chevron">{collapsed ? "▾" : "▴"}</span>
      </button>

      {!collapsed && (
        <div className="pending-list">
          {total > BULK_ABOVE && (
            <div className="pending-bulk">
              <span>Answer everything listed at once:</span>
              <button
                className="btn btn-small"
                disabled={resolving}
                onClick={() => void resolveAll("confirm")}
              >
                Track all {total}
              </button>
              <button
                className="btn btn-small btn-quiet"
                disabled={resolving}
                onClick={() => void resolveAll("dismiss")}
              >
                Ignore all
              </button>
            </div>
          )}
          {groups.slice(0, FILES_AT_ONCE).map((group) => (
            <FileCard
              key={group.file.id}
              group={group}
              onOpen={() => props.onOpen(group.file.id)}
              onConfirm={(factId, value) => props.onConfirm(group.file.id, factId, value)}
              onDismiss={(factId) => props.onDismiss(group.file.id, factId)}
            />
          ))}
          {groups.length > FILES_AT_ONCE && (
            <p className="pending-more">
              and {groups.length - FILES_AT_ONCE} more documents, once these are answered
            </p>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * Trips proposed above the files, in the queue's discipline: a card that
 * disappears the moment it is answered. Grouping never happens on its own;
 * the owner ratifies every trip, a confirmation is nothing more than a
 * shared tag on the members, and a refusal is remembered on this device.
 */
export function TripHeadsUp(props: { files: FileEntry[]; onOpen: (fileId: string) => void }) {
  const confirmTrip = useStore((s) => s.confirmTrip);
  const warmSearchIndex = useStore((s) => s.warmSearchIndex);
  const [trips, setTrips] = useState<TripSuggestion[]>([]);
  const [refused, setRefused] = useState<Set<string>>(dismissedTrips);
  const [busy, setBusy] = useState<string | null>(null);
  const [linking, setLinking] = useState(false);
  const [linked, setLinked] = useState<Map<string, Set<string>> | null>(null);
  const live = props.files.filter((file) => !file.trashed);
  // The fingerprint covers answers and values, not just counts: confirming
  // a fact changes no length, and it is precisely the moment clustering is
  // allowed to begin.
  const fingerprint = factsFingerprint(live);
  useEffect(() => {
    let stale = false;
    void suggestTrips(
      live.map((file) => ({ id: file.id, name: file.name, facts: file.facts })),
      Date.now(),
      linked ?? undefined,
    ).then((all) => {
      if (!stale) {
        setTrips(all);
      }
    });
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fingerprint, linked]);

  /**
   * The entity pass, strictly on request. It reads the already-decrypted
   * search text, asks the local extractor for places, and feeds them to the
   * same deterministic clustering; spans are never stored anywhere.
   */
  const findConnections = async () => {
    setLinking(true);
    try {
      await warmSearchIndex();
      const fresh = useStore.getState().files;
      const extra = new Map<string, Set<string>>();
      for (const file of props.files) {
        const entry = fresh.get(file.id);
        const text = entry?.text;
        if (!entry || entry.trashed || !text) {
          continue;
        }
        if (!entry.facts.some((fact) => fact.kind === "event")) {
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
          extra.set(entry.id, places);
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

  const tagsOf = new Map(live.map((file) => [file.id, file.tags]));
  const open = trips.filter(
    (trip) =>
      !refused.has(trip.id) &&
      !trip.fileIds.every((id) => tagsOf.get(id)?.includes(tripTag(trip))),
  );
  const loose = live.filter(
    (file) =>
      file.facts.some((fact) => fact.kind === "event" && !fact.dismissed) &&
      !file.tags.some((tag) => tag.startsWith("trip:")),
  );
  const canLink = entitiesEnabled() && linked === null && loose.length >= 2;
  if (open.length === 0 && !canLink) {
    return null;
  }
  return (
    <section className="pending" aria-label="Trips worth grouping">
      <div className="pending-list">
        {canLink && (
          <div className="pending-bulk">
            <span>Documents that share no reference can still belong together.</span>
            <button
              className="btn btn-small"
              disabled={linking}
              onClick={() => void findConnections()}
            >
              {linking ? "Looking…" : "Find connections"}
            </button>
          </div>
        )}
        {open.map((trip) => (
          <div key={trip.id} className="pending-card">
            <div className="pending-card-text">
              <PlaneGlyph size={13} /> These {trip.fileIds.length} documents look like one trip
              {trip.destination ? ` to ${trip.destination}` : ""}, {shown(trip.start)} to{" "}
              {shown(trip.end)}. Group them?
            </div>
            <div className="trip-files">
              {trip.fileIds.map((id) => (
                <button key={id} className="linky" onClick={() => props.onOpen(id)}>
                  {live.find((file) => file.id === id)?.name ?? id}
                </button>
              ))}
            </div>
            <details className="trip-why">
              <summary>Why these?</summary>
              <ul>
                {trip.why.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </details>
            <div className="pending-card-actions">
              <button
                className="btn btn-small btn-primary"
                disabled={busy === trip.id}
                onClick={() => {
                  setBusy(trip.id);
                  void confirmTrip(trip).finally(() => setBusy(null));
                }}
              >
                Group as {tripTitle(tripTag(trip))}
              </button>
              <button
                className="btn btn-small btn-quiet"
                onClick={() => {
                  rememberTripDismissal(trip.id);
                  setRefused((prior) => new Set(prior).add(trip.id));
                }}
              >
                <XGlyph size={12} /> Ignore
              </button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/** One document, however many dates it mentions. */
function FileCard(props: {
  group: FileGroup;
  onOpen: () => void;
  onConfirm: (factId: string, value?: string) => void;
  onDismiss: (factId: string) => void;
}) {
  const { file, facts } = props.group;
  const single = facts.length === 1;
  return (
    <div className="pending-card">
      <div className="pending-card-text">
        {single ? (
          facts[0]!.kind === "dated" || (facts[0]!.kind === "event" && facts[0]!.label) ? (
            // The system is repeating the document, not interpreting it,
            // and the sentence should sound like that.
            <>The document says {describeFact(facts[0]!)}. </>
          ) : (
            <>This looks like {withArticle(describeFact(facts[0]!))}. </>
          )
        ) : (
          <>This document mentions {facts.length} dates. Which matter? </>
        )}
        <button className="linky" onClick={props.onOpen}>
          {file.name}
        </button>
      </div>
      {facts.map((fact) => (
        <FactRow
          key={fact.id}
          fact={fact}
          named={!single}
          onConfirm={(value) => props.onConfirm(fact.id, value)}
          onDismiss={() => props.onDismiss(fact.id)}
        />
      ))}
    </div>
  );
}

/**
 * One fact and the answers to it. An ambiguous date offers both readings as
 * dates rather than asking anyone to think in formats, and any date can be
 * corrected outright, because the reader being wrong somewhere was always
 * part of the design; the correction is the owner's statement and is stored
 * as such.
 */
function FactRow(props: {
  fact: Fact;
  /** Whether to restate the fact, for cards holding several. */
  named: boolean;
  onConfirm: (value?: string) => void;
  onDismiss: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(props.fact.value);
  const other = props.fact.ambiguous ? swappedReading(props.fact.value) : null;

  return (
    <div className="pending-card-actions">
      {props.named && <span className="pending-fact">{describeFact(props.fact)}</span>}
      {editing ? (
        <>
          <input
            type="date"
            className="pending-date"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <button
            className="btn btn-small btn-primary"
            disabled={!/^\d{4}-\d{2}-\d{2}$/.test(draft)}
            onClick={() => props.onConfirm(draft)}
          >
            Track {/^\d{4}-\d{2}-\d{2}$/.test(draft) ? shown(draft) : "it"}
          </button>
          <button className="btn btn-small btn-quiet" onClick={() => setEditing(false)}>
            Cancel
          </button>
        </>
      ) : other ? (
        <>
          <span className="pending-ask">Which one?</span>
          <button className="btn btn-small" onClick={() => props.onConfirm(props.fact.value)}>
            {shown(props.fact.value)}
          </button>
          <button className="btn btn-small" onClick={() => props.onConfirm(other)}>
            {shown(other)}
          </button>
        </>
      ) : (
        <button className="btn btn-small btn-primary" onClick={() => props.onConfirm()}>
          Track it
        </button>
      )}
      {!editing && (
        <button
          className="linky quiet"
          onClick={() => setEditing(true)}
          title="The reader got this date wrong"
        >
          Wrong date?
        </button>
      )}
      <button
        className="btn btn-small btn-quiet"
        onClick={props.onDismiss}
        title="Do not ask about this again"
      >
        <XGlyph size={12} /> Ignore
      </button>
    </div>
  );
}
