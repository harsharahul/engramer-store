// @vitest-environment jsdom
process.env.TZ = "America/Los_Angeles";

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { email, exact, file, lisbonFiles, lisbonTrip, TAG } from "../intel/__fixtures__/lisbon";
import type { AgendaRow, RowFile } from "../intel/agendarows";
import { instantOf } from "../intel/instants";
import { momentOf } from "../intel/moments";
import type { TripView } from "../intel/tripview";
import { useStore } from "../store";
import { TripCards } from "./TripCards";

const LA = "America/Los_Angeles";
let container: HTMLDivElement;
let root: Root;
const onInspect = vi.fn();
const onOpen = vi.fn();
const onToast = vi.fn();
const addToTrip = vi.fn(async () => {});

const passport = file("passport", [exact("expiry", "2029-03-20", "Date of expiry", { document: "passport", source: "mrz" })]);
const dentist = file("dentist", [exact("event", "2026-11-20", "Dentist", { time: "09:30" })]);
const taxi = email("taxi", "2026-11-13", [exact("amount", "38.00", undefined, { unit: "EUR", document: "invoice", source: "label", confidence: 0.7, confirmed: true })]);
const photos = ["13", "13", "14", "14", "14", "15", "15"].map((day, i) =>
  file(`photo${i}`, [], { name: `photo${i}.jpg`, mime: "image/jpeg", mtime: Date.UTC(2026, 10, Number(day), 12, i) }),
);

let trip: { view: TripView; rows: AgendaRow[]; files: RowFile[] };
let alone: { view: TripView; rows: AgendaRow[]; files: RowFile[] };
beforeAll(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  trip = await lisbonTrip(lisbonFiles(), [passport, dentist, taxi, ...photos]);
  alone = await lisbonTrip(lisbonFiles().filter((member) => member.id !== "hotel"));
});

beforeEach(() => {
  for (const fn of [onInspect, onOpen, onToast, addToTrip]) {
    fn.mockClear();
  }
  useStore.setState({ addToTrip });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

function mount(now: number, of = trip) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root.render(
      <TripCards moment={momentOf([of.view], now)} rows={of.rows} files={of.files} now={now} onInspect={onInspect} onOpen={onOpen} onToast={onToast} />,
    ),
  );
}

const card = (title: string) => [...container.querySelectorAll(".tln-card")].find((el) => el.querySelector(".tln-hd")?.textContent?.startsWith(title));
const kv = (el: Element | undefined) => {
  const cells = [...(el?.querySelectorAll(".tln-kv > *") ?? [])].map((cell) => cell.textContent);
  return Object.fromEntries(cells.flatMap((cell, i) => (i % 2 === 0 ? [[cell, cells[i + 1]]] : [])));
};
const click = (el: Element | null | undefined) => act(() => el!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
const PLANNING = instantOf("2026-10-26", "10:00", LA);
const HOME = instantOf("2026-11-18", "19:00", LA);

describe("the trip's cards while planning", () => {
  it("planning shows the trip, its checks, its spend and what else is coming", () => {
    mount(PLANNING);
    expect([...container.querySelectorAll(".tln-hd")].map((hd) => hd.textContent)).toEqual(["The trip", "Checks", "Spent so far", "Also coming up"]);
  });

  it("the trip card says where, when, the flights, the stay and the bookings", () => {
    mount(PLANNING);
    const summary = card("The trip");
    expect(summary!.querySelector(".tln-title")!.textContent).toBe("Lisbon · 12-16 Nov");
    expect(kv(summary)).toEqual({
      Flights: "TP 236 out Thu 18:10 · TP 237 home Mon 13:20",
      Stay: "Casa do Rio · 3 nights",
      Booked: "Museu do Azulejo, Fado night, Table at Taberna da Rua",
    });
    expect(summary!.querySelector(".tln-evb-exact")!.textContent).toBe("FOUND IN YOUR MAIL");
    expect(summary!.querySelector(".tln-found")!.textContent).toContain("3 emails and 3 PDFs, joined on their own");
  });

  it("checks show OK and NOTE lines, and each opens its document", () => {
    mount(PLANNING);
    const lines = [...card("Checks")!.querySelectorAll(".tln-check")];
    expect(lines.map((line) => [line.querySelector(".tln-ck")!.textContent, line.querySelector(".tln-check-title")!.textContent])).toEqual([
      ["OK", "Passport valid to Mar 2029"],
      ["OK", "Every night has a place to sleep"],
      ["NOTE", "You land at 14:05; check-in opens at 15:00"],
    ]);
    click(lines[0]);
    expect(onInspect).toHaveBeenLastCalledWith("passport");
    click(lines[1]);
    expect(onInspect).toHaveBeenLastCalledWith("hotel");
  });

  it("spend shows the sums and a receipt waiting, and Add puts it in the trip", () => {
    mount(PLANNING);
    const spend = card("Spent so far")!;
    expect(spend.querySelector(".tln-money")!.textContent).toBe("EUR114.00");
    expect(spend.textContent).toContain("Read from 2 receipts and bookings · never converted");
    expect(spend.querySelector(".tln-suggest")!.textContent).toContain("1 receipt waits: taxi EUR 38.00");
    click([...spend.querySelectorAll("button")].find((button) => button.textContent === "Add to trip"));
    expect(addToTrip).toHaveBeenCalledWith(["taxi"], TAG);
    expect(onToast).toHaveBeenCalledWith("Added to Lisbon. The trip total is updated.");
  });

  it("what else is coming lists the next things outside the trip", () => {
    mount(PLANNING);
    expect(card("Also coming up")!.textContent).toContain("Dentist");
  });

  it("a trip with no hotel shows no stay line", () => {
    mount(PLANNING, alone);
    expect(kv(card("The trip"))).not.toHaveProperty("Stay");
  });
});

describe("the trip's cards back home", () => {
  it("back home shows the recap and the photos", () => {
    mount(HOME);
    expect([...container.querySelectorAll(".tln-hd")].map((hd) => hd.textContent)).toEqual([
      "Welcome back",
      "7 photos from these days",
      "Spent on this trip",
      "Also coming up",
    ]);
    const recap = card("Welcome back")!;
    expect(recap.querySelector(".tln-title")!.textContent).toBe("Lisbon · 12-16 Nov");
    expect([...recap.querySelectorAll(".tln-stats > div")].map((stat) => `${stat.querySelector("b")!.textContent} ${stat.querySelector("span")!.textContent}`)).toEqual([
      "5 days",
      "2 flights",
      "3 nights",
      "3 bookings",
    ]);
    const tiles = [...card("7 photos")!.querySelectorAll(".tln-pgrid > *")];
    expect(tiles).toHaveLength(6);
    expect(tiles[5]!.textContent).toBe("+2");
    click(tiles[0]);
    expect(onOpen).toHaveBeenCalledWith("photo0");
  });
});
