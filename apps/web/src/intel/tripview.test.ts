import { describe, expect, it } from "vitest";
import { email, exact, file, flights, hotel, lisbonFiles, lisbonTrip, PLANNING_NOW as NOW, TAG } from "./__fixtures__/lisbon";
import { tripsOf } from "./agenda";
import { rowsOf } from "./agendarows";
import type { Fact } from "./facts";
import { comingUp, tripSpend, tripViewOf, windowOf } from "./tripview";

describe("tripViewOf", () => {
  it("a trip reads as legs, a stay and bookings", async () => {
    const { view } = await lisbonTrip();
    expect(view).toMatchObject({
      tag: TAG,
      title: "Lisbon, Nov 2026",
      city: "Lisbon",
      code: "LIS",
      country: "PT",
      zone: "Europe/Lisbon",
      start: "2026-11-12",
      end: "2026-11-16",
      international: true,
      exact: true,
    });
    expect(view.legs.map((leg) => [leg.designator, leg.dep?.at, leg.arr?.at])).toEqual([
      ["TP 236", Date.UTC(2026, 10, 13, 2, 10), Date.UTC(2026, 10, 13, 14, 5)],
      ["TP 237", Date.UTC(2026, 10, 16, 13, 20), Date.UTC(2026, 10, 17, 1, 5)],
    ]);
    expect(view.stays).toHaveLength(1);
    expect(view.stays[0]).toMatchObject({ name: "Casa do Rio", nights: 3, fileId: "hotel" });
    expect(view.stays[0]!.checkIn).toMatchObject({ day: "2026-11-13", time: "15:00", at: Date.UTC(2026, 10, 13, 15, 0) });
    expect(view.stays[0]!.checkOut).toMatchObject({ day: "2026-11-16", time: "11:00" });
    expect(view.stays[0]!.refFactId).toBeDefined();
    expect(view.booked.map((row) => row.title)).toEqual(["Museu do Azulejo", "Fado night", "Table at Taberna da Rua"]);
    expect(view.sources).toEqual({ email: 3, pdf: 3, other: 0 });
    expect(view.cities).toEqual({ SFO: "San Francisco", LIS: "Lisbon" });
    expect(view.leaveBy.map((advice) => advice?.at)).toEqual([Date.UTC(2026, 10, 12, 23, 10), Date.UTC(2026, 10, 16, 10, 20)]);
  });

  it("a trip with no flights still has a destination and a stay", async () => {
    const files = [email("hotel", "2026-10-02", hotel(), { tags: [TAG] }), file("fado", [exact("event", "2026-11-14", "Fado night", { time: "21:00" })], { tags: [TAG] })];
    const rows = await rowsOf(files, { plans: [], dismissed: new Set(), excluded: new Set(), assembling: true }, NOW);
    const view = await tripViewOf(tripsOf(files)[0]!, rows, {});
    expect(view).toMatchObject({ city: "Lisbon", zone: "Europe/Lisbon", start: "2026-11-13", end: "2026-11-16", international: false, exact: false });
    expect(view.legs).toEqual([]);
    expect(view.stays.map((stay) => [stay.name, stay.nights])).toEqual([["Casa do Rio", 3]]);
  });

  it("a file left out of the trip is not in its view", async () => {
    const { view } = await lisbonTrip(lisbonFiles(), [file("concert", [exact("event", "2026-11-14", "Another concert", { time: "22:00" })])]);
    expect(view.booked.map((row) => row.title)).not.toContain("Another concert");
    expect(view.memberIds).not.toContain("concert");
  });

  it("an asking date never sets a time", async () => {
    // The way home was read without certainty and nobody has said yes yet;
    // the owner grouped the trip's files.
    const { view } = await lisbonTrip(lisbonFiles({ source: "label", confidence: 0.7, accepted: undefined }), [], true);
    expect(view.legs.map((leg) => leg.designator)).toEqual(["TP 236"]);
    expect(view.end).toBe("2026-11-16");
  });
});

describe("windowOf", () => {
  it("the trip as the checks read it", async () => {
    const { view } = await lisbonTrip();
    expect(windowOf(view)).toEqual({
      tag: TAG,
      start: "2026-11-12",
      end: "2026-11-16",
      international: true,
      memberIds: view.memberIds,
      firstArrival: { day: "2026-11-13", time: "14:05" },
      stays: [{ name: "Casa do Rio", checkIn: { day: "2026-11-13", time: "15:00" }, checkOut: { day: "2026-11-16" }, fileId: "hotel" }],
      overnightLegs: ["2026-11-12"],
    });
  });
});

describe("tripSpend", () => {
  it("spend sums the trip's bills and tickets per currency and names a receipt waiting", async () => {
    const taxi = email("taxi", "2026-11-13", [exact("amount", "38.00", undefined, { unit: "EUR", document: "invoice", source: "label", confidence: 0.7, confirmed: true })]);
    const { view, rows } = await lisbonTrip(lisbonFiles(), [taxi]);
    const spend = tripSpend(view, rows);
    expect(spend.sums).toEqual([{ currency: "EUR", value: "114.00" }]);
    expect(spend.count).toBe(2);
    expect(spend.waiting?.fileIds).toEqual(["taxi"]);
  });
});

describe("comingUp", () => {
  it("coming up skips the trip and photo days", async () => {
    const dentist = file("dentist", [exact("event", "2026-11-20", "Dentist", { time: "09:30" })]);
    const photo = file("beach", [], { name: "beach.jpg", mime: "image/jpeg", mtime: Date.UTC(2026, 10, 1, 12) });
    const { view, rows } = await lisbonTrip(lisbonFiles(), [dentist, photo]);
    expect(comingUp(rows, view, NOW, 2).map((row) => row.title)).toEqual(["Dentist"]);
    expect(comingUp(rows, undefined, NOW, 2).map((row) => row.title)).toEqual(["San Francisco to Lisbon", "Check in · Casa do Rio"]);
  });
});

