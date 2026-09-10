import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store";
import { unreadCount } from "../activity";
import { formatDate } from "../format";
import { loadSeen, markSeen, noticeKeys, NOTICES_SEEN_EVENT, noticeEvents, unseenCount } from "../notices";
import { LibraryIntel } from "./FactsPanel";
import { InboxGlyph, XGlyph } from "./Icon";

/**
 * The bell: what the app wants to tell you, in one place, on the Mac and
 * the phone alike. Two sections. Needs attention: dates coming up, what
 * the rules noticed, files stored twice, trips, each opening its file.
 * Activity: the running job with its Stop, then what earlier jobs did,
 * newest first, each dismissable. The badge counts notices and entries
 * not yet seen; a ring shows while a job runs. What the panel displays is
 * the store's own state: the job the pass updates is the job shown, and
 * the notices are computed from the same facts the notifications read.
 */

/** Notices are keyed by the hour so the memo does not churn per render. */
function coarseNow(): number {
  return Math.floor(Date.now() / 3_600_000) * 3_600_000;
}

function useNotices() {
  const files = useStore((s) => s.files);
  const account = useStore((s) => s.session?.email ?? "");
  const keys = useMemo(() => noticeKeys([...files.values()], coarseNow()), [files]);
  const [seenTick, setSeenTick] = useState(0);
  useEffect(() => {
    const bump = () => setSeenTick((n) => n + 1);
    noticeEvents.addEventListener(NOTICES_SEEN_EVENT, bump);
    return () => noticeEvents.removeEventListener(NOTICES_SEEN_EVENT, bump);
  }, []);
  const unseen = useMemo(
    () => (account ? unseenCount(keys, loadSeen(account)) : 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [keys, account, seenTick],
  );
  return { keys, account, unseen };
}

export function ActivityBell(props: { open: boolean; onToggle: () => void }) {
  const job = useStore((s) => s.activity.job);
  const batch = useStore((s) => s.batch);
  const unreadLog = useStore((s) => unreadCount(s.activity.log));
  const { unseen } = useNotices();
  const unread = unreadLog + unseen;
  const busy = job !== null || batch !== null;
  const total = job?.total ?? batch?.total ?? 0;
  const done = job?.done ?? (batch ? batch.done + batch.failed : 0);
  const fraction = total > 0 ? Math.min(1, done / total) : 0;
  return (
    <button
      className={`icon-btn activity-bell${props.open ? " active" : ""}${busy ? " busy" : ""}`}
      title={busy ? `${job?.title ?? "Uploading"} · ${done} of ${total}` : "Notices"}
      aria-label="Notices"
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
  onOpen: (fileId: string) => void;
  onOpenProfile: () => void;
}) {
  const activity = useStore((s) => s.activity);
  const batch = useStore((s) => s.batch);
  const batchStop = useStore((s) => s.batchStop);
  const dismiss = useStore((s) => s.dismissActivity);
  const clear = useStore((s) => s.clearActivity);
  const markRead = useStore((s) => s.markActivityRead);
  const files = useStore((s) => s.files);
  const { keys, account } = useNotices();
  const panelRef = useRef<HTMLDivElement>(null);
  const live = useMemo(() => [...files.values()].filter((file) => !file.trashed), [files]);

  // Opening the panel is reading it: the log entries and the notices.
  useEffect(() => {
    markRead();
  }, [markRead, activity.log.length]);
  useEffect(() => {
    if (account) {
      markSeen(account, keys);
    }
  }, [account, keys]);

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
    <div className={`activity-panel${props.sheet ? " sheet" : ""}`} ref={panelRef} role="dialog" aria-label="Notices">
      <header>
        <span className="details-title">Notices</span>
        <button className="icon-btn" title="Close" onClick={props.onClose}>
          <XGlyph size={14} />
        </button>
      </header>
      <section className="activity-notices">
        <div className="activity-section-label">Needs attention</div>
        <LibraryIntel files={live} onOpen={props.onOpen} />
      </section>
      <div className="activity-section-label">Activity</div>
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
