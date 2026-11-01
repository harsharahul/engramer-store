/**
 * The Timeline's two settings, synced with the account: the home city the
 * poster, the sky and the now line speak for, and where the app opens.
 */

import { settingChanged } from "./settingsbus";

const HOME_KEY = "engram-home-city";
const OPEN_KEY = "engram-open-on";
/** Longer than any city name, short enough to never fill a line. */
const HOME_MAX = 80;

export type OpenOn = "timeline" | "files";

/** The city the owner set as home, or undefined to use the guess from their flights. */
export function homeCity(): string | undefined {
  try {
    return localStorage.getItem(HOME_KEY) || undefined;
  } catch {
    return undefined;
  }
}

export function setHomeCity(city: string): void {
  const kept = city.trim().slice(0, HOME_MAX);
  try {
    if (kept) {
      localStorage.setItem(HOME_KEY, kept);
    } else {
      localStorage.removeItem(HOME_KEY);
    }
    settingChanged();
  } catch {
    // Preference persistence is best-effort.
  }
}

/** Where the app opens; the Timeline unless the owner chose Files. */
export function openOn(): OpenOn {
  try {
    return localStorage.getItem(OPEN_KEY) === "files" ? "files" : "timeline";
  } catch {
    return "timeline";
  }
}

/**
 * Whether the app should open on the Timeline: the owner did not choose
 * Files, the library holds something dated, and the owner has not already
 * gone somewhere else this session.
 */
export function shouldOpenOnTimeline(where: OpenOn, hasAgenda: boolean, navigated: boolean): boolean {
  return where === "timeline" && hasAgenda && !navigated;
}

export function setOpenOn(where: OpenOn): void {
  try {
    localStorage.setItem(OPEN_KEY, where);
    settingChanged();
  } catch {
    // Preference persistence is best-effort.
  }
}
