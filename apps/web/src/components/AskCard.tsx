import { SparkGlyph } from "./Icon";

/**
 * The answer card above the search results when the query is a question
 * and the on-device assistant is here. It never replaces the results
 * below: the files search found stay where they are, and the answer is
 * one more thing to read, with the files it came from listed under it.
 * Nothing shown here is stored anywhere.
 */

export type AskStatus =
  | { kind: "offer" }
  | { kind: "running"; answer: string; sources: AskSourceRow[] }
  | { kind: "done"; answer: string; sources: AskSourceRow[] }
  | { kind: "empty" }
  | { kind: "error"; message: string };

export interface AskSourceRow {
  id: string;
  name: string;
}

export function AskCard(props: {
  question: string;
  status: AskStatus;
  onAsk: () => void;
  onStop: () => void;
  onOpen: (id: string) => void;
}) {
  const { status } = props;
  return (
    <section className="ask-card" aria-live="polite">
      {status.kind === "offer" && (
        <button className="ask-offer" onClick={props.onAsk}>
          <SparkGlyph size={14} />
          <span>
            Ask your files: <b>“{props.question}”</b>
          </span>
          <span className="ask-offer-hint">answered on this device</span>
        </button>
      )}
      {(status.kind === "running" || status.kind === "done") && (
        <div className="ask-answer">
          <div className="ask-answer-head">
            <SparkGlyph size={13} />
            <span>
              {status.kind === "running"
                ? "Reading your files…"
                : status.sources.length > 0
                  ? `From ${status.sources.length} of your files`
                  : "From your files"}
            </span>
            {status.kind === "running" && (
              <button className="btn btn-ghost ask-stop" onClick={props.onStop}>
                Stop
              </button>
            )}
          </div>
          <p className="ask-answer-text">{status.answer || (status.kind === "running" ? "…" : "")}</p>
          {status.sources.length > 0 && (
            <div className="ask-sources">
              {status.sources.map((source) => (
                <button key={source.id} className="ask-source" onClick={() => props.onOpen(source.id)}>
                  {source.name}
                </button>
              ))}
            </div>
          )}
          <div className="ask-note">Answered on this device from the excerpts above; nothing was stored.</div>
        </div>
      )}
      {status.kind === "empty" && <div className="ask-quiet">Nothing in your files mentions that.</div>}
      {status.kind === "error" && <div className="ask-quiet">{status.message}</div>}
    </section>
  );
}
