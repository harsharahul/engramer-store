// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { decide } from "../decisions";
import { withExactAcceptance, type Fact } from "../intel/facts";
import { useStore, type FileEntry } from "../store";
import { HeadsUp, TripMirror } from "./HeadsUp";

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

/** Lets the plans' asynchronous work land; the airport table loads on first use. */
async function settle() {
  await act(async () => {
    await import("../intel/tables/airports.json");
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

function renderMirror(onOpenTimeline: () => void) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<TripMirror onOpenTimeline={onOpenTimeline} />));
}

const click = (label: RegExp) => {
  const button = [...container.querySelectorAll("button")].find((b) => label.test(b.textContent ?? ""));
  act(() => {
    button!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
};

describe("trips in Files", () => {
  beforeEach(() => {
    localStorage.clear();
    useStore.setState({
      session: { email: ACCOUNT, token: "t", masterKey: new Uint8Array(32), privateKey: new Uint8Array(32), publicKey: "" },
    });
  });

  it("the trip card in Files is one line now", async () => {
    const stay = doc("stay", [
      booked("in", 20, "Check-in: Casa do Rio", "hotel-booking"),
      booked("out", 24, "Check-out: Casa do Rio", "hotel-booking"),
    ]);
    const taxi = doc("taxi", [readByModel("ride", 21, "Taxi")]);
    useStore.setState({ files: new Map([stay, taxi].map((file) => [file.id, file])) });
    const onOpenTimeline = vi.fn();
    renderMirror(onOpenTimeline);
    await settle();
    expect(container.textContent).toBe("1 trip waits for a yes on the Timeline.Open Timeline");
    expect(container.textContent).not.toContain("Group as");
    click(/Open Timeline/);
    expect(onOpenTimeline).toHaveBeenCalled();
    // Refused on the Timeline, it is gone from Files too.
    act(() => decide(ACCOUNT, "dismissedTrips", ["anchor:stay"]));
    await settle();
    expect(container.textContent).toBe("");
  });
});
