// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { decide } from "../decisions";
import type { Fact } from "../intel/facts";
import type { FileEntry } from "../store";
import { LibraryIntel } from "./FactsPanel";

const undoTrip = vi.hoisted(() => vi.fn(async (_tag: string) => 1));

vi.mock("../store", () => ({
  useStore: (select: (state: unknown) => unknown) =>
    select({ session: { email: "a@example.com" }, dismissFact: vi.fn(), undoTrip }),
}));

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  localStorage.clear();
  undoTrip.mockClear();
});

const DAY = 86_400_000;
const isoIn = (days: number) => new Date(Date.now() + days * DAY).toISOString().slice(0, 10);

const due = (value: string, confirmed: boolean): Fact => ({
  id: `due:${value}`,
  kind: "due",
  document: "other",
  value,
  label: "Payment due",
  source: "label",
  confidence: 0.7,
  ...(confirmed ? { confirmed: true } : {}),
});

const file = (id: string, name: string, facts: Fact[], tags: string[] = []): FileEntry =>
  ({
    id,
    folderId: null,
    name,
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
  act(() => root.render(<LibraryIntel files={files} onOpen={() => {}} />));
}

describe("the Notices panel", () => {
  it("Coming up lists a tracked due date and leaves an untracked one out", () => {
    render([file("a", "Water bill.pdf", [due(isoIn(10), true)]), file("b", "Flyer.pdf", [due(isoIn(12), false)])]);
    expect(container.textContent).toContain("Coming up");
    expect(container.textContent).toContain("Water bill.pdf");
    expect(container.textContent).not.toContain("Flyer.pdf");
  });

  it("a trip shows one card, and its events are not repeated under Coming up", async () => {
    const checkIn: Fact = {
      id: `event:${isoIn(10)}`,
      kind: "event",
      document: "hotel-booking",
      value: isoIn(10),
      label: "Check-in: Casa do Rio",
      source: "jsonld",
      confidence: 1,
      accepted: "exact",
    };
    render([
      file("a", "Casa do Rio booking.pdf", [checkIn], ["trip:lisbon-2026-11"]),
      file("b", "Boarding pass.pdf", [], ["trip:lisbon-2026-11"]),
    ]);
    await act(async () => {});
    expect(container.querySelectorAll(".trip-card")).toHaveLength(1);
    expect(container.querySelector(".trip-card h4")?.textContent).toContain("Lisbon, Nov 2026");
    expect(container.textContent).not.toContain("Coming up");
  });

  it("an assembled trip says how it came together and can be undone", async () => {
    const tag = "trip:lisbon-2026-11";
    decide("a@example.com", "assembledTrips", [`${tag}|a`, `${tag}|b`]);
    render([file("a", "Flights.pdf", [], [tag]), file("b", "Casa do Rio.pdf", [], [tag])]);
    await act(async () => {});
    expect(container.textContent).toContain("Exact evidence, so this trip came together on its own.");
    const undo = [...container.querySelectorAll("button")].find((b) => b.textContent === "Not a trip")!;
    await act(async () => {
      undo.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(undoTrip).toHaveBeenCalledWith(tag);
    expect(container.textContent).toContain("Dismissed. It will not come back.");
  });

  it("a trip the owner kept shows neither", async () => {
    const tag = "trip:lisbon-2026-11";
    decide("a@example.com", "assembledTrips", [`${tag}|a`]);
    decide("a@example.com", "ownedTrips", [tag]);
    render([file("a", "Flights.pdf", [], [tag]), file("b", "Casa do Rio.pdf", [], [tag])]);
    await act(async () => {});
    expect(container.querySelectorAll(".trip-card")).toHaveLength(1);
    expect(container.textContent).not.toContain("came together on its own");
    expect([...container.querySelectorAll("button")].some((b) => b.textContent === "Not a trip")).toBe(false);
  });

  it("a trip long over shows no card", async () => {
    const back: Fact = {
      id: `event:${isoIn(-400)}`,
      kind: "event",
      document: "itinerary",
      value: isoIn(-400),
      label: "Flight AQ 6 arrives BOS",
      source: "jsonld",
      confidence: 1,
      accepted: "exact",
    };
    render([file("a", "Rome flights.pdf", [back], ["trip:rome-2024-05"])]);
    await act(async () => {});
    expect(container.querySelectorAll(".trip-card")).toHaveLength(0);
    expect(container.textContent).toContain("Nothing needs your attention.");
  });
});
