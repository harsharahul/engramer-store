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
import { offeredTrips } from "../intel/agendarows";
import { assembleTripsEnabled } from "../intel/trips";
import { SparkGlyph, XGlyph } from "./Icon";
import { useTripPlans } from "./useTripPlans";
import { Button } from "./ui/button";

/** More than this and the bar stays shut until asked; one is not a queue. */
const COLLAPSE_ABOVE = 1;
const FILES_AT_ONCE = 6;
/** Above this many pending facts, group answers become available. */
const BULK_ABOVE = 8;

interface FileGroup {
  file: FileEntry;
  facts: Fact[];
  /** For a reading another reader disagrees with: that other reading. */
  alternatives: Map<string, Fact>;
}

function groupByFile(files: FileEntry[], now: number): FileGroup[] {
  const byId = new Map(files.map((file) => [file.id, file]));
  const groups: FileGroup[] = [];
  for (const { fileId, fact, alternative } of offeredFacts(files, now)) {
    let group = groups[groups.length - 1];
    if (!group || group.file.id !== fileId) {
      group = { file: byId.get(fileId)!, facts: [], alternatives: new Map() };
      groups.push(group);
    }
    group.facts.push(fact);
    if (alternative) {
      group.alternatives.set(fact.id, alternative);
    }
  }
  return groups;
}

/** A value as the owner reads it: a date in words, an amount with its currency. */
function valueText(fact: Fact): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(fact.value) ? shown(fact.value) : `${fact.unit ?? ""} ${fact.value}`.trim();
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
              <Button
                variant="secondary"
                size="xs"
                disabled={resolving}
                onClick={() => void resolveAll("confirm")}
              >
                Track all {total}
              </Button>
              <Button
                variant="quiet"
                size="xs"
                disabled={resolving}
                onClick={() => void resolveAll("dismiss")}
              >
                Ignore all
              </Button>
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
 * Trips in Files, as one line: the Timeline is where trips are kept or
 * refused, and where a date-only document is added or kept out. This
 * mirror says how many wait and opens the Timeline.
 */
export function TripMirror(props: { onOpenTimeline(): void }) {
  const files = useStore((s) => s.files);
  const { plans, dismissed, excluded } = useTripPlans();
  const { proposals, joins } = offeredTrips(plans, { dismissed, excluded, assembling: assembleTripsEnabled() }, (id) => {
    const file = files.get(id);
    return file && !file.trashed ? file : undefined;
  });
  const total = proposals.length + joins;
  if (total === 0) {
    return null;
  }
  const text =
    total > 1
      ? `${total} trips and documents wait for a yes on the Timeline.`
      : proposals.length === 1
        ? "1 trip waits for a yes on the Timeline."
        : "1 document waits for a yes on the Timeline.";
  return (
    <section className="pending" aria-label="Trips waiting on the Timeline">
      <div className="pending-bulk">
        <span>{text}</span>
        <Button variant="secondary" size="xs" onClick={props.onOpenTimeline}>
          Open Timeline
        </Button>
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
  const { file, facts, alternatives } = props.group;
  const single = facts.length === 1;
  return (
    <div className="pending-card">
      <div className="pending-card-text">
        {single && alternatives.has(facts[0]!.id) ? (
          <>Two readings of this document disagree about {describeFact(facts[0]!).split(",")[0]}. </>
        ) : single ? (
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
          alternative={alternatives.get(fact.id)}
          onConfirm={(value) => props.onConfirm(fact.id, value)}
          onConfirmOther={(other) => props.onConfirm(other.id)}
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
  /** Another reader's reading of the same thing, when the two disagree. */
  alternative?: Fact;
  onConfirm: (value?: string) => void;
  onConfirmOther: (other: Fact) => void;
  onDismiss: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(props.fact.value);
  const other = props.fact.ambiguous ? swappedReading(props.fact.value) : null;
  const alternative = props.alternative;

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
          <Button
            size="xs"
            disabled={!/^\d{4}-\d{2}-\d{2}$/.test(draft)}
            onClick={() => props.onConfirm(draft)}
          >
            Track {/^\d{4}-\d{2}-\d{2}$/.test(draft) ? shown(draft) : "it"}
          </Button>
          <Button variant="quiet" size="xs" onClick={() => setEditing(false)}>
            Cancel
          </Button>
        </>
      ) : alternative ? (
        // Two readers disagree: the owner picks, and that settles both.
        <>
          <span className="pending-ask">Which one?</span>
          <Button variant="secondary" size="xs" onClick={() => props.onConfirm()}>
            {valueText(props.fact)}
          </Button>
          <Button variant="secondary" size="xs" onClick={() => props.onConfirmOther(alternative)}>
            {valueText(alternative)}
          </Button>
        </>
      ) : other ? (
        <>
          <span className="pending-ask">Which one?</span>
          <Button variant="secondary" size="xs" onClick={() => props.onConfirm(props.fact.value)}>
            {shown(props.fact.value)}
          </Button>
          <Button variant="secondary" size="xs" onClick={() => props.onConfirm(other)}>
            {shown(other)}
          </Button>
        </>
      ) : (
        <Button size="xs" onClick={() => props.onConfirm()}>
          Track it
        </Button>
      )}
      {!editing && /^\d{4}-\d{2}-\d{2}$/.test(props.fact.value) && (
        <button
          className="linky quiet"
          onClick={() => setEditing(true)}
          title="The reader got this date wrong"
        >
          Wrong date?
        </button>
      )}
      <Button
        variant="quiet"
        size="xs"
        onClick={props.onDismiss}
        title="Do not ask about this again"
      >
        <XGlyph size={12} /> Ignore
      </Button>
    </div>
  );
}
