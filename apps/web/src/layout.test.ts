import { describe, expect, it } from "vitest";
import {
  CONTENT_MIN,
  DETAILS_DEFAULT,
  DETAILS_MIN,
  RAIL_WIDTH,
  SIDEBAR_DEFAULT,
  SIDEBAR_MIN,
  planLayout,
  resizeDetails,
  resizeSidebar,
  type LayoutPrefs,
} from "./layout";

const prefs = (over: Partial<LayoutPrefs> = {}): LayoutPrefs => ({
  sidebarWidth: SIDEBAR_DEFAULT,
  detailsWidth: DETAILS_DEFAULT,
  sidebarCollapsed: false,
  detailsOpen: true,
  ...over,
});

describe("planLayout concession ladder", () => {
  it("keeps everything at its chosen width when the window is wide", () => {
    const plan = planLayout(1440, prefs());
    expect(plan).toMatchObject({
      sidebar: "expanded",
      details: "pane",
      sidebarWidth: SIDEBAR_DEFAULT,
      detailsWidth: DETAILS_DEFAULT,
    });
  });

  it("holds the full details pane at a half-screen window", () => {
    const plan = planLayout(1100, prefs());
    expect(plan.details).toBe("pane");
    expect(plan.detailsWidth).toBe(DETAILS_DEFAULT);
  });

  it("first narrows the details pane, then the sidebar", () => {
    const plan = planLayout(960, prefs());
    expect(plan.details).toBe("pane");
    expect(plan.detailsWidth).toBe(DETAILS_MIN);
    expect(plan.sidebar).toBe("expanded");
    expect(plan.sidebarWidth).toBe(SIDEBAR_MIN);
    expect(960 - plan.sidebarWidth - plan.detailsWidth).toBeGreaterThanOrEqual(CONTENT_MIN);
  });

  it("then collapses the sidebar to a rail before touching the pane", () => {
    const plan = planLayout(880, prefs());
    expect(plan.sidebar).toBe("rail");
    expect(plan.sidebarWidth).toBe(RAIL_WIDTH);
    expect(plan.details).toBe("pane");
  });

  it("finally floats the details over the content instead of hiding it", () => {
    const plan = planLayout(800, prefs());
    expect(plan.sidebar).toBe("rail");
    expect(plan.details).toBe("overlay");
    expect(plan.detailsWidth).toBeGreaterThanOrEqual(DETAILS_MIN);
    // The 761-899 px window that used to lose the pane entirely.
    expect(planLayout(761, prefs()).details).toBe("overlay");
  });

  it("hands the phone its own layout", () => {
    const plan = planLayout(390, prefs());
    expect(plan.sidebar).toBe("drawer");
    expect(plan.details).toBe("sheet");
  });

  it("honors a closed pane and a collapsed sidebar as chosen", () => {
    expect(planLayout(1440, prefs({ detailsOpen: false })).details).toBe("hidden");
    const railed = planLayout(1440, prefs({ sidebarCollapsed: true }));
    expect(railed.sidebar).toBe("rail");
    expect(railed.details).toBe("pane");
  });

  it("clamps remembered widths into their ranges", () => {
    const plan = planLayout(1440, prefs({ sidebarWidth: 9999, detailsWidth: 1 }));
    expect(plan.sidebarWidth).toBeLessThanOrEqual(320);
    expect(plan.detailsWidth).toBeGreaterThanOrEqual(DETAILS_MIN);
  });

  it("flags a compact content column so the toolbar can fold", () => {
    expect(planLayout(1440, prefs()).compact).toBe(false);
    expect(planLayout(880, prefs()).compact).toBe(true);
  });
});

describe("divider snapping", () => {
  it("collapses the sidebar when dragged well under its minimum", () => {
    expect(resizeSidebar(SIDEBAR_MIN - 60)).toEqual({ collapsed: true });
    expect(resizeSidebar(SIDEBAR_MIN - 10)).toEqual({ collapsed: false, width: SIDEBAR_MIN });
    expect(resizeSidebar(1000)).toEqual({ collapsed: false, width: 320 });
  });

  it("closes the details pane when dragged well under its minimum", () => {
    expect(resizeDetails(DETAILS_MIN - 60)).toEqual({ open: false });
    expect(resizeDetails(DETAILS_MIN - 10)).toEqual({ open: true, width: DETAILS_MIN });
    expect(resizeDetails(1000)).toEqual({ open: true, width: 420 });
  });
});
