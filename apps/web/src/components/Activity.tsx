import { useEffect, useRef } from "react";
import { useStore } from "../store";
import { unreadCount } from "../activity";
import { formatDate } from "../format";
import { InboxGlyph, XGlyph } from "./Icon";

/**
 * The bell: everything the app does in the background, in one place. The
 * button shows a ring while a job runs and a count of entries not yet
 * seen; the panel shows the running job with its Stop, then what earlier
 * jobs did, newest first, each dismissable. What the panel displays is the
 * store's own activity object: the job the pass updates is the job shown.
 */

export function ActivityBell(props: { open: boolean; onToggle: () => void }) {
  const job = useStore((s) => s.activity.job);
  const batch = useStore((s) => s.batch);
  const unread = useStore((s) => unreadCount(s.activity.log));
  const busy = job !== null || batch !== null;
  const total = job?.total ?? batch?.total ?? 0;
  const done = job?.done ?? (batch ? batch.done + batch.failed : 0);
  const fraction = total > 0 ? Math.min(1, done / total) : 0;
  return (
    <button
      className={`icon-btn activity-bell${props.open ? " active" : ""}${busy ? " busy" : ""}`}
      title={busy ? `${job?.title ?? "Uploading"} · ${done} of ${total}` : "Activity"}
      aria-label="Activity"
      aria-expanded={props.open}
      onClick={props.onToggle}
      style={{ "--progress": fraction } as React.CSSProperties}
    >
      <InboxGlyph size={16} />
      {unread > 0 && <span className="activity-badge">{unread > 99 ? "99+" : unread}</span>}
    </button>
  );
}

export function ActivityPanel(props: {
  sheet: boolean;
  onClose: () => void;
  onOpenProfile: () => void;
}) {
  const activity = useStore((s) => s.activity);
  const batch = useStore((s) => s.batch);
  const batchStop = useStore((s) => s.batchStop);
  const dismiss = useStore((s) => s.dismissActivity);
  const clear = useStore((s) => s.clearActivity);
  const markRead = useStore((s) => s.markActivityRead);
  const panelRef = useRef<HTMLDivElement>(null);

  // Opening the panel is reading it.
  useEffect(() => {
    markRead();
  }, [markRead, activity.log.length]);

  // Click outside or Escape closes, the way a popover should.
  useEffect(() => {
    const onDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (
        target &&
        !panelRef.current?.contains(target) &&
        !(target instanceof Element && target.closest(".activity-bell"))
      ) {
        props.onClose();
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        props.onClose();
      }
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [props]);

  const jobs: Array<{
    key: string;
    title: string;
    done: number;
    total: number;
    failed: number;
    current?: string;
    stop?: () => void;
  }> = [];
  if (activity.job) {
    jobs.push({ key: "job", ...activity.job });
  }
  if (batch) {
    jobs.push({
      key: "batch",
      title: "Uploading",
      done: batch.done + batch.failed,
      total: batch.total,
      failed: batch.failed,
      current: batch.current || undefined,
      stop: batchStop ?? undefined,
    });
  }

  return (
    <div className={`activity-panel${props.sheet ? " sheet" : ""}`} ref={panelRef} role="dialog" aria-label="Activity">
      <header>
        <span className="details-title">Activity</span>
        <button className="icon-btn" title="Close" onClick={props.onClose}>
          <XGlyph size={14} />
        </button>
      </header>
      {jobs.length > 0 && (
        <section className="activity-jobs">
          {jobs.map((job) => (
            <div className="activity-job" key={job.key}>
              <div className="activity-job-head">
                <span className="spinner" />
                <b>{job.title}</b>
                <span className="activity-job-count">
                  {job.done} of {job.total}
                  {job.failed > 0 ? ` · ${job.failed} failed` : ""}
                </span>
                {job.stop && (
                  <button className="btn btn-ghost activity-stop" onClick={job.stop}>
                    Stop
                  </button>
                )}
              </div>
              <div className="activity-bar" aria-hidden="true">
                <div style={{ width: `${job.total > 0 ? Math.min(100, (job.done / job.total) * 100) : 0}%` }} />
              </div>
              {job.current && <div className="activity-job-current">{job.current}</div>}
            </div>
          ))}
        </section>
      )}
      <section className="activity-log">
        {activity.log.length === 0 && jobs.length === 0 && (
          <div className="activity-empty">
            Nothing running. Previews, tags, search text and meaning fill in here while the app
            is open;{" "}
            <button className="link" onClick={props.onOpenProfile}>
              see what is left
            </button>
            .
          </div>
        )}
        {activity.log.map((entry) => (
          <div className={`activity-entry${entry.unread ? " unread" : ""}`} key={entry.id}>
            <div className="activity-entry-main">
              <div className="activity-entry-title">{entry.title}</div>
              {entry.detail && <div className="activity-entry-detail">{entry.detail}</div>}
              <div className="activity-entry-when">{formatDate(entry.at)}</div>
            </div>
            <button className="icon-btn" title="Dismiss" aria-label="Dismiss" onClick={() => dismiss(entry.id)}>
              <XGlyph size={12} />
            </button>
          </div>
        ))}
        {activity.log.length > 1 && (
          <button className="btn btn-ghost activity-clear" onClick={clear}>
            Clear all
          </button>
        )}
      </section>
    </div>
  );
}
