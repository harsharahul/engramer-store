import { scheduleBackfill } from "./backfill";
import { handoffEnabled } from "./handoff";
import {
  nativeFilesProviderFeedState,
  nativeFilesProviderSignal,
  nativeListen,
  nativeOutboxDrain,
  type FeedState,
} from "./native";
import { pullSettings } from "./settingsync";
import { useStore } from "./store";

/**
 * Keeps an open vault current without rituals. Sync is a client-driven
 * cursor pull, so a window that just sits there never learns about a
 * newly shared document, a share-sheet upload from the phone, or an
 * edit made on another device. This installs the missing heartbeat: a
 * refresh whenever the window returns to the foreground, and a gentle
 * poll while it stays visible. Each pass first flushes the share
 * sheet's staged uploads (iOS shell only; a no-op elsewhere), so the
 * refresh that follows already sees them. In the desktop shell the
 * server's change feed also lands here: a pushed poke refreshes now,
 * visible or not, instead of waiting for the next poll.
 */

const FOREGROUND_COOLDOWN_MS = 15_000;
const POLL_INTERVAL_MS = 60_000;
/** Waits before the follow-up pulls made when a pull stops short of the
 * sequence a poke announced. Finite by design: a stale announcement is
 * allowed to cost a few empty pulls, never a loop. */
export const RECHECK_DELAYS_MS = [1_000, 3_000, 10_000] as const;

let installed = false;

export function installAutoSync(): void {
  if (installed) {
    return;
  }
  installed = true;
  let lastRun = 0;
  let inFlight = false;
  // A poke that lands mid-refresh is news the running pull may miss;
  // it is remembered and answered once the pull returns, never dropped.
  let pendingPush = false;
  // The highest sequence any poke has announced. A pull that returns
  // short of it read the server before the announced change landed,
  // so the pull is repeated after a growing wait until it catches up
  // or the delays run out.
  let announced = 0;
  let recheckAttempt = 0;
  let recheck: ReturnType<typeof setTimeout> | null = null;

  const scheduleRecheck = () => {
    if (recheck || recheckAttempt >= RECHECK_DELAYS_MS.length) {
      return;
    }
    recheck = setTimeout(() => {
      recheck = null;
      recheckAttempt += 1;
      kick(true);
    }, RECHECK_DELAYS_MS[recheckAttempt]);
  };

  const kick = (pushed = false) => {
    // A pushed poke IS fresh news, so it skips the cooldown; one
    // refresh at a time still holds.
    if (inFlight) {
      if (pushed) {
        pendingPush = true;
      }
      return;
    }
    if (!pushed && Date.now() - lastRun < FOREGROUND_COOLDOWN_MS) {
      return;
    }
    const store = useStore.getState();
    if (!store.session || !store.synced) {
      return;
    }
    inFlight = true;
    void (async () => {
      await nativeOutboxDrain();
      // An empty delta leaves the maps untouched, so a changed reference
      // IS the "something arrived" signal.
      const filesBefore = useStore.getState().files;
      const foldersBefore = useStore.getState().folders;
      await useStore.getState().refresh();
      const after = useStore.getState();
      if (after.session) {
        // The account's settings and decisions ride the same poke: a
        // switch flipped or a notice dismissed on another device lands
        // here with the refresh, not at the next launch.
        await pullSettings(after.session.email, after.session.masterKey).catch(() => {});
      }
      if (
        after.session &&
        (after.files !== filesBefore || after.folders !== foldersBefore) &&
        handoffEnabled(after.session.email)
      ) {
        // The system drive shows the change within this poll cycle
        // instead of whenever Finder or Files next asks on its own.
        // Only where extensions are actually on: a signal also wakes
        // the shell's change-feed holder, which has nothing to hold
        // without the extension record.
        await nativeFilesProviderSignal(after.session.email);
      }
      // Sync may have brought files that arrived without derivatives
      // (Files-app ingest, a deferred backup from the phone); whoever is
      // open picks the work up after the device's own delay.
      scheduleBackfill();
    })()
      .catch(() => {})
      .finally(() => {
        inFlight = false;
        lastRun = Date.now();
        if (pendingPush) {
          // Many pokes during one pull collapse into exactly one more.
          pendingPush = false;
          kick(true);
          return;
        }
        if (useStore.getState().syncSeq >= announced) {
          recheckAttempt = 0;
        } else {
          scheduleRecheck();
        }
      });
  };

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      kick();
    }
  });
  window.addEventListener("focus", () => kick());
  window.setInterval(() => {
    if (document.visibilityState === "visible") {
      kick();
    }
  }, POLL_INTERVAL_MS);
  // Desktop shell only; no-op unsubscribes everywhere else. The feed's
  // state rides its own event so Profile shows the holder as it is;
  // the query covers a window that loaded after the last transition.
  void nativeListen<{ seq?: number }>("vault-changed", (event) => {
    const seq = Number(event?.seq);
    if (Number.isFinite(seq) && seq > announced) {
      // Fresh news restarts the follow-up ladder.
      announced = seq;
      recheckAttempt = 0;
    }
    kick(true);
  });
  void nativeListen<{ state: FeedState }>("vault-feed-state", (event) => {
    useStore.setState({ liveFeed: event.state });
  });
  void nativeFilesProviderFeedState().then((state) => {
    // A transition event that raced ahead of this answer is fresher.
    if (useStore.getState().liveFeed === "off") {
      useStore.setState({ liveFeed: state });
    }
  });
}
