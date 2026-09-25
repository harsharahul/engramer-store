/**
 * How the three columns share a window.
 *
 * The rule is the Mac's split view: the content column is guaranteed a
 * minimum, and when the window cannot afford that beside the panels, the
 * panels give way in a fixed order, narrowing first, then collapsing the
 * sidebar to a rail, then floating the details over the content. Nothing
 * ever simply disappears while its button says it is showing: a pane that
 * has no column becomes an overlay, not a `display: none`.
 *
 * Pure arithmetic, so the ladder is testable at every width that matters.
 */

/** The content column never goes narrower than this beside the panels. */
export const CONTENT_MIN = 520;

export const SIDEBAR_MIN = 180;
export const SIDEBAR_MAX = 320;
export const SIDEBAR_DEFAULT = 232;
/** The collapsed sidebar: icons only, labels on hover. */
export const RAIL_WIDTH = 64;

export const DETAILS_MIN = 240;
export const DETAILS_MAX = 420;
export const DETAILS_DEFAULT = 300;

/** Phone layout below this; keep in sync with MOBILE_QUERY in media.ts. */
export const PHONE_MAX = 760;

/** Dragging a divider this far past a panel's minimum snaps it shut. */
const SNAP_PX = 40;

export interface LayoutPrefs {
  sidebarWidth: number;
  detailsWidth: number;
  sidebarCollapsed: boolean;
  detailsOpen: boolean;
  /** Width of the collapsed sidebar; the Mac shell asks for a wider one. */
  railWidth?: number;
}

export interface LayoutPlan {
  sidebar: "expanded" | "rail" | "drawer";
  details: "pane" | "overlay" | "sheet" | "hidden";
  sidebarWidth: number;
  detailsWidth: number;
  /** The content column is at or near its floor: fold secondary toolbar actions. */
  compact: boolean;
}

const clamp = (value: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, value));

export function planLayout(viewport: number, prefs: LayoutPrefs): LayoutPlan {
  if (viewport <= PHONE_MAX) {
    return {
      sidebar: "drawer",
      details: prefs.detailsOpen ? "sheet" : "hidden",
      sidebarWidth: 0,
      detailsWidth: 0,
      compact: true,
    };
  }

  let sidebar: LayoutPlan["sidebar"] = prefs.sidebarCollapsed ? "rail" : "expanded";
  const railWidth = prefs.railWidth ?? RAIL_WIDTH;
  let sidebarWidth = sidebar === "rail" ? railWidth : clamp(prefs.sidebarWidth, SIDEBAR_MIN, SIDEBAR_MAX);
  let details: LayoutPlan["details"] = prefs.detailsOpen ? "pane" : "hidden";
  let detailsWidth = prefs.detailsOpen ? clamp(prefs.detailsWidth, DETAILS_MIN, DETAILS_MAX) : 0;

  const room = () => viewport - sidebarWidth - (details === "pane" ? detailsWidth : 0);

  // Concessions, cheapest first. Each stops as soon as the content fits.
  if (room() < CONTENT_MIN && details === "pane") {
    detailsWidth = DETAILS_MIN;
  }
  if (room() < CONTENT_MIN && sidebar === "expanded") {
    sidebarWidth = SIDEBAR_MIN;
  }
  if (room() < CONTENT_MIN && sidebar === "expanded") {
    sidebar = "rail";
    sidebarWidth = railWidth;
  }
  if (room() < CONTENT_MIN && details === "pane") {
    details = "overlay";
    // Floating, the pane keeps its chosen width where the window allows.
    detailsWidth = clamp(
      Math.min(clamp(prefs.detailsWidth, DETAILS_MIN, DETAILS_MAX), viewport - sidebarWidth - 160),
      DETAILS_MIN,
      DETAILS_MAX,
    );
  }

  return {
    sidebar,
    details,
    sidebarWidth,
    detailsWidth,
    compact: room() < CONTENT_MIN + 200,
  };
}

/** Where a sidebar divider drag lands: a width, or shut when pulled past the floor. */
export function resizeSidebar(width: number): { collapsed: true } | { collapsed: false; width: number } {
  if (width < SIDEBAR_MIN - SNAP_PX) {
    return { collapsed: true };
  }
  return { collapsed: false, width: clamp(width, SIDEBAR_MIN, SIDEBAR_MAX) };
}

/** Where a details divider drag lands: a width, or closed when pulled past the floor. */
export function resizeDetails(width: number): { open: false } | { open: true; width: number } {
  if (width < DETAILS_MIN - SNAP_PX) {
    return { open: false };
  }
  return { open: true, width: clamp(width, DETAILS_MIN, DETAILS_MAX) };
}
