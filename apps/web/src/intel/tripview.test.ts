import { describe, expect, it } from "vitest";
import { email, exact, file, hotel, lisbonFiles, lisbonTrip, PLANNING_NOW as NOW, TAG } from "./__fixtures__/lisbon";
import { tripsOf } from "./agenda";
import { rowsOf } from "./agendarows";
import { comingUp, tripSpend, tripViewOf } from "./tripview";

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
