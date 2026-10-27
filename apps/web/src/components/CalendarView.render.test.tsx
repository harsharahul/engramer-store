// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Fact } from "../intel/facts";
import type { FileEntry } from "../store";
import { CalendarView } from "./CalendarView";

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  // Only the clock is fake: the month on screen is November 2026.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 10, 1, 12));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

const fact = (value: string, extra: Partial<Fact> = {}): Fact => ({
  id: `event:${value}`,
  kind: "event",
  document: "hotel-booking",
  value,
  label: "Check-in: Casa do Rio",
  source: "jsonld",
  confidence: 1,
  accepted: "exact",
  ...extra,
});

const file = (id: string, facts: Fact[], tags: string[] = []): FileEntry =>
  ({
    id,
    folderId: null,
    name: `${id}.pdf`,
    mime: "application/pdf",
    size: 10,
    mtime: 0,
    hasText: true,
    hasClip: false,
    inlineText: false,
    tags,
    facts,
    favorite: false,
    key: new Uint8Array(32),
    hasThumb: false,
    trashed: false,
    createdAt: 0,
    updatedAt: 0,
  }) as FileEntry;

function render(files: FileEntry[]) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<CalendarView files={files} onOpen={() => {}} />));
}

const tracked = () =>
  [...container.querySelectorAll('[role="gridcell"]')].filter((cell) => /tracked/.test(cell.getAttribute("aria-label") ?? ""));

describe("the calendar", () => {
  it("a trip draws one bar titled from its tag across its dates", () => {
    render([
      file("out", [fact("2026-11-12")], ["trip:lisbon-2026-11"]),
      file("back", [fact("2026-11-16", { label: "Check-out: Casa do Rio" })], ["trip:lisbon-2026-11"]),
    ]);
    const spans = [...container.querySelectorAll(".cal-span")];
    expect(spans.length).toBeGreaterThan(0);
    expect(spans.every((span) => span.getAttribute("title") === "Lisbon, Nov 2026")).toBe(true);
    expect(spans.filter((span) => span.textContent === "Lisbon, Nov 2026")).toHaveLength(1);
  });

  it("a tracked date marks its day and an untracked one does not", () => {
    render([
      file("bill", [fact("2026-11-20", { kind: "due", document: "invoice", label: "Payment due", source: "label", confidence: 0.7, accepted: undefined, confirmed: true })]),
      file("flyer", [fact("2026-11-21", { kind: "due", document: "other", label: "Sale ends", source: "model", confidence: 0.45, accepted: undefined })]),
    ]);
    expect(tracked().map((cell) => cell.getAttribute("aria-label"))).toEqual([expect.stringContaining("1 tracked")]);
  });
});
