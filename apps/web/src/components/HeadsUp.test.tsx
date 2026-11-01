// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { decided } from "../decisions";
import { withExactAcceptance, type Fact } from "../intel/facts";
import { useStore, type FileEntry } from "../store";
import { HeadsUp, TripHeadsUp } from "./HeadsUp";

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const amount = (value: string, source: Fact["source"], confidence: number, other: string): Fact => ({
  id: `amount:${value}`,
  kind: "amount",
  document: "invoice",
  value,
  unit: "USD",
  label: "Amount due",
  source,
  confidence,
  disputed: `amount:${other}`,
});

const bill = {
  id: "bill",
  folderId: null,
  name: "Your bill.email",
  mime: "application/vnd.engram.email+json",
  size: 10,
  mtime: 0,
  hasText: true,
  hasClip: false,
  inlineText: false,
  tags: [],
  facts: [amount("56.00", "label", 0.7, "65.00"), amount("65.00", "model", 0.45, "56.00")],
  favorite: false,
  key: new Uint8Array(32),
  hasThumb: false,
  trashed: false,
  createdAt: 0,
  updatedAt: 0,
} as FileEntry;

describe("a disagreement in the heads-up strip", () => {
  it("offers both readings as one question and confirms the one picked", () => {
    const onConfirm = vi.fn();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(<HeadsUp files={[bill]} onOpen={() => {}} onConfirm={onConfirm} onDismiss={() => {}} />);
    });
    const choices = [...container.querySelectorAll("button")].filter((b) => /USD/.test(b.textContent ?? ""));
    expect(choices.map((b) => b.textContent)).toEqual(["USD 56.00", "USD 65.00"]);
    act(() => {
      choices[1]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onConfirm).toHaveBeenCalledWith("bill", "amount:65.00", undefined);
  });
});

const DAY = 86_400_000;
const isoIn = (days: number) => new Date(Date.now() + days * DAY).toISOString().slice(0, 10);
const ACCOUNT = "h@example.com";

const doc = (id: string, facts: Fact[], tags: string[] = []) =>
  ({ ...bill, id, name: `${id}.pdf`, mime: "application/pdf", tags, facts }) as FileEntry;
const booked = (id: string, days: number, label: string, document: Fact["document"]): Fact =>
  withExactAcceptance({ id, kind: "event", document, value: isoIn(days), label, source: "jsonld", confidence: 1 });
const readByModel = (id: string, days: number, label: string): Fact => ({
  id,
  kind: "event",
  document: "invoice",
  value: isoIn(days),
  label,
  source: "model",
  confidence: 0.8,
  accepted: "grounded",
});

const confirmTrip = vi.fn(async () => {});

/** Lets the plans' asynchronous work land; the airport table loads on first use. */
async function settle() {
  await act(async () => {
    await import("../intel/tables/airports.json");
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

function renderTrips(files: FileEntry[]) {
  if (!container?.isConnected) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }
  act(() => root.render(<TripHeadsUp files={files} onOpen={() => {}} />));
}

const click = (label: RegExp) => {
  const button = [...container.querySelectorAll("button")].find((b) => label.test(b.textContent ?? ""));
  act(() => {
    button!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
};

describe("trips offered for a yes", () => {
  beforeEach(() => {
    localStorage.clear();
    confirmTrip.mockClear();
    useStore.setState({
      session: { email: ACCOUNT, token: "t", masterKey: new Uint8Array(32), privateKey: new Uint8Array(32), publicKey: "" },
      confirmTrip,
      warmSearchIndex: async () => {},
    });
  });

  it("a date-only trip is offered, and Ignore keeps it away for good", async () => {
    const stay = doc("stay", [
      booked("in", 20, "Check-in: Casa do Rio", "hotel-booking"),
      booked("out", 24, "Check-out: Casa do Rio", "hotel-booking"),
    ]);
    const taxi = doc("taxi", [readByModel("ride", 21, "Taxi")]);
    renderTrips([stay, taxi]);
    await settle();
    expect(container.textContent).toContain("These 2 documents look like one trip");
    expect(container.textContent).toContain("stay.pdf");
    expect(container.textContent).toContain("taxi.pdf");
    click(/Ignore/);
    expect(decided(ACCOUNT, "dismissedTrips").has("anchor:stay")).toBe(true);
    await settle();
    expect(container.textContent).not.toContain("look like one trip");
    // A new receipt, even one that sorts first, does not bring it back.
    renderTrips([stay, taxi, doc("a-receipt", [readByModel("pharmacy", 22, "Pharmacy")])]);
    await settle();
    expect(container.textContent).not.toContain("look like one trip");
  });

  it("an assembled trip with a date-only member offers only that member", async () => {
    const tag = "trip:lisbon-2030-01";
    const flight = doc(
      "flight",
      [
        booked("out1", 20, "Flight TP 236 departs SFO", "itinerary"),
        booked("out2", 21, "Flight TP 236 arrives LIS", "itinerary"),
        booked("back1", 24, "Flight TP 237 departs LIS", "itinerary"),
        booked("back2", 24, "Flight TP 237 arrives SFO", "itinerary"),
      ],
      [tag],
    );
    const hotel = doc(
      "hotel",
      [booked("in", 21, "Check-in: Casa do Rio", "hotel-booking"), booked("out", 24, "Check-out: Casa do Rio", "hotel-booking")],
      [tag],
    );
    const taxi = doc("taxi", [readByModel("ride", 22, "Taxi")]);
    renderTrips([flight, hotel, taxi]);
    await settle();
    expect(container.textContent).toContain("Part of Lisbon, Jan 2030? Only the date matches.");
    const named = [...container.querySelectorAll(".trip-files button")].map((b) => b.textContent);
    expect(named).toEqual(["taxi.pdf"]);
    click(/^No$/);
    expect(decided(ACCOUNT, "tripExclusions").has(`${tag}|taxi`)).toBe(true);
    expect(decided(ACCOUNT, "dismissedTrips").size).toBe(0);
    await settle();
    expect(container.textContent).not.toContain("Part of Lisbon");
  });
});
