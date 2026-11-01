// @vitest-environment jsdom
process.env.TZ = "Europe/Lisbon";

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { decided } from "../decisions";
import type { Trip } from "../intel/agenda";
import type { AgendaRow } from "../intel/agendarows";
import type { TripPlan } from "../intel/agenda";
import { isEmptySpace } from "../marquee";
import { useStore } from "../store";
import { TimelineList } from "./TimelineList";

const ACCOUNT = "t@example.com";
let container: HTMLDivElement;
let root: Root;

const addToTrip = vi.fn(async () => {});
const resolveFacts = vi.fn(async () => {});
const confirmTrip = vi.fn(async () => {});
const onToast = vi.fn();
const onInspect = vi.fn();

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  localStorage.clear();
  for (const fn of [addToTrip, resolveFacts, confirmTrip, onToast, onInspect]) {
    fn.mockClear();
  }
  useStore.setState({
    session: { email: ACCOUNT, token: "t", masterKey: new Uint8Array(32), privateKey: new Uint8Array(32), publicKey: "" },
    addToTrip,
    resolveFacts,
    confirmTrip,
  });
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  vi.useRealTimers();
});

const row = (id: string, kind: AgendaRow["kind"], day: string, time: string | undefined, extra: Partial<AgendaRow> = {}): AgendaRow => ({
  id,
  kind,
  tag: kind.toUpperCase(),
  day,
  ...(time ? { time } : {}),
  title: id,
  source: "EMAIL",
  fileIds: [`f-${id}`],
  past: false,
  ...extra,
});
const LISBON: Trip = { tag: "trip:lisbon-2026-11", title: "Lisbon, Nov 2026", members: [], start: "2026-11-12", end: "2026-11-16" };
const exactTrip = { tag: LISBON.tag, title: LISBON.title, name: "Lisbon", evidence: "exact" as const };
const flight = (id: string, day: string, time: string, extra: Partial<AgendaRow> = {}) =>
  row(id, "flight", day, time, { tag: "FLIGHT", trip: exactTrip, flight: { from: "SFO", to: "LIS", number: "TP 236", dep: time, arr: "14:05", plusDays: 1 }, ...extra });

function render(props: Partial<Parameters<typeof TimelineList>[0]> & { rows: AgendaRow[]; now: number }) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root.render(
      <TimelineList trips={[]} homeCity="San Francisco" filter="all" onInspect={onInspect} onOpen={() => {}} onToast={onToast} {...props} />,
    ),
  );
}

