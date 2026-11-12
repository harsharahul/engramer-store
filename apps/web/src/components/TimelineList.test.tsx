// @vitest-environment jsdom
process.env.TZ = "Europe/Lisbon";

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { decided } from "../decisions";
import type { Trip } from "../intel/agenda";
import type { AgendaRow } from "../intel/agendarows";
import type { TripPlan } from "../intel/agenda";
import { deviceZone, instantOf } from "../intel/instants";
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
const onOpenTrip = vi.fn();

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
  at: instantOf(day, time, deviceZone()),
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
  row(id, "flight", day, time, {
    tag: "FLIGHT",
    trip: exactTrip,
    flight: {
      from: "SFO",
      to: "LIS",
      number: "TP 236",
      dep: time,
      arr: "14:05",
      plusDays: 1,
      leg: {
        key: "Flight TP 236",
        mode: "flight",
        designator: "TP 236",
        from: "SFO",
        to: "LIS",
        dep: { day, time, zone: "America/Los_Angeles", at: instantOf(day, time, "America/Los_Angeles"), code: "SFO", place: "SFO", factId: `${id}:dep` },
        fileId: `f-${id}`,
        factIds: [`${id}:dep`],
        ask: false,
      },
    },
    ...extra,
  });

function render(props: Partial<Parameters<typeof TimelineList>[0]> & { rows: AgendaRow[]; now: number }) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root.render(
      <TimelineList
        trips={[]}
        homeCity="San Francisco"
        filter="all"
        onInspect={onInspect}
        onOpen={() => {}}
        onToast={onToast}
        onOpenTrip={onOpenTrip}
        {...props}
      />,
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
  it("a row's trip chip opens the trip, not the row", () => {
    onInspect.mockClear();
    onOpenTrip.mockClear();
    render({ rows: [flight("out", "2026-11-12", "18:10")], trips: [LISBON], now: Date.UTC(2026, 9, 26, 17) });
    const chip = container.querySelector<HTMLButtonElement>("button.tln-chip-trip")!;
    expect(chip.textContent).toBe("LISBON");
    act(() => chip.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onOpenTrip).toHaveBeenCalledWith(LISBON.tag);
    expect(onInspect).not.toHaveBeenCalled();
  });

  it("days, the now line and the trip band read as designed", () => {
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

  it("a booking already begun in its own zone sits above the now line", () => {
    // 20:00 in Tokyo was 11:00 here; at 15:42 it has begun, though its printed clock is later.
    const now = new Date("2026-11-14T15:42:00").getTime();
    render({
      now,
      rows: [
        row("tokyo", "event", "2026-11-14", "20:00", { at: instantOf("2026-11-14", "20:00", "Asia/Tokyo"), past: true }),
        row("dinner", "event", "2026-11-14", "21:00"),
      ],
    });
    expect(order(".tln-row, .tln-now").map((el) => el.getAttribute("data-id") ?? "now")).toEqual(["tokyo", "now", "dinner"]);
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

  it("Show earlier keeps the rows on screen where they were", () => {
    const now = new Date("2026-09-08T08:40:00").getTime();
    // The list inside its scroller, as on the Timeline.
    const scroller = document.createElement("div");
    scroller.style.overflowY = "auto";
    document.body.appendChild(scroller);
    container = document.createElement("div");
    scroller.appendChild(container);
    root = createRoot(container);
    // The earlier rows add 600px above what is on screen.
    let reads = 0;
    Object.defineProperty(scroller, "scrollHeight", { get: () => (reads++ === 0 ? 1000 : 1600) });
    scroller.scrollTop = 50;
    act(() =>
      root.render(
        <TimelineList
          trips={[]}
          homeCity="San Francisco"
          filter="all"
          now={now}
          rows={[row("old", "bill", "2026-07-01", "09:00", { past: true }), row("today", "event", "2026-09-08", "19:30")]}
          onInspect={onInspect}
          onOpen={() => {}}
          onToast={onToast}
        />,
      ),
    );
    click(/Show earlier/);
    expect(scroller.scrollTop).toBe(650);
    scroller.remove();
  });

  it("filters keep trips, bills or dates", () => {
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

  it("a day asked for long ago is brought into the list", () => {
    const now = new Date("2026-09-08T08:40:00").getTime();
    const spy = vi.fn();
    Element.prototype.scrollIntoView = function (this: Element) {
      spy(this);
    };
    render({ now, rows: [row("spring", "bill", "2026-04-02", "09:00", { past: true }), row("today", "event", "2026-09-08", "19:30")], scrollTo: { day: "2026-04-02", nonce: 1 } });
    expect(container.querySelector('[data-id="spring"]')).not.toBeNull();
    expect((spy.mock.calls.at(-1)?.[0] as Element | undefined)?.textContent).toContain("Thu 2 Apr");
  });

  it("Enter on a button inside a row does only that button's work", () => {
    const now = new Date("2026-09-08T08:40:00").getTime();
    render({ now, rows: [row("taxi", "bill", "2026-09-07", "14:48", { trip: { ...exactTrip, evidence: "weak" } })] });
    const no = [...container.querySelectorAll("button")].find((b) => b.textContent === "No")!;
    act(() => no.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(onInspect).not.toHaveBeenCalled();
    const card = container.querySelector<HTMLElement>('[data-id="taxi"] .tln-ev')!;
    act(() => card.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true })));
    expect(onInspect).toHaveBeenCalledWith("f-taxi");
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

describe("flights on the list during a trip", () => {
  // In Lisbon, where this device is: TP 236 leaves San Francisco at 02:10 on 13 Nov and lands at 14:05.
  const leaves = Date.UTC(2026, 10, 13, 2, 10);
  const lands = Date.UTC(2026, 10, 13, 14, 5);
  const outbound = (): AgendaRow => {
    const base = flight("out", "2026-11-12", "18:10", { endDay: "2026-11-13", endTime: "14:05" });
    return {
      ...base,
      flight: {
        ...base.flight!,
        passFileId: "pass",
        leg: {
          ...base.flight!.leg,
          dep: { ...base.flight!.leg.dep!, at: leaves },
          arr: { day: "2026-11-13", time: "14:05", zone: "Europe/Lisbon", at: lands, code: "LIS", place: "LIS", factId: "out:arr" },
        },
      },
    };
  };

  it("a flight with its pass shows PASS from a day before", () => {
    render({ now: leaves - 31 * 3_600_000, rows: [outbound()] });
    expect(container.querySelector(".tln-chip-pass")).toBeNull();
    act(() => root.unmount());
    container.remove();
    render({ now: leaves - 26 * 3_600_000, rows: [outbound()] });
    expect(container.querySelector('[data-id="out"] .tln-chip-pass')!.textContent).toBe("PASS");
  });

  it("a flight in the air says when it lands", () => {
    const now = Date.UTC(2026, 10, 13, 6, 0);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    render({ now, rows: [outbound()] });
    expect(container.querySelector('[data-id="out"] .tln-inair')!.textContent).toBe("In the air · lands in 8 h 05 m");
    expect((container.querySelector('[data-id="out"] .tln-plane') as HTMLElement).style.left).toBe("32%");
  });

  it("a train under way reads TRAIN and says when it arrives", () => {
    const now = Date.UTC(2026, 10, 13, 6, 0);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    const flown = outbound();
    render({ now, rows: [{ ...flown, tag: "TRAIN", flight: { ...flown.flight!, leg: { ...flown.flight!.leg, mode: "train" } } }] });
    expect(container.querySelector('[data-id="out"] .tln-tag')!.textContent).toBe("TRAIN");
    expect(container.querySelector('[data-id="out"] .tln-inair')!.textContent).toBe("On the way · arrives in 8 h 05 m");
  });
});
