// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withExactAcceptance, type Fact } from "../intel/facts";
import { useStore, type FileEntry } from "../store";
import { chipTags } from "./DetailsPanel";
import { TripSection } from "./TripSection";

const TAG = "trip:lisbon-2026-11";
let container: HTMLDivElement;
let root: Root;
const leaveTrip = vi.fn(async () => {});
const addToTrip = vi.fn(async () => {});
const onToast = vi.fn();
const onOpenTrip = vi.fn();

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let seq = 0;
const exact = (value: string, label: string, extra: Partial<Fact> = {}): Fact =>
  withExactAcceptance({ id: `event:${value}:${seq++}`, kind: "event", document: "itinerary", value, label, source: "jsonld", confidence: 1, ...extra });
const entry = (id: string, facts: Fact[], tags: string[] = []): FileEntry =>
  ({
    id,
    folderId: null,
    name: `${id}.pdf`,
    mime: "application/pdf",
    size: 10,
    mtime: 0,
    hasText: false,
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

// Next year's Lisbon trip, so it is always recent.
const year = new Date().getUTCFullYear() + 1;
const library = () => [
  entry(
    "flight",
    [
      exact(`${year}-11-12`, "Flight TP 236 departs SFO"),
      exact(`${year}-11-13`, "Flight TP 236 arrives LIS"),
      exact(`${year}-11-16`, "Flight TP 237 departs LIS"),
      exact(`${year}-11-16`, "Flight TP 237 arrives SFO"),
    ],
    [TAG],
  ),
  entry(
    "hotel",
    [
      exact(`${year}-11-13`, "Check-in: Casa do Rio", { document: "hotel-booking" }),
      exact(`${year}-11-16`, "Check-out: Casa do Rio", { document: "hotel-booking" }),
    ],
    [TAG],
  ),
  entry("taxi", [{ id: "event:taxi", kind: "event", document: "invoice", value: `${year}-11-13`, label: "Taxi", source: "model", confidence: 0.8, accepted: "grounded" }]),
  entry("lease", [{ id: "due:lease", kind: "due", document: "other", value: `${year}-03-01`, source: "label", confidence: 0.7, confirmed: true }]),
];

beforeEach(() => {
  localStorage.clear();
  for (const fn of [leaveTrip, addToTrip, onToast]) {
    fn.mockClear();
  }
  const files = library().map((file) => (file.tags.includes(TAG) ? { ...file, tags: [`trip:lisbon-${year}-11`] } : file));
  useStore.setState({
    session: { email: "t@example.com", token: "t", masterKey: new Uint8Array(32), privateKey: new Uint8Array(32), publicKey: "" },
    files: new Map(files.map((file) => [file.id, file])),
    leaveTrip,
    addToTrip,
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render(id: string) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const file = useStore.getState().files.get(id)!;
  act(() => root.render(<TripSection file={file} onToast={onToast} onOpenTrip={onOpenTrip} />));
  await act(async () => {
    await import("../intel/tables/airports.json");
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

const click = (label: RegExp) => {
  const button = [...container.querySelectorAll("button")].find((b) => label.test(b.textContent ?? ""));
  act(() => {
    button!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
};

describe("the Trip section", () => {
  it("Part of Lisbon opens the trip", async () => {
    await render("hotel");
    click(/^Lisbon$/);
    expect(onOpenTrip).toHaveBeenCalledWith(`trip:lisbon-${year}-11`);
  });

  it("an assembled file says so and can leave", async () => {
    await render("hotel");
    expect(container.textContent).toContain("Part of Lisbon");
    expect(container.textContent).toContain("EXACT");
    expect(container.textContent).toContain("Exact evidence, so it joined the trip on its own.");
    click(/Not part of this trip/);
    expect(leaveTrip).toHaveBeenCalledWith(["hotel"], `trip:lisbon-${year}-11`);
    expect(onToast).toHaveBeenCalledWith("Removed from Lisbon. Every device hears it.");
  });

  it("a date-only file can join", async () => {
    await render("taxi");
    expect(container.textContent).toContain("Not in a trip yet");
    expect(container.textContent).toContain("DATE ONLY");
    expect(container.textContent).toContain("Only the date matches, so Engram asks before linking it.");
    click(/Add to Lisbon/);
    expect(addToTrip).toHaveBeenCalledWith(["taxi"], `trip:lisbon-${year}-11`);
    expect(onToast).toHaveBeenCalledWith("Added to Lisbon. The trip total is updated.");
  });

  it("a file in no trip shows no trip section", async () => {
    await render("lease");
    expect(container.textContent).toBe("");
  });

  it("trip tags are not chips any more", () => {
    container = document.createElement("div");
    root = createRoot(container);
    expect(chipTags([TAG, "receipts", "album:alps"])).toEqual(["receipts"]);
  });
});
