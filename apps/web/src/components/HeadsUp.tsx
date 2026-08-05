/**
 * What the library has to say, above the files.
 *
 * Four things, each hidden when it has nothing, and the whole strip gone when
 * all four are empty. A panel that is always present but usually says nothing
 * teaches people to stop reading it, which costs more than it gives.
 *
 * The order is deliberate: what is waiting on a decision comes first, because
 * nothing else here can act until those are answered, and leaving them buried
 * would let the rest of the feature sit silently doing nothing.
 */

import { useMemo, useState } from "react";
import type { FileEntry } from "../store";
import type { Fact } from "../intel/facts";
import { daysUntil, swappedReading } from "../intel/dates";
import { insightsFor, type Insight } from "../intel/insights";
import { duplicatesByDigest } from "../intel/duplicates";
import { ClockGlyph, CopyGlyph, InfoGlyph, SparkGlyph, XGlyph } from "./Icon";

const DOCUMENT_LABELS: Record<string, string> = {
  passport: "passport",
  "drivers-license": "driver's licence",
  "id-card": "identity card",
  visa: "visa",
  "residence-permit": "residence permit",
  insurance: "insurance policy",
  warranty: "warranty",
  membership: "membership",
  "vehicle-registration": "vehicle registration",
  certification: "certificate",
  invoice: "invoice",
  "boarding-pass": "boarding pass",
  "hotel-booking": "hotel booking",
  itinerary: "itinerary",
  "car-rental": "car rental",
  "event-ticket": "ticket",
  other: "document",
};

const KIND_VERBS: Record<string, string> = {
  expiry: "expiring",
  due: "due",
  issued: "issued",
  event: "on",
  period: "running to",
};

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** A date as a person writes it, not as a machine stores it. */
function shown(iso: string): string {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!parts) {
    return iso;
  }
  return `${Number(parts[3])} ${MONTHS[Number(parts[2]) - 1]} ${parts[1]}`;
}

/** How far away, in the words someone would use out loud. */
function whenLabel(iso: string, now: number): string {
  const days = daysUntil(iso, now);
  if (days < -1) {
    return `${-days} days ago`;
  }
  if (days === -1) {
    return "yesterday";
  }
  if (days === 0) {
    return "today";
  }
  if (days === 1) {
    return "tomorrow";
  }
  if (days < 45) {
    return `in ${days} days`;
  }
  if (days < 400) {
    return `in ${Math.round(days / 30)} months`;
  }
  return `in ${Math.round(days / 365)} years`;
}

function describe(fact: Fact): string {
  const noun = DOCUMENT_LABELS[fact.document] ?? "document";
  const verb = KIND_VERBS[fact.kind] ?? "dated";
  const at = fact.time ? ` at ${fact.time}` : "";
  return `${noun} ${verb} ${shown(fact.value)}${at}`;
}

/** "an invoice", not "a invoice". Cheap, and its absence is the first thing
 * anyone notices about a sentence a machine wrote. */
function withArticle(phrase: string): string {
  return `${/^[aeiou]/i.test(phrase) ? "an" : "a"} ${phrase}`;
}

interface Waiting {
  file: FileEntry;
  fact: Fact;
}

interface Upcoming {
  file: FileEntry;
  fact: Fact;
  days: number;
}

/** Kinds that describe a moment worth being reminded about. */
const DATED = new Set(["expiry", "due", "event"]);