describe("where a trip goes", () => {
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

  it("a connecting trip's destination is where it stays, not where it changes planes", async () => {
    const { view, plan } = await lisbonTrip(connecting());
    expect(plan.destination).toBe("Lisbon");
    expect(view).toMatchObject({ city: "Lisbon", code: "LIS", zone: "Europe/Lisbon" });
  });

  it("a trip to a city whose name several airports share takes no wrong airport", async () => {
    const files = [
      email("hotel", "2026-10-02", [
        exact("event", "2026-11-14", "Check-in: Harbour View", { document: "hotel-booking", time: "15:00", zone: "+11:00" }),
        exact("event", "2026-11-18", "Check-out: Harbour View", { document: "hotel-booking", time: "10:00", zone: "+11:00" }),
      ], { tags: ["trip:sydney-2026-11"] }),
      file("ferry", [exact("event", "2026-11-15", "Ferry to Manly", { time: "11:00", zone: "+11:00" })], { tags: ["trip:sydney-2026-11"] }),
    ];
    const rows = await rowsOf(files, { plans: [], dismissed: new Set(), excluded: new Set(), assembling: true }, NOW);
    const view = await tripViewOf(tripsOf(files)[0]!, rows, {});
    expect(view.code).not.toBe("YQY");
    expect(view.zone).toBe("+11:00");
    expect(view.stays[0]!.checkIn!.at).toBe(Date.UTC(2026, 10, 14, 4, 0));
  });
});

describe("the trip's own days", () => {
  it("an owner-added date at home does not stretch the trip", async () => {
    const dinner = file("farewell", [exact("event", "2026-11-11", "Farewell dinner", { document: "dining", time: "19:00" })]);
    const { view } = await lisbonTrip([...lisbonFiles(), dinner], [], true);
    expect([view.start, view.end]).toEqual(["2026-11-12", "2026-11-16"]);
  });
});

describe("stays, duplicates and amounts", () => {
  const said = (value: string, time: string, subject: Fact["subject"], label: string): Fact => ({
    id: `event:${value} ${label.toLowerCase()} ${time}`,
    kind: "event",
    document: "hotel-booking",
    value,
    time,
    label,
    source: "model",
    confidence: 0.45,
    confirmed: true,
    subject,
  });

  it("a stay the model read pairs even when the check-out names no place", async () => {
    const guesthouse = email("guesthouse", "2026-10-02", [
      said("2026-11-13", "15:00", { role: "check-in", place: "Casa Azulejo Guesthouse" }, "Room ready"),
      said("2026-11-16", "11:00", { role: "check-out" }, "Key at the desk"),
    ]);
    const files = [...lisbonFiles().filter((member) => member.id !== "hotel"), guesthouse];
    const { view } = await lisbonTrip(files, [], true);
    expect(view.stays.map((stay) => [stay.name, stay.nights])).toEqual([["Casa Azulejo Guesthouse", 3]]);
  });

  it("a booking told twice reads once", async () => {
    const reminder = email("reminder", "2026-11-10", hotel());
    const change = email("change", "2026-10-20", flights());
    const { view } = await lisbonTrip([...lisbonFiles(), reminder, change], [], true);
    expect(view.legs.map((leg) => leg.designator)).toEqual(["TP 236", "TP 237"]);
    expect(view.stays.map((stay) => stay.name)).toEqual(["Casa do Rio"]);
  });

  it("a ticket for several days counts once", async () => {
    const pass = file("citypass", [
      exact("event", "2026-11-14", "City pass", { document: "event-ticket", time: "09:00" }),
      exact("event", "2026-11-15", "City pass", { document: "event-ticket", time: "09:00" }),
      exact("amount", "40.00", undefined, { unit: "EUR", document: "event-ticket" }),
    ]);
    const { view, rows } = await lisbonTrip([...lisbonFiles(), pass], [], true);
    expect(tripSpend(view, rows).sums).toEqual([{ currency: "EUR", value: "154.00" }]);
  });

  it("coming up skips dates that wait for a yes", async () => {
    const maybe = file("maybe", [{ id: "event:maybe", kind: "event", document: "other", value: "2026-11-20", time: "09:30", label: "Dentist", source: "label", confidence: 0.7 }]);
    const { view, rows } = await lisbonTrip(lisbonFiles(), [maybe]);
    expect(comingUp(rows, view, NOW, 3).map((row) => row.title)).not.toContain("Dentist");
  });
});

describe("across the date line", () => {
  it("a flight that lands two days after it left spends both nights on the plane", async () => {
    const files = [
      email("booking", "2026-10-01", [
        exact("event", "2026-11-12", "Flight QF 74 departs SFO", { time: "21:55" }),
        exact("event", "2026-11-14", "Flight QF 74 arrives SYD", { time: "06:35" }),
      ]),
      email("hotel", "2026-10-02", [
        exact("event", "2026-11-14", "Check-in: Harbour View", { document: "hotel-booking", time: "14:00" }),
        exact("event", "2026-11-18", "Check-out: Harbour View", { document: "hotel-booking", time: "10:00" }),
      ]),
    ].map((member) => ({ ...member, tags: ["trip:sydney-2026-11"] }));
    const rows = await rowsOf(files, { plans: [], dismissed: new Set(), excluded: new Set(), assembling: true }, NOW);
    const view = await tripViewOf(tripsOf(files)[0]!, rows, {});
    expect(windowOf(view).overnightLegs).toEqual(["2026-11-12", "2026-11-13"]);
  });
});
