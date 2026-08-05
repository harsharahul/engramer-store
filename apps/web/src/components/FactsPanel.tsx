/**
 * What the details panel says: about one file when a file is selected, and
 * about the library when nothing is.
 *
 * The panel spent most of its life reading "Select a file to inspect it",
 * which is a whole column of the screen saying nothing. Library intelligence
 * belongs there rather than above the files: it is reference material you
 * consult, not a queue you work through, and material like that must never
 * push someone's folders below the fold.
 */

import { useEffect, useState } from "react";
import { useStore, type FileEntry } from "../store";
import type { Fact, FactEvidence } from "../intel/facts";
import { describeFact, shown, sourceLabel, whenLabel } from "../intel/describe";
import { insightsFor, type Insight } from "../intel/insights";
import { duplicatesByDigest } from "../intel/duplicates";
import { daysUntil } from "../intel/dates";
import { ClockGlyph, CopyGlyph, InfoGlyph, XGlyph } from "./Icon";

/** Near enough to be worth saying without being asked. */
const HORIZON_DAYS = 120;
const RECENTLY_PAST_DAYS = 30;

/** ------------------------------------------------------- the whole library */

export function LibraryIntel(props: { files: FileEntry[]; onOpen: (id: string) => void }) {
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const now = Date.now();
  const live = props.files.filter((file) => !file.trashed);

  const insights = insightsFor(
    live.map((file) => ({ id: file.id, name: file.name, facts: file.facts })),
    now,
  ).filter((insight) => !hidden.has(insight.id));

  // A rule that already speaks about a file says it better than a bare date
  // would, so the date is not repeated underneath it. Saying the same thing
  // twice in one column is how a panel starts being ignored.
  const spokenFor = new Set(insights.map((insight) => insight.fileId).filter(Boolean));

  const upcoming = live
    .flatMap((file) =>
      file.facts
        .filter((fact) => fact.confirmed && !fact.dismissed && isDated(fact))
        .map((fact) => ({ file, fact, days: daysUntil(fact.value, now) })),
    )
    .filter(
      (entry) =>
        entry.days > -RECENTLY_PAST_DAYS &&
        entry.days < HORIZON_DAYS &&
        !spokenFor.has(entry.file.id),
    )
    .sort((a, b) => a.days - b.days);

  const duplicates = duplicatesByDigest(live);

  if (upcoming.length === 0 && insights.length === 0 && duplicates.length === 0) {
    return (
      <p className="panel-quiet">
        Nothing needs your attention. Select a file to inspect it.
      </p>
    );
  }

  return (
    <div className="intel">
      {upcoming.length > 0 && (
        <div className="intel-group">
          <h4>
            <ClockGlyph size={12} /> Coming up
          </h4>
          {upcoming.slice(0, 6).map(({ file, fact, days }) => (
            <button
              key={`${file.id}:${fact.id}`}
              className={`intel-row${days < 0 ? " overdue" : ""}`}
              onClick={() => props.onOpen(file.id)}
            >
              <span className="intel-when">{whenLabel(fact.value, now)}</span>
              <span className="intel-what">{describeFact(fact)}</span>
              <span className="intel-file">{file.name}</span>
            </button>
          ))}
        </div>
      )}

      {insights.length > 0 && (
        <div className="intel-group">
          <h4>
            <InfoGlyph size={12} /> Noticed
          </h4>
          {insights.map((insight) => (
            <InsightRow
              key={insight.id}
              insight={insight}
              // Rules say "this" and "the warranty on this", which read fine
              // beside a named row and read as nothing at all on their own.
              // The panel is where they now live, so it has to say which file.
              fileName={live.find((file) => file.id === insight.fileId)?.name}
              onOpen={insight.fileId ? () => props.onOpen(insight.fileId!) : undefined}
              onHide={() => setHidden((prior) => new Set(prior).add(insight.id))}
            />
          ))}
        </div>
      )}

      {duplicates.length > 0 && (
        <div className="intel-group">
          <h4>
            <CopyGlyph size={12} /> Stored twice
          </h4>
          {duplicates.slice(0, 4).map((group) => (
            <button
              key={group.digest}
              className="intel-row"
              onClick={() => props.onOpen(group.fileIds[group.fileIds.length - 1]!)}
            >
              <span className="intel-when">{group.fileIds.length} copies</span>
              <span className="intel-what">identical contents</span>
              <span className="intel-file">
                {group.fileIds
                  .map((id) => props.files.find((f) => f.id === id)?.name)
                  .filter(Boolean)
                  .join(", ")}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function isDated(fact: Fact): boolean {
  return fact.kind === "expiry" || fact.kind === "due" || fact.kind === "event";
}

/**
 * One alert.
 *
 * The headline carries the whole point and the reasoning waits behind it. An
 * alert column is scanned rather than studied, and three paragraphs stacked in
 * a narrow panel is three paragraphs nobody reads. Dismissing is one small
 * control rather than a word, because the row is not a decision to make; it is
 * something you either act on or have already handled.
 */
function InsightRow(props: {
  insight: Insight;
  fileName?: string;
  onOpen?: () => void;
  onHide: () => void;
}) {
  const [why, setWhy] = useState(false);
  return (
    <div className={`alert ${props.insight.severity}`}>
      <button
        className="alert-head"
        onClick={() => setWhy(!why)}
        aria-expanded={why}
        title={why ? "Hide the reasoning" : "Why this is here"}
      >
        <span className="alert-dot" aria-hidden="true" />
        <span className="alert-title">{props.insight.title}</span>
      </button>
      <button className="alert-dismiss" onClick={props.onHide} title="Dismiss">
        <XGlyph size={11} />
      </button>
      {props.fileName && props.onOpen && (
        <button className="alert-file" onClick={props.onOpen} title="Open this file">
          {props.fileName}
        </button>
      )}
      {why && <p className="alert-why">{props.insight.text}</p>}
    </div>
  );
}

/** ------------------------------------------------------------- one file */

/**
 * The facts read out of one file.
 *
 * Each says where it came from, because how much to trust a date depends
 * entirely on whether a check digit stood behind it or a regular expression
 * did. A reference number shows its last four characters and fetches the rest
 * only when asked: the whole value lives in the index blob precisely so it is
 * not in the metadata every device holds all session.
 */
export function FileFacts(props: { file: FileEntry }) {
  const confirmFact = useStore((s) => s.confirmFact);
  const dismissFact = useStore((s) => s.dismissFact);
  const factEvidence = useStore((s) => s.factEvidence);
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [revealing, setRevealing] = useState(false);
  const now = Date.now();

  useEffect(() => {
    setRevealed({});
  }, [props.file.id]);

  const facts = props.file.facts.filter((fact) => !fact.dismissed);
  if (facts.length === 0) {
    return null;
  }

  const reveal = async () => {
    setRevealing(true);
    const evidence: FactEvidence[] = await factEvidence(props.file.id);
    setRevealed(
      Object.fromEntries(
        evidence.filter((e) => e.full).map((e) => [e.id, e.full!]),
      ),
    );
    setRevealing(false);
  };

  const masked = facts.filter((fact) => fact.kind === "identifier");

  return (
    <div className="filefacts">
      <div className="detail-label">Found in this file</div>
      {facts.map((fact) => (
        <div key={fact.id} className="filefact">
          <div className="filefact-main">
            {fact.kind === "identifier" ? (
              <span className="filefact-value mono">
                {revealed[fact.id] ?? `••••${fact.masked ?? fact.value}`}
              </span>
            ) : (
              <span className="filefact-value">
                {shown(fact.value)}
                {fact.time ? ` at ${fact.time}` : ""}
              </span>
            )}
            <span className="filefact-kind">
              {fact.kind === "identifier" ? "reference number" : describeFact(fact)}
            </span>
          </div>
          <div className="filefact-meta">
            <span title={`Confidence ${Math.round(fact.confidence * 100)}%`}>
              {sourceLabel(fact.source)}
            </span>
            {fact.confirmed ? (
              <>
                {isDated(fact) && <span>· {whenLabel(fact.value, now)}</span>}
                {fact.stale && (
                  <span className="filefact-stale" title="The file has changed since you confirmed this">
                    · file changed since
                  </span>
                )}
              </>
            ) : (
              <>
                <button
                  className="linky"
                  onClick={() => void confirmFact(props.file.id, fact.id)}
                >
                  Track it
                </button>
                <button
                  className="linky quiet"
                  onClick={() => void dismissFact(props.file.id, fact.id)}
                >
                  Ignore
                </button>
              </>
            )}
          </div>
        </div>
      ))}
      {masked.length > 0 && Object.keys(revealed).length === 0 && (
        <button className="linky" onClick={() => void reveal()} disabled={revealing}>
          {revealing ? "Fetching…" : "Show reference numbers in full"}
        </button>
      )}
    </div>
  );
}