export function HeadsUp(props: {
  files: FileEntry[];
  onOpen: (fileId: string) => void;
  onConfirm: (fileId: string, factId: string, value?: string) => void;
  onDismiss: (fileId: string, factId: string) => void;
}) {
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const now = Date.now();

  const { waiting, upcoming, insights, duplicates } = useMemo(() => {
    const live = props.files.filter((file) => !file.trashed);
    const waiting: Waiting[] = [];
    const upcoming: Upcoming[] = [];
    for (const file of live) {
      for (const fact of file.facts) {
        if (fact.dismissed || !DATED.has(fact.kind)) {
          continue;
        }
        if (!fact.confirmed) {
          waiting.push({ file, fact });
          continue;
        }
        const days = daysUntil(fact.value, now);
        // A date long past is history, not a reminder. A date far out is not
        // news yet; it still shows under Expiring soon, which is where you go
        // to look rather than be told.
        if (days > -30 && days < 120) {
          upcoming.push({ file, fact, days });
        }
      }
    }
    upcoming.sort((a, b) => a.days - b.days);
    return {
      waiting: waiting.slice(0, 6),
      upcoming: upcoming.slice(0, 6),
      insights: insightsFor(
        live.map((file) => ({ id: file.id, name: file.name, facts: file.facts })),
        now,
      ),
      duplicates: duplicatesByDigest(live),
    };
  }, [props.files, now]);

  const visibleInsights = insights.filter((insight) => !hidden.has(insight.id));
  const nothingToSay =
    waiting.length === 0 &&
    upcoming.length === 0 &&
    visibleInsights.length === 0 &&
    duplicates.length === 0;
  if (nothingToSay) {
    return null;
  }

  const hide = (id: string) => setHidden((prior) => new Set(prior).add(id));

  return (
    <section className="headsup" aria-label="Heads up">
      {waiting.length > 0 && (
        <div className="headsup-group">
          <h4>
            <SparkGlyph size={12} /> Worth a look
          </h4>
          {waiting.map(({ file, fact }) => (
            <ConfirmCard
              key={`${file.id}:${fact.id}`}
              file={file}
              fact={fact}
              onOpen={() => props.onOpen(file.id)}
              onConfirm={(value) => props.onConfirm(file.id, fact.id, value)}
              onDismiss={() => props.onDismiss(file.id, fact.id)}
            />
          ))}
        </div>
      )}

      {upcoming.length > 0 && (
        <div className="headsup-group">
          <h4>
            <ClockGlyph size={12} /> Coming up
          </h4>
          {upcoming.map(({ file, fact, days }) => (
            <button
              key={`${file.id}:${fact.id}`}
              className={`headsup-row${days < 0 ? " overdue" : ""}`}
              onClick={() => props.onOpen(file.id)}
            >
              <span className="headsup-when">{whenLabel(fact.value, now)}</span>
              <span className="headsup-what">
                {describe(fact)}
                {fact.stale && (
                  <em
                    className="headsup-note"
                    title="This file has changed since you confirmed the date, and no longer says it"
                  >
                    file has changed since
                  </em>
                )}
              </span>
              <span className="headsup-file">{file.name}</span>
            </button>
          ))}
        </div>
      )}

      {visibleInsights.length > 0 && (
        <div className="headsup-group">
          <h4>
            <InfoGlyph size={12} /> Noticed
          </h4>
          {visibleInsights.map((insight) => (
            <InsightRow
              key={insight.id}
              insight={insight}
              onOpen={insight.fileId ? () => props.onOpen(insight.fileId!) : undefined}
              onHide={() => hide(insight.id)}
            />
          ))}
        </div>
      )}

      {duplicates.length > 0 && (
        <div className="headsup-group">
          <h4>
            <CopyGlyph size={12} /> Stored twice
          </h4>
          {duplicates.slice(0, 4).map((group) => {
            const names = group.fileIds
              .map((id) => props.files.find((file) => file.id === id)?.name)
              .filter(Boolean);
            return (
              <button
                key={group.digest}
                className="headsup-row"
                onClick={() => props.onOpen(group.fileIds[group.fileIds.length - 1]!)}
              >
                <span className="headsup-when">{group.fileIds.length} copies</span>
                <span className="headsup-what">
                  identical contents, so these are the same file
                </span>
                <span className="headsup-file">{names.join(", ")}</span>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}

/**
 * A fact, and the three answers to it.
 *
 * A date that could be read two ways offers both readings as dates rather than
 * asking anyone to think in formats. That question is the entire reason the
 * ambiguity was carried this far instead of being resolved by a guess.
 */
function ConfirmCard(props: {
  file: FileEntry;
  fact: Fact;
  onOpen: () => void;
  onConfirm: (value?: string) => void;
  onDismiss: () => void;
}) {
  const other = props.fact.ambiguous ? swappedReading(props.fact.value) : null;
  return (
    <div className="headsup-card">
      <div className="headsup-card-text">
        This looks like {withArticle(describe(props.fact))}.{" "}
        <button className="linky" onClick={props.onOpen}>
          {props.file.name}
        </button>
      </div>
      <div className="headsup-card-actions">
        {other ? (
          <>
            <span className="headsup-ask">Which one?</span>
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
        <button className="btn btn-small btn-quiet" onClick={props.onDismiss} title="Do not ask again">
          <XGlyph size={12} /> Ignore
        </button>
      </div>
    </div>
  );
}

function InsightRow(props: {
  insight: Insight;
  onOpen?: () => void;
  onHide: () => void;
}) {
  return (
    <div className={`headsup-insight ${props.insight.severity}`}>
      <p>{props.insight.text}</p>
      <div className="headsup-insight-actions">
        {props.onOpen && (
          <button className="linky" onClick={props.onOpen}>
            Open
          </button>
        )}
        <button className="linky quiet" onClick={props.onHide} title="Hide this">
          Dismiss
        </button>
      </div>
    </div>
  );
}
