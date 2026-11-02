// @vitest-environment jsdom
process.env.TZ = "America/Los_Angeles";

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { lisbonTrip, PLANNING_NOW } from "../intel/__fixtures__/lisbon";
import type { AgendaRow, RowFile } from "../intel/agendarows";
import { routeOf } from "../intel/route";
import type { TripView } from "../intel/tripview";
import { useStore } from "../store";
import { RouteArc } from "./RouteArc";
import { TripPage } from "./TripPage";

const LA = "America/Los_Angeles";
let container: HTMLDivElement;
let root: Root;
let trip: { view: TripView; rows: AgendaRow[]; files: RowFile[] };
const onClose = vi.fn();
const onInspect = vi.fn();
const onToast = vi.fn();
const undoTrip = vi.fn(async () => 2);
const triggerDownload = vi.hoisted(() => vi.fn());
vi.mock("../download", () => ({ triggerDownload }));

beforeAll(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // jsdom draws nothing; the page must not need it to.
  HTMLCanvasElement.prototype.getContext = (() => null) as never;
  trip = await lisbonTrip();
});

beforeEach(() => {
  for (const fn of [onClose, onInspect, onToast, undoTrip, triggerDownload]) {
    fn.mockClear();
  }
  useStore.setState({ addToTrip: vi.fn(async () => {}), undoTrip } as never);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(PLANNING_NOW);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

function mount(view: TripView = trip.view) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const byId = new Map(trip.files.map((file) => [file.id, file]));
  act(() =>
    root.render(
      <TripPage
        view={view}
        rows={trip.rows}
        files={trip.files}
        now={PLANNING_NOW}
        homeZone={LA}
        onClose={onClose}
        onInspect={onInspect}
        onOpen={() => {}}
        onToast={onToast}
        fileOf={(id) => byId.get(id) as never}
      />,
    ),
  );
}

/** A card's header text, without its aside. */
const headers = () => [...container.querySelectorAll(".tln-card > .tln-hd")].map((hd) => hd.firstChild?.textContent);
const press = (el: Element | undefined | null) => act(() => el!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
const byText = (selector: string, text: string) =>
  [...container.querySelectorAll(selector)].find((el) => el.textContent?.includes(text));

describe("the trip page", () => {
  it("the trip page shows its route, itinerary, bookings, checks, spend and everything", () => {
    mount();
    expect(headers()).toEqual(["Route", "Itinerary", "Booked in Lisbon", "Spend", "Everything for this trip"]);
    expect(container.textContent).toMatch(/[\d,]+ km · 11 h 55 m out · drawn on this device, no map service/);
    expect(container.textContent).toContain("Casa do Rio · 3 nights");
    expect(container.querySelector(".tln-big")?.textContent).toBe("17 days");
    expect(container.querySelector(".tln-pmeta")?.textContent).toBe("Portugal · 12-16 Nov 2026 · 5 days");
  });

  it("every row on the trip page opens its file", () => {
    mount();
    press(byText(".tln-trow", "Museu do Azulejo"));
    expect(onInspect).toHaveBeenLastCalledWith("museum");
    press(byText(".tln-tsrc", "SFO to LIS"));
    expect(onInspect).toHaveBeenLastCalledWith("booking");
    press(byText(".tln-leg", "Casa do Rio"));
    expect(onInspect).toHaveBeenLastCalledWith("hotel");
    press(byText(".tln-leg", "TP 236"));
    expect(onInspect).toHaveBeenLastCalledWith("booking");
    press(byText(".tln-bill", "96.00"));
    expect(onInspect).toHaveBeenLastCalledWith("receipt");
  });

  it("a trip with no located airports has no route card", () => {
    mount({ ...trip.view, legs: [], coords: {}, leaveBy: [] });
    expect(headers()).not.toContain("Route");
  });

  it("Back to Timeline and Escape close the page", () => {
    mount();
    press(byText("button", "Back to Timeline"));
    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("export saves one calendar file for the trip", () => {
    mount();
    press(byText("button", "Export to calendar"));
    expect(triggerDownload).toHaveBeenCalledTimes(1);
    const [blob, name] = triggerDownload.mock.calls[0]!;
    expect((blob as Blob).type).toBe("text/calendar");
    expect(name).toBe("lisbon-2026-11-12.ics");
    expect(onToast).toHaveBeenCalledWith("Saved lisbon-2026-11-12.ics. Open it to add the trip to your calendar.");
  });

  it("a trip with nothing to put in a calendar offers no export", () => {
    mount({ ...trip.view, legs: [], stays: [], booked: [], leaveBy: [] });
    expect(byText("button", "Export to calendar")).toBeUndefined();
  });

  it("Not a trip asks once, then takes the trip apart", async () => {
    mount();
    press(byText("button", "Not a trip"));
    expect(container.textContent).toContain("Take this trip apart? The files stay where they are.");
    press(byText("button", "Keep trip"));
    expect(container.textContent).not.toContain("Take this trip apart?");
    press(byText("button", "Not a trip"));
    await act(async () => {
      byText("button", "Take apart")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(undoTrip).toHaveBeenCalledWith(trip.view.tag);
    expect(onToast).toHaveBeenCalledWith("The trip comes apart. The files stay where they are.");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Escape inside a text field does not close the page", () => {
    mount();
    const field = document.createElement("input");
    container.appendChild(field);
    field.focus();
    act(() => field.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("the route arc", () => {
  it("a route draws nothing without a canvas context, and does not throw", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    expect(() => act(() => root.render(<RouteArc route={routeOf(trip.view, PLANNING_NOW)!} />))).not.toThrow();
  });

  it("the route is described for screen readers", () => {
    const route = routeOf(trip.view, PLANNING_NOW)!;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(<RouteArc route={route} />));
    expect(container.querySelector("canvas")!.getAttribute("aria-label")).toBe(
      `Route from San Francisco to Lisbon, ${route.km.toLocaleString("en-US")} km`,
    );
  });
});