const text = () => container.textContent ?? "";
const order = (selector: string) => [...container.querySelectorAll(selector)];
const click = (label: RegExp) => {
  const button = [...container.querySelectorAll("button")].find((b) => label.test(b.textContent ?? ""));
  act(() => {
    button!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
};

describe("the timeline list", () => {
  it("days, the now line and the trip band read as the prototype's", () => {
    const now = new Date("2026-11-14T15:42:00").getTime();
    render({
      now,
      trips: [LISBON],
      rows: [
        flight("out", "2026-11-12", "18:10", { past: true, endDay: "2026-11-13", endTime: "14:05" }),
        row("checkin", "stay", "2026-11-13", "15:00", { past: true, trip: exactTrip }),
        row("museum", "event", "2026-11-14", "10:00", { past: true, trip: exactTrip }),
        flight("back", "2026-11-16", "13:20"),
      ],
    });
    const headers = order(".tln-dayh").map((h) => h.textContent);
    expect(headers).toEqual(["Thu 12 NovLisbon · day 1", "Fri 13 NovLisbon · day 2", "Sat 14 NovTODAYLisbon · day 3", "Mon 16 NovLisbon · day 5"]);
    expect(text()).toContain("NOW · LISBON");
    const sequence = order(".tln-dayh, .tln-row, .tln-now").map((el) => el.className.split(" ")[0] + ":" + (el.getAttribute("data-id") ?? el.textContent?.slice(0, 10)));
    expect(sequence.indexOf("tln-now:" + order(".tln-now")[0]!.textContent?.slice(0, 10))).toBe(sequence.indexOf("tln-row:museum") + 1);
    expect(container.querySelector('[data-id="out"]')!.classList.contains("tln-start")).toBe(true);
    expect(container.querySelector('[data-id="back"]')!.classList.contains("tln-end")).toBe(true);
    expect(order(".tln-row.tln-in")).toHaveLength(4);
    expect(container.querySelector('[data-id="out"]')!.textContent).toContain("TP 236");
    expect(container.querySelector('[data-id="out"]')!.textContent).toContain("LISBON");
  });

  it("quiet days and past rows", () => {
    const now = new Date("2026-09-08T08:40:00").getTime();
    render({ now, rows: [row("rent", "bill", "2026-09-01", "09:00", { past: true }), row("dinner", "event", "2026-09-08", "19:30")] });
    expect(text()).toContain("6 quiet days");
    expect(container.querySelector('[data-id="rent"]')!.classList.contains("tln-past")).toBe(true);
    expect(container.querySelector('[data-id="dinner"]')!.classList.contains("tln-past")).toBe(false);
  });

  it("the TODAY pill and now line agree at ten past midnight", () => {
    const now = new Date("2026-09-09T00:10:00").getTime();
    render({ now, rows: [row("late", "event", "2026-09-08", "23:30", { past: true }), row("parcel", "parcel", "2026-09-09", "10:00")] });
    const today = order(".tln-dayh").find((h) => h.textContent?.includes("TODAY"))!;
    expect(today.textContent).toContain("Wed 9 Sep");
    const sequence = order(".tln-dayh, .tln-row, .tln-now");
    const nowAt = sequence.findIndex((el) => el.classList.contains("tln-now"));
    expect(sequence[nowAt - 1]).toBe(today);
    expect(sequence[nowAt + 1]!.getAttribute("data-id")).toBe("parcel");
  });

  it("overlapping trips and a trip with no flights keep one band each", () => {
    const now = new Date("2026-10-01T09:00:00").getTime();
    const walk: Trip = { tag: "trip:porto-2026-11", title: "Porto, Nov 2026", members: [], start: "2026-11-01", end: "2026-11-05" };
    const fly: Trip = { tag: "trip:rome-2026-11", title: "Rome, Nov 2026", members: [], start: "2026-11-04", end: "2026-11-08" };
    const porto = { tag: walk.tag, title: walk.title, name: "Porto", evidence: "exact" as const };
    const rome = { tag: fly.tag, title: fly.title, name: "Rome", evidence: "exact" as const };
    render({
      now,
      trips: [walk, fly],
      rows: [
        row("p1", "event", "2026-11-01", "10:00", { trip: porto }),
        flight("r1", "2026-11-04", "08:00", { trip: rome }),
        row("p2", "event", "2026-11-05", "18:00", { trip: porto }),
        flight("r2", "2026-11-08", "20:00", { trip: rome }),
      ],
    });
    const marks = (id: string) => [container.querySelector(`[data-id="${id}"]`)!.classList.contains("tln-start"), container.querySelector(`[data-id="${id}"]`)!.classList.contains("tln-end")];
    expect(marks("p1")).toEqual([true, false]);
    expect(marks("p2")).toEqual([false, true]);
    expect(marks("r1")).toEqual([true, false]);
    expect(marks("r2")).toEqual([false, true]);
  });

  it("only the last thirty days show until asked", () => {
    const now = new Date("2026-09-08T08:40:00").getTime();
    render({ now, rows: [row("old", "bill", "2026-07-01", "09:00", { past: true }), row("recent", "bill", "2026-08-30", "09:00", { past: true }), row("today", "event", "2026-09-08", "19:30")] });
    expect(container.querySelector('[data-id="old"]')).toBeNull();
    expect(text()).toContain("Show earlier · 1");
    click(/Show earlier/);
    expect(container.querySelector('[data-id="old"]')).not.toBeNull();
    expect(text()).not.toContain("Show earlier");
  });

  it("filters keep what the prototype keeps", () => {
    const now = new Date("2026-09-08T08:40:00").getTime();
    const rows = [
      row("bill", "bill", "2026-09-09", "09:00", { amount: { currency: "USD", value: "10.00" } }),
      row("photos", "photos", "2026-09-09", "10:00"),
      row("trip-row", "event", "2026-09-09", "11:00", { trip: exactTrip }),
      row("parcel", "parcel", "2026-09-09", "12:00"),
    ];
    const ids = () => order(".tln-row").map((el) => el.getAttribute("data-id"));
    render({ now, rows, filter: "bills" });
    expect(ids()).toEqual(["bill"]);
    act(() => root.unmount());
    render({ now, rows, filter: "trips" });
    expect(ids()).toEqual(["trip-row"]);
    act(() => root.unmount());
    render({ now, rows, filter: "dates" });
    expect(ids()).toEqual(["trip-row", "parcel"]);
  });

  it("Add puts the receipt in the trip and its suggestion goes", () => {
    const now = new Date("2026-11-14T15:42:00").getTime();
    const weak = row("taxi", "bill", "2026-11-13", "14:48", { trip: { ...exactTrip, evidence: "weak" }, amount: { currency: "EUR", value: "24.50" } });
    render({ now, rows: [weak] });
    expect(text()).toContain("Part of Lisbon? Only the date matches.");
    click(/^Add$/);
    expect(addToTrip).toHaveBeenCalledWith(["f-taxi"], LISBON.tag);
    expect(onToast).toHaveBeenCalledWith("Added to Lisbon. The trip total is updated.");
    act(() => root.render(<TimelineList rows={[{ ...weak, trip: exactTrip }]} trips={[]} homeCity="San Francisco" now={now} filter="all" onInspect={onInspect} onOpen={() => {}} onToast={onToast} />));
    expect(text()).not.toContain("Part of Lisbon?");
  });

  it("No keeps it out", () => {
    const now = new Date("2026-11-14T15:42:00").getTime();
    render({ now, rows: [row("taxi", "bill", "2026-11-13", "14:48", { trip: { ...exactTrip, evidence: "weak" } })] });
    click(/^No$/);
    expect(decided(ACCOUNT, "tripExclusions").has(`${LISBON.tag}|f-taxi`)).toBe(true);
    expect(onToast).toHaveBeenCalledWith("Kept out of the trip.");
  });

  it("Confirm date confirms", () => {
    const now = new Date("2026-09-08T08:40:00").getTime();
    render({ now, rows: [row("dmv", "due", "2026-09-30", undefined, { ask: true, factIds: ["due:dmv"] })] });
    expect(text()).toContain("Not confirmed yet.");
    click(/Confirm date/);
    expect(resolveFacts).toHaveBeenCalledWith("f-dmv", { confirm: ["due:dmv"] });
    expect(onToast).toHaveBeenCalledWith("Date confirmed. A notice comes a week before.");
  });

  it("a click on a row is a click on something, and the inspected row is marked", () => {
    const now = new Date("2026-09-08T08:40:00").getTime();
    render({ now, rows: [row("dinner", "event", "2026-09-08", "19:30"), row("parcel", "parcel", "2026-09-09", "10:00")], selectedFileId: "f-dinner" });
    const card = container.querySelector('[data-id="dinner"] .tln-ev')!;
    expect(isEmptySpace(card.querySelector(".tln-evt"))).toBe(false);
    expect(card.classList.contains("tln-sel")).toBe(true);
    expect(container.querySelector('[data-id="parcel"] .tln-ev')!.classList.contains("tln-sel")).toBe(false);
  });

  it("Keep trip keeps, Not a trip waits for Undo before it is remembered", () => {
    vi.useFakeTimers();
    const now = new Date("2026-09-08T08:40:00").getTime();
    const plan = { tag: "trip:chicago-2026-12", dismissKeys: ["anchor:chicago-hotel"] } as unknown as TripPlan;
    const proposal = row("chicago", "trip", "2026-12-18", undefined, { tag: "TRIP?", title: "Chicago, 18-21 Dec?", proposal: plan });
    render({ now, rows: [proposal] });
    click(/Keep trip/);
    expect(confirmTrip).toHaveBeenCalledWith(plan);
    expect(onToast).toHaveBeenCalledWith("Trip kept. Later bookings join it on their own.");
    expect(text()).toContain("Kept. Bookings that arrive later join it on their own.");
    act(() => root.unmount());
    render({ now, rows: [proposal] });
    click(/Not a trip/);
    expect(text()).toContain("Not a trip. The dates stay as they were.");
    act(() => vi.advanceTimersByTime(29_000));
    expect(decided(ACCOUNT, "dismissedTrips").size).toBe(0);
    click(/Undo/);
    act(() => vi.advanceTimersByTime(60_000));
    expect(decided(ACCOUNT, "dismissedTrips").size).toBe(0);
    expect(text()).toContain("Chicago, 18-21 Dec?");
    click(/Not a trip/);
    act(() => vi.advanceTimersByTime(30_000));
    expect(decided(ACCOUNT, "dismissedTrips").has("anchor:chicago-hotel")).toBe(true);
  });
});
