// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Trip } from "../intel/agenda";
import type { AgendaRow } from "../intel/agendarows";
import { CalendarView } from "./CalendarView";

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const row = (id: string, kind: AgendaRow["kind"], day: string, title: string): AgendaRow => ({
  id,
  kind,
  tag: kind.toUpperCase(),
  day,
  title,
  source: "EMAIL",
  fileIds: [id],
  past: false,
});
const LISBON: Trip = { tag: "trip:lisbon-2026-11", title: "Lisbon, Nov 2026", members: [], start: "2026-11-12", end: "2026-11-16" };
const rows = [
  row("out", "flight", "2026-11-12", "San Francisco to Lisbon"),
  row("in", "stay", "2026-11-13", "Check in · Casa do Rio"),
  row("power", "due", "2026-11-20", "Electricity bill due"),
  row("a", "bill", "2026-11-20", "Groceries"),
];

function render(onDay = vi.fn()) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root.render(<CalendarView rows={rows} trips={[LISBON]} month={{ y: 2026, m: 10 }} today="2026-11-14" onDay={onDay} onMonth={() => {}} />),
  );
  return onDay;
}

const cell = (iso: string) => container.querySelector<HTMLElement>(`[data-day="${iso}"]`)!;

describe("the Month view", () => {
  it("a trip is one strip with its name, and a day shows its first row", () => {
    render();
    expect(container.querySelector("h3")!.textContent).toBe("November 2026");
    expect(container.textContent).toContain("Trips, bookings, bills and dates. Click a day to open it on the timeline.");
    expect([...container.querySelectorAll(".mon-dow")].map((d) => d.textContent)).toEqual(["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"]);
    // Thu 12 to Mon 16: two week segments, each named once.
    expect([...container.querySelectorAll(".mon-lab")].map((l) => l.textContent)).toEqual(["LISBON", "LISBON"]);
    expect(cell("2026-11-12").classList.contains("mon-ts")).toBe(true);
    expect(cell("2026-11-14").classList.contains("mon-te")).toBe(true);
    expect(cell("2026-11-15").classList.contains("mon-ts")).toBe(true);
    expect(cell("2026-11-16").classList.contains("mon-te")).toBe(true);
    expect(cell("2026-11-20").querySelector(".mon-t")!.textContent).toBe("Electricity bill due");
    expect(cell("2026-11-20").querySelectorAll(".mon-dots i")).toHaveLength(2);
    expect(cell("2026-11-13").querySelector(".mon-t")).toBeNull();
    expect(cell("2026-11-14").classList.contains("mon-today")).toBe(true);
    // The weeks run on into the next month, faded.
    expect(cell("2026-12-01").classList.contains("mon-out")).toBe(true);
  });

  it("the grid reads as rows of seven days to assistive technology", () => {
    render();
    const rowsOfGrid = [...container.querySelectorAll('[role="grid"] > [role="row"]')];
    expect(rowsOfGrid.length).toBeGreaterThan(4);
    expect(rowsOfGrid[0]!.querySelectorAll('[role="columnheader"]')).toHaveLength(7);
    expect(rowsOfGrid.slice(1).every((week) => week.querySelectorAll('[role="gridcell"]').length === 7)).toBe(true);
  });

  it("clicking or pressing Enter on a day opens it", () => {
    const onDay = render();
    act(() => cell("2026-11-20").dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onDay).toHaveBeenLastCalledWith("2026-11-20");
    act(() => cell("2026-11-13").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(onDay).toHaveBeenLastCalledWith("2026-11-13");
  });
});
