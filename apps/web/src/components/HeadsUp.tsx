/**
 * Facts waiting on an answer, above the files.
 *
 * This is the only part of the intelligence that sits in the file area, and it
 * earns that position by being temporary: every card here disappears the
 * moment it is answered, so it is a queue that empties rather than a panel
 * that lives there. Everything the library merely knows lives in the details
 * panel instead, where it cannot push anyone's files off the screen.
 *
 * Collapsed to one line by default once there is more than one. Someone who
 * has just uploaded a folder of documents wants to see the folder.
 */

import { useState } from "react";
import type { FileEntry } from "../store";
import type { Fact } from "../intel/facts";
import { DATED_KINDS } from "../intel/facts";
import { swappedReading } from "../intel/dates";
import { describeFact, shown, withArticle } from "../intel/describe";
import { SparkGlyph, XGlyph } from "./Icon";

/** More than this and the bar stays shut until asked; one is not a queue. */
const COLLAPSE_ABOVE = 1;
const SHOWN_AT_ONCE = 6;

interface Waiting {
  file: FileEntry;
  fact: Fact;
}

export function pendingFacts(files: FileEntry[]): Waiting[] {
  const waiting: Waiting[] = [];
  for (const file of files) {
    if (file.trashed) {
      continue;
    }
    for (const fact of file.facts) {
      if (!fact.dismissed && !fact.confirmed && DATED_KINDS.has(fact.kind)) {
        waiting.push({ file, fact });
      }
    }
  }
  return waiting;
}

export function HeadsUp(props: {
  files: FileEntry[];
  onOpen: (fileId: string) => void;
  onConfirm: (fileId: string, factId: string, value?: string) => void;
  onDismiss: (fileId: string, factId: string) => void;
}) {
  const waiting = pendingFacts(props.files);
  const [open, setOpen] = useState(false);
  if (waiting.length === 0) {
    return null;
  }
  const collapsed = waiting.length > COLLAPSE_ABOVE && !open;

  return (
    <section className="pending" aria-label="Dates worth tracking">
      <button
        className="pending-summary"
        onClick={() => setOpen(!open)}
        aria-expanded={!collapsed}
      >
        <SparkGlyph size={13} />
        <span>
          {waiting.length === 1
            ? "One document has a date worth tracking"
            : `${waiting.length} documents have dates worth tracking`}
        </span>
        <span className="pending-chevron">{collapsed ? "▾" : "▴"}</span>
      </button>

      {!collapsed && (
        <div className="pending-list">
          {waiting.slice(0, SHOWN_AT_ONCE).map(({ file, fact }) => (
            <ConfirmCard
              key={`${file.id}:${fact.id}`}
              file={file}
              fact={fact}
              onOpen={() => props.onOpen(file.id)}
              onConfirm={(value) => props.onConfirm(file.id, fact.id, value)}
              onDismiss={() => props.onDismiss(file.id, fact.id)}
            />
          ))}
          {waiting.length > SHOWN_AT_ONCE && (
            <p className="pending-more">
              and {waiting.length - SHOWN_AT_ONCE} more, once these are answered
            </p>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * A fact, and the answers to it.
 *
 * A date that could be read two ways offers both readings as dates rather than
 * asking anyone to think in formats. That question is the entire reason the
 * ambiguity was carried this far instead of being settled by a guess.
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
    <div className="pending-card">
      <div className="pending-card-text">
        This looks like {withArticle(describeFact(props.fact))}.{" "}
        <button className="linky" onClick={props.onOpen}>
          {props.file.name}
        </button>
      </div>
      <div className="pending-card-actions">
        {other ? (
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
        <button
          className="btn btn-small btn-quiet"
          onClick={props.onDismiss}
          title="Do not ask about this again"
        >
          <XGlyph size={12} /> Ignore
        </button>
      </div>
    </div>
  );
}
