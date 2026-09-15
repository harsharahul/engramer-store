/**
 * System notifications for the few notices worth reaching you when the app
 * is not in front: a date approaching or past, something the rules
 * noticed about it. One notification per fact, never repeated; permission
 * asked the first time there is something to say, never at launch; a
 * per-device switch (the permission itself is per device) turns it off.
 * In the Mac and iPhone apps the notification is the system's; in a
 * browser it is the browser's own, which a home-screen app also shows.
 */

import { nativeNotificationPermission, nativeNotify, nativeRequestNotificationPermission } from "./native";
import { loadNotified, markNotified, newDue, type Notice } from "./notices";
import { settingChanged } from "./settingsbus";

const PREF_KEY = "engram-notify";

export type PermissionState = "granted" | "denied" | "prompt";

export interface NotificationTransport {
  permission(): Promise<PermissionState>;
  request(): Promise<PermissionState>;
  send(title: string, body: string): Promise<void>;
}

const nativeTransport: NotificationTransport = {
  permission: nativeNotificationPermission,
  request: nativeRequestNotificationPermission,
  send: nativeNotify,
};

export function notificationsEnabled(): boolean {
  try {
    return localStorage.getItem(PREF_KEY) !== "0";
  } catch {
    return true;
  }
}

export function setNotificationsEnabled(on: boolean): void {
  try {
    localStorage.setItem(PREF_KEY, on ? "1" : "0");
    settingChanged();
  } catch {
    // Best-effort.
  }
}

/** A refusal is remembered for the session: asking twice is nagging. */
let askedThisSession = false;

export function resetNotificationSession(): void {
  askedThisSession = false;
}

/**
 * Sends what is due and not yet said. Returns how many were sent, so a
 * caller can log it; the notified keys are remembered per account.
 */
export async function notifyDue(
  account: string,
  due: readonly Notice[],
  transport: NotificationTransport = nativeTransport,
): Promise<number> {
  if (!notificationsEnabled()) {
    return 0;
  }
  const fresh = newDue(due, loadNotified(account));
  if (fresh.length === 0) {
    return 0;
  }
  let state = await transport.permission();
  if (state === "prompt") {
    if (askedThisSession) {
      return 0;
    }
    askedThisSession = true;
    state = await transport.request();
  }
  if (state !== "granted") {
    return 0;
  }
  let sent = 0;
  for (const notice of fresh) {
    try {
      await transport.send(notice.title, notice.body);
      sent += 1;
    } catch {
      // The system declined this one; it stays unsaid and will be tried
      // again on the next pass, not marked as told.
      continue;
    }
    markNotified(account, [notice.key]);
  }
  return sent;
}
