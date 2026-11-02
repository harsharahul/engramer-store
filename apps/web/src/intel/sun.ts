/**
 * The sun, worked out on the device: when it rises and sets at a place, and
 * the sky a poster shows for a moment there. No network, no tables: the
 * sunrise equation needs only the date and the coordinates the airport
 * table already carries.
 */

import type { LatLon } from "./airports";
import { zonedDay, zonedTime } from "./instants";

export type Sky = "night" | "dawn" | "day" | "dusk";

const RAD = Math.PI / 180;
const DAY_MS = 86_400_000;
/** Julian day of the Unix epoch, and of J2000.0. */
const UNIX_JD = 2440587.5;
const J2000 = 2451545;
/** Dawn and dusk reach this far either side of sunrise and sunset. */
const TWILIGHT_MS = 90 * 60_000;

/**
 * Sunrise and sunset on a day at a place, as instants; or, inside a polar
 * circle, which of the two lasts the whole day. The sunrise equation with
 * the standard 0.833° allowance for refraction and the sun's disc; accurate
 * to a few minutes, which is all a sky needs.
 */
export function sunTimes(day: string, place: LatLon): { rise: number; set: number } | { polar: "day" | "night" } {
  // Days since J2000 at the day's noon UTC, then the mean solar noon there.
  const n = Date.parse(`${day}T12:00:00Z`) / DAY_MS + UNIX_JD - J2000;
  const noon = n - place.lon / 360;
  const anomaly = (((357.5291 + 0.98560028 * noon) % 360) + 360) % 360;
  const centre =
    1.9148 * Math.sin(anomaly * RAD) + 0.02 * Math.sin(2 * anomaly * RAD) + 0.0003 * Math.sin(3 * anomaly * RAD);
  const longitude = (anomaly + centre + 180 + 102.9372) % 360;
  const transit = J2000 + noon + 0.0053 * Math.sin(anomaly * RAD) - 0.0069 * Math.sin(2 * longitude * RAD);
  const declination = Math.asin(Math.sin(longitude * RAD) * Math.sin(23.4397 * RAD));
  const cosHour =
    (Math.sin(-0.833 * RAD) - Math.sin(place.lat * RAD) * Math.sin(declination)) /
    (Math.cos(place.lat * RAD) * Math.cos(declination));
  if (cosHour > 1) {
    return { polar: "night" };
  }
  if (cosHour < -1) {
    return { polar: "day" };
  }
  const half = Math.acos(cosHour) / RAD / 360;
  const instant = (jd: number) => Math.round((jd - UNIX_JD) * DAY_MS);
  return { rise: instant(transit - half), set: instant(transit + half) };
}

/**
 * The sky for a moment at a place: dawn and dusk around sunrise and sunset,
 * day between them, night outside. Where the place is not known, the local
 * hour decides, as it always has.
 */
export function skyOf(at: number, zone: string, place?: LatLon): Sky {
  if (!place) {
    const hour = Number(zonedTime(at, zone).slice(0, 2));
    if (hour >= 21 || hour < 5) {
      return "night";
    }
    if (hour < 8) {
      return "dawn";
    }
    return hour < 17 ? "day" : "dusk";
  }
  const sun = sunTimes(zonedDay(at, zone), place);
  if ("polar" in sun) {
    return sun.polar;
  }
  if (Math.abs(at - sun.rise) < TWILIGHT_MS) {
    return "dawn";
  }
  if (Math.abs(at - sun.set) < TWILIGHT_MS) {
    return "dusk";
  }
  return at > sun.rise && at < sun.set ? "day" : "night";
}
