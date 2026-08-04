/**
 * Keeps the app exactly as tall as the screen actually is.
 *
 * On a phone, and especially in a home-screen app, the height a browser
 * reports when a page first loads is not always the height it settles on: a
 * bar that has not collapsed yet, a keyboard closing, an orientation the
 * system is still applying. A layout sized from that first answer is left
 * short, which is visible as a band of empty space under the bottom bar
 * until something forces a re-layout, at which point it silently corrects.
 *
 * So the height is measured rather than assumed, and measured again on every
 * event that can change it. `visualViewport` is the one that reports what is
 * actually visible, rather than what the page believes it has.
 */

const PROPERTY = "--app-height";

function apply(): void {
  const height = window.visualViewport?.height ?? window.innerHeight;
  if (height > 0) {
    document.documentElement.style.setProperty(PROPERTY, `${Math.round(height)}px`);
  }
}

/** Starts tracking. Returns a function that stops it. */
export function trackViewportHeight(): () => void {
  apply();
  // The first answer after load is the one most often wrong, so take another
  // once the page has settled rather than trusting it.
  const settle = window.setTimeout(apply, 300);
  const viewport = window.visualViewport;
  viewport?.addEventListener("resize", apply);
  viewport?.addEventListener("scroll", apply);
  window.addEventListener("resize", apply);
  window.addEventListener("orientationchange", apply);
  window.addEventListener("pageshow", apply);
  return () => {
    window.clearTimeout(settle);
    viewport?.removeEventListener("resize", apply);
    viewport?.removeEventListener("scroll", apply);
    window.removeEventListener("resize", apply);
    window.removeEventListener("orientationchange", apply);
    window.removeEventListener("pageshow", apply);
  };
}
