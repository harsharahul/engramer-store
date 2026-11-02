// @vitest-environment jsdom
process.env.TZ = "America/Los_Angeles";

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { email, exact, file, hotel, lisbonFiles, lisbonTrip, TAG } from "../intel/__fixtures__/lisbon";
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

describe("the trip's cards from soon to the last day", () => {
  const LIS = "Europe/Lisbon";
  const pass = file("pass", [
    { id: "event:pass", kind: "event", document: "boarding-pass", value: "2026-11-12", label: "Flight TP 236 SFO to LIS", source: "barcode", confidence: 0.6 },
  ]);
  const seated = () =>
    lisbonFiles().map((member) =>
      member.id !== "booking"
        ? member
        : {
            ...member,
            facts: member.facts.map((fact) =>
              fact.label === "Flight TP 236 departs SFO"
                ? { ...fact, subject: { role: "depart" as const, mode: "flight" as const, carrier: "TP", number: "236", code: "SFO", seat: "14A", gate: "B12", boardingTime: "17:20" } }
                : fact,
            ),
          },
    );
  let withPass: typeof trip;
  let seatedTrip: typeof trip;
  let oneWay: typeof trip;
  beforeAll(async () => {
    withPass = await lisbonTrip(lisbonFiles(), [pass]);
    seatedTrip = await lisbonTrip(seated(), [pass]);
    oneWay = await lisbonTrip(
      lisbonFiles().map((member) => (member.id === "booking" ? { ...member, facts: member.facts.filter((fact) => !/TP 237/.test(fact.label ?? "")) } : member)),
      [],
      true,
    );
  });
  const headers = () => [...container.querySelectorAll(".tln-hd")].map((hd) => hd.firstChild?.textContent);
  const evidence = (rows: { id: string; full?: string; link?: string }[]) => vi.fn(async () => rows);

  it("soon shows check-in, the boarding pass to come, what is ready and the trip", () => {
    useStore.setState({ factEvidence: evidence([]) });
    mount(instantOf("2026-11-11", "09:30", LA));
    expect(headers()).toEqual(["Check-in", "Boarding pass", "Ready for this trip", "The trip"]);
    const checkIn = card("Check-in")!;
    expect(checkIn.querySelector(".tln-title")!.textContent).toBe("Opens Wed 11 Nov at 18:10");
    expect(checkIn.textContent).toContain("Online check-in usually opens 24 hours before departure.");
    expect(card("Boarding pass")!.textContent).toContain("It arrives in your mail after check-in, and shows up here on its own.");
  });

  it("once check-in opens the card says so", () => {
    useStore.setState({ factEvidence: evidence([]) });
    mount(instantOf("2026-11-11", "19:00", LA));
    const open = card("Check-in is open")!;
    expect(open.querySelector(".tln-title")!.textContent).toBe("TP 236 · Thu 12 Nov 18:10");
    expect(open.textContent).toContain("It opened at 18:10 on Wed 11 Nov.");
    click([...open.querySelectorAll("button")].find((button) => button.textContent === "Open booking"));
    expect(onInspect).toHaveBeenLastCalledWith("booking");
  });

  it("travel day shows when to leave, the boarding pass and the landing", () => {
    useStore.setState({ factEvidence: evidence([]) });
    mount(instantOf("2026-11-12", "13:30", LA), withPass);
    expect(headers()).toEqual(["Leave for SFO by", "Boarding pass", "When you land"]);
    const leave = card("Leave for SFO by")!;
    expect(leave.querySelector(".tln-big-local")!.textContent).toBe("15:10");
    expect(leave.textContent).toContain("in 1 h 40 m · 3 hours before an international departure");
    expect(kv(card("When you land"))).toEqual({ "Check-in": "Fri 13 Nov · from 15:00", Landing: "14:05 · 55 min before check-in opens" });
  });

  it("Show pass opens the stored pass", () => {
    useStore.setState({ factEvidence: evidence([]) });
    mount(instantOf("2026-11-12", "13:30", LA), withPass);
    const mini = card("Boarding pass")!.querySelector(".tln-pmini")!;
    expect(mini.textContent).toContain("BOARDING PASS");
    expect(mini.textContent).toContain("TP 236 · Thu 12 Nov");
    expect(mini.querySelector(".tln-pmini-cells")).toBeNull();
    click([...card("Boarding pass")!.querySelectorAll("button")].find((button) => button.textContent === "Show pass"));
    expect(onOpen).toHaveBeenCalledWith("pass");
  });

  it("seat and gate show only when the booking gives them", () => {
    useStore.setState({ factEvidence: evidence([]) });
    mount(instantOf("2026-11-12", "13:30", LA), seatedTrip);
    expect(kv(card("Boarding pass")!.querySelector(".tln-pmini-cells") ?? undefined)).toEqual({ Boarding: "17:20", Gate: "B12", Seat: "14A" });
  });

  it("in the air shows the flight's progress, the landing and tomorrow in the city", () => {
    useStore.setState({ factEvidence: evidence([]) });
    mount(instantOf("2026-11-13", "06:00", LIS));
    expect(headers()).toEqual(["In the air", "When you land", "Tomorrow in Lisbon"]);
    const air = card("In the air")!;
    expect(air.querySelector(".tln-hd-aside")!.textContent).toBe("TP 236");
    expect(air.textContent).toContain("Lands 14:05 Lisbon time · in 8 h 05 m");
    expect(air.textContent).toContain("Works offline. Everything on this screen is on this device.");
    expect((air.querySelector(".tln-prog-fill") as HTMLElement).style.width).toBe("32%");
    expect(card("Tomorrow in Lisbon")!.textContent).toContain("Museu do Azulejo");
  });

  it("staying shows the stay, today in the city, the flight home and the spend", () => {
    useStore.setState({ factEvidence: evidence([]) });
    mount(instantOf("2026-11-14", "15:42", LIS));
    expect(headers()).toEqual(["Staying", "Today · Sat 14 Nov", "Flight home", "Spent so far"]);
    const stay = card("Staying")!;
    expect(stay.querySelector(".tln-hd-aside")!.textContent).toBe("Night 2 of 3");
    expect(stay.querySelector(".tln-title")!.textContent).toBe("Casa do Rio");
    expect(kv(stay)).toMatchObject({ "Check-out": "Mon 16 Nov · 11:00" });
    expect(stay.querySelector("a")!.getAttribute("href")).toBe("https://maps.apple.com/?q=Casa%20do%20Rio%2C%20Lisbon");
    click([...stay.querySelectorAll("button")].find((button) => button.textContent === "Open confirmation"));
    expect(onInspect).toHaveBeenLastCalledWith("hotel");
    expect(card("Today · Sat 14 Nov")!.textContent).toContain("Fado night");
    const home = card("Flight home")!;
    expect(home.querySelector(".tln-hd-aside")!.textContent).toBe("Mon 16 Nov");
    expect(kv(home)).toEqual({ "Leave by": "10:20 · 3 hours before departure", "Check-in": "opens Sun 13:20" });
  });

  it("Reveal shows the full booking reference and Hide masks it again", async () => {
    const reference = trip.files.find((member) => member.id === "hotel")!.facts.find((fact) => fact.kind === "identifier")!;
    useStore.setState({ factEvidence: evidence([{ id: reference.id, full: "CR-7741-9C1D" }]) });
    mount(instantOf("2026-11-14", "15:42", LIS));
    const stay = () => card("Staying")!;
    expect(kv(stay()).Booking).toContain("…9C1D");
    await act(async () => {
      [...stay().querySelectorAll("button")].find((button) => button.textContent === "Reveal")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(kv(stay()).Booking).toContain("CR-7741-9C1D");
    click([...stay().querySelectorAll("button")].find((button) => button.textContent === "Hide"));
    expect(kv(stay()).Booking).toContain("…9C1D");
  });

  it("the last day shows check-out, when to leave and what the trip cost", () => {
    useStore.setState({ factEvidence: evidence([]) });
    mount(instantOf("2026-11-16", "08:30", LIS));
    expect(headers()).toEqual(["Check out by", "Leave for LIS by", "Boarding pass", "Spent on this trip"]);
    const out = card("Check out by")!;
    expect(out.querySelector(".tln-big-local")!.textContent).toBe("11:00");
    expect(out.textContent).toContain("in 2 h 30 m · Casa do Rio");
    expect(card("Leave for LIS by")!.querySelector(".tln-big-local")!.textContent).toBe("10:20");
  });

  it("no return flight, no flight home card", () => {
    useStore.setState({ factEvidence: evidence([]) });
    mount(instantOf("2026-11-14", "15:42", LIS), oneWay);
    expect(headers()).not.toContain("Flight home");
    expect(headers()[0]).toBe("Staying");
  });
});

describe("the cards as the prototype draws them", () => {
  const LIS = "Europe/Lisbon";

  it("a card's values are not drawn as its labels", () => {
    mount(PLANNING);
    const cells = [...card("The trip")!.querySelectorAll(".tln-kv > *")];
    expect(cells.filter((_, i) => i % 2 === 0).every((cell) => cell.tagName === "SPAN")).toBe(true);
    expect(cells.filter((_, i) => i % 2 === 1).every((cell) => cell.tagName === "DIV")).toBe(true);
  });

  it("the hotel's cards wear the hotel's look, and landing names the hotel", () => {
    useStore.setState({ factEvidence: vi.fn(async () => []) });
    mount(instantOf("2026-11-12", "13:30", LA));
    const land = card("When you land")!;
    expect(land.classList.contains("tln-card-stay")).toBe(true);
    expect(land.querySelector(".tln-title")!.textContent).toBe("Casa do Rio");
  });

  it("a booking reference shows only its last characters until revealed", () => {
    useStore.setState({ factEvidence: vi.fn(async () => []) });
    mount(instantOf("2026-11-14", "15:42", LIS));
    expect(kv(card("Staying")).Booking).toContain("…9C1D");
  });
});

describe("the cards say only what is true now", () => {
  const LIS = "Europe/Lisbon";
  const headers = () => [...container.querySelectorAll(".tln-hd")].map((hd) => hd.firstChild?.textContent);
  const connecting = () => [
    email("booking", "2026-10-01", [
      exact("event", "2026-11-12", "Flight AA 10 departs SFO", { time: "08:00" }),
      exact("event", "2026-11-12", "Flight AA 10 arrives JFK", { time: "16:30" }),
      exact("event", "2026-11-12", "Flight TP 202 departs JFK", { time: "18:30" }),
      exact("event", "2026-11-13", "Flight TP 202 arrives LIS", { time: "06:40" }),
      exact("event", "2026-11-16", "Flight TP 201 departs LIS", { time: "11:00" }),
      exact("event", "2026-11-16", "Flight TP 201 arrives JFK", { time: "13:30" }),
      exact("event", "2026-11-16", "Flight AA 11 departs JFK", { time: "15:30" }),
      exact("event", "2026-11-16", "Flight AA 11 arrives SFO", { time: "19:00" }),
      exact("identifier", "4F2K", "Confirmation number", { masked: "4F2K" }),
    ]),
    email("hotel", "2026-10-02", hotel()),
  ];
  const rail = () => [
    email("tickets", "2026-10-01", [
      exact("event", "2026-11-12", "Train IC 521 departs Porto Campanha", { time: "08:05" }),
      exact("event", "2026-11-12", "Train IC 521 arrives Lisboa Santa Apolonia", { time: "10:55" }),
      exact("event", "2026-11-16", "Train IC 530 departs Lisboa Santa Apolonia", { time: "17:00" }),
      exact("event", "2026-11-16", "Train IC 530 arrives Porto Campanha", { time: "19:50" }),
    ]),
    email("hotel", "2026-10-02", hotel()),
  ];

  it("flying home shows no landing at the destination", () => {
    useStore.setState({ factEvidence: vi.fn(async () => []) });
    mount(instantOf("2026-11-16", "15:00", LIS));
    expect(headers()).toEqual(["In the air"]);
  });

  it("a leave-by or check-out time already past is gone", () => {
    useStore.setState({ factEvidence: vi.fn(async () => []) });
    mount(instantOf("2026-11-12", "17:00", LA));
    expect(headers()).not.toContain("Leave for SFO by");
    act(() => root.unmount());
    container.remove();
    mount(instantOf("2026-11-16", "12:30", LIS));
    expect(headers()).not.toContain("Check out by");
    expect(headers()).not.toContain("Leave for LIS by");
  });

  it("the trip card names the first flight home", async () => {
    const connected = await lisbonTrip(connecting());
    mount(PLANNING, connected);
    expect(kv(card("The trip")).Flights).toBe("AA 10 out Thu 08:00 · TP 201 home Mon 11:00");
  });

  it("a journey by train asks nothing about check-in or boarding passes", async () => {
    useStore.setState({ factEvidence: vi.fn(async () => []) });
    const byTrain = await lisbonTrip(rail(), [], true);
    mount(instantOf("2026-11-11", "09:00", LIS), byTrain);
    expect(headers()).not.toContain("Check-in");
    expect(headers()).not.toContain("Boarding pass");
    act(() => root.unmount());
    container.remove();
    mount(instantOf("2026-11-14", "12:00", LIS), byTrain);
    expect(headers()).toContain("Train home");
  });

  it("a flight that lands the next day shows +1 on the hero", () => {
    useStore.setState({ factEvidence: vi.fn(async () => []) });
    mount(instantOf("2026-11-13", "06:00", LIS));
    expect(card("In the air")!.querySelector(".tln-tm sup")!.textContent).toBe("+1");
  });
});

describe("the destination's days count down only to real, confirmed times", () => {
  const LIS = "Europe/Lisbon";
  it("an untimed row says today, and an unconfirmed one gets no countdown", async () => {
    useStore.setState({ factEvidence: vi.fn(async () => []) });
    const tram = file("tram", [exact("event", "2026-11-14", "Tram 28 tour", { document: "event-ticket" })]);
    const tour = file("tour", [{ id: "event:tour", kind: "event", document: "other", value: "2026-11-14", time: "18:00", label: "Walking tour", source: "label", confidence: 0.7 }]);
    const withDay = await lisbonTrip([...lisbonFiles(), tram], [tour], true);
    mount(instantOf("2026-11-14", "15:42", LIS), withDay);
    const rows = [...card("Today · Sat 14 Nov")!.querySelectorAll(".tln-trow")].map((row) => row.textContent);
    expect(rows.find((row) => row!.includes("Tram 28 tour"))).toMatch(/today$/);
    expect(rows.find((row) => row!.includes("Walking tour"))).toMatch(/not confirmed$/);
  });
});

describe("every value opens its source", () => {
  const LIS = "Europe/Lisbon";
  const press = (root: Element, text: string) =>
    click([...root.querySelectorAll("button")].find((button) => button.textContent?.includes(text)));

  it("the trip card's flights, stay and bookings open their files", () => {
    mount(PLANNING);
    const summary = card("The trip")!;
    press(summary, "TP 236 out");
    expect(onInspect).toHaveBeenLastCalledWith("booking");
    press(summary, "Casa do Rio · 3 nights");
    expect(onInspect).toHaveBeenLastCalledWith("hotel");
    press(summary, "Fado night");
    expect(onInspect).toHaveBeenLastCalledWith("fado");
  });

  it("a receipt waiting to join opens before it is added", () => {
    mount(PLANNING);
    press(card("Spent so far")!, "taxi");
    expect(onInspect).toHaveBeenLastCalledWith("taxi");
    expect(addToTrip).not.toHaveBeenCalled();
  });

  it("leave-by and the flight in the air open the booking", () => {
    useStore.setState({ factEvidence: vi.fn(async () => []) });
    mount(instantOf("2026-11-12", "13:30", LA));
    press(card("Leave for SFO by")!, "15:10");
    expect(onInspect).toHaveBeenLastCalledWith("booking");
    act(() => root.unmount());
    container.remove();
    mount(instantOf("2026-11-13", "06:00", LIS));
    press(card("In the air")!, "TP 236");
    expect(onInspect).toHaveBeenLastCalledWith("booking");
  });

  it("a stay with no name or address offers no directions", async () => {
    useStore.setState({ factEvidence: vi.fn(async () => []) });
    const said = (value: string, time: string, role: "check-in" | "check-out", label: string) => ({
      id: `event:${value} ${label.toLowerCase()} ${time}`,
      kind: "event" as const,
      document: "hotel-booking" as const,
      value,
      time,
      label,
      source: "model" as const,
      confidence: 0.45,
      confirmed: true,
      subject: { role },
    });
    const room = email("room", "2026-10-02", [said("2026-11-13", "15:00", "check-in", "Room ready"), said("2026-11-16", "11:00", "check-out", "Leave the key")]);
    const unnamed = await lisbonTrip([...lisbonFiles().filter((member) => member.id !== "hotel"), room], [], true);
    mount(instantOf("2026-11-14", "15:42", LIS), unnamed);
    expect(card("Staying")!.querySelector("a")).toBeNull();
  });
});

describe("cards that would say nothing", () => {
  it("nothing spent and nothing waiting shows no spend card", async () => {
    const unpaid = lisbonFiles()
      .filter((member) => member.id !== "receipt")
      .map((member) => (member.id === "museum" ? { ...member, facts: member.facts.filter((fact) => fact.kind !== "amount") } : member));
    mount(PLANNING, await lisbonTrip(unpaid));
    expect([...container.querySelectorAll(".tln-hd")].map((hd) => hd.textContent)).not.toContain("Spent so far");
  });

  it("a departure with no time reads no evidence for a check-in it cannot have", async () => {
    const factEvidence = vi.fn(async () => []);
    useStore.setState({ factEvidence });
    const untimed = lisbonFiles().map((member) =>
      member.id !== "booking" ? member : { ...member, facts: member.facts.map(({ time: _time, ...fact }) => fact) },
    );
    mount(instantOf("2026-11-11", "09:00", LA), await lisbonTrip(untimed));
    expect(factEvidence).not.toHaveBeenCalled();
  });
});
