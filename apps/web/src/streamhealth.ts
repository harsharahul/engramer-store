/**
 * The honest maths behind the "keep it offline instead?" offer.
 *
 * The shell measures every network window's pace, and the player names
 * the clip's duration once its metadata loads; a clip's own byte rate is
 * just size over duration. When the measured link sits clearly below
 * that rate, no player in the world makes the stream smooth, and saying
 * so - with a one-tap pin as the way out - beats an endless spinner.
 */

/** Whether the link measurably cannot carry the clip. Unknown numbers
 * never accuse, and a borderline link gets 20% headroom before being
 * named: only a clear shortfall speaks. */
export function linkStarved(
  paceBytesPerSec: number,
  sizeBytes: number,
  durationSec: number | null,
): boolean {
  if (paceBytesPerSec <= 0 || !durationSec || durationSec <= 0) {
    return false;
  }
  return sizeBytes / durationSec > paceBytesPerSec * 1.2;
}
