/**
 * One trip followed from raw mail to the Timeline, through the real readers
 * and the real model of trips and rows. Each stage's own tests can pass
 * while the chain between them breaks; this is the test of the chain. The
 * same trip arrives three ways (booking data, a model reading of plain
 * words, a boarding pass barcode) and must read the same.
 */
import { describe, expect, it } from "vitest";
import * as mail from "./__fixtures__/chain/mail";
import { planTrips, tripsOf, type TripPlan } from "./agenda";
import { rowsOf, type AgendaRow, type RowContext, type RowFile } from "./agendarows";
import { bcbpFacts } from "./bcbp";
import { factId, maskTail, mergeFacts, withExactAcceptance, type Fact } from "./facts";
import { proposedFacts } from "./modelfacts";
import { scanForFacts } from "./scan";

const EMAIL = "application/vnd.engram.email+json";
const NOW = Date.UTC(2026, 9, 26, 17); // Mon 26 Oct 2026, 10:00 in San Francisco
const none: RowContext = { plans: [], dismissed: new Set(), excluded: new Set(), assembling: true };

/** An email read as storing it reads it. */
async function booking(raw: string): Promise<Fact[]> {
  return (await scanForFacts({ name: "Your booking.email", mime: EMAIL, raw, text: "Your trip to Lisbon is booked." })).facts;
}

/** A boarding pass as storing it leaves it: the reference kept to its tail. */
function pass(): Fact[] {
  return bcbpFacts(mail.PASS_PAYLOAD, mail.PASS_STORED_AT).map((fact) => {
    if (fact.kind !== "identifier") {
      return withExactAcceptance(fact);
    }
    const tail = maskTail(fact.value);
    return withExactAcceptance({ ...fact, id: factId("identifier", tail), value: tail, masked: tail });
  });
}

/** The guesthouse email as the on-device model reads it, before or after the owner's yes. */
function guesthouse(confirmed: boolean): Fact[] {
  return proposedFacts(mail.GUESTHOUSE_READING, mail.GUESTHOUSE_TEXT).map((fact) => (confirmed ? { ...fact, confirmed: true } : fact));
}

const file = (id: string, facts: Fact[], email = true): RowFile => ({
  id,
  name: email ? `${id}.email` : `${id}.pdf`,
  mime: email ? EMAIL : "application/pdf",
  mtime: Date.UTC(2026, 9, 1),
  tags: [],
  facts,
  trashed: false,
  ...(email ? { mail: { subject: `${id} confirmation`, from: "Sender", date: Date.UTC(2026, 9, 1) } } : {}),
});

/** Plans the trip, writes its tag on the members as assembly does, and reads the rows. */
async function timeline(files: RowFile[]): Promise<{ plan: TripPlan; rows: AgendaRow[]; files: RowFile[] }> {
  const plans = await planTrips(files, NOW);
  expect(plans).toHaveLength(1);
  const plan = plans[0]!;
  const tagged = files.map((member) => (plan.exact.has(member.id) ? { ...member, tags: [plan.tag] } : member));
  const rows = await rowsOf(tagged, { ...none, plans: [plan] }, NOW);
  return { plan, rows, files: tagged };
}

const journey = (rows: AgendaRow[]) =>
  rows.filter((row) => row.kind === "flight").map((row) => [row.flight!.number, row.at, row.endAt, row.flight!.passFileId]);
const stays = (rows: AgendaRow[]) => rows.filter((row) => row.kind === "stay").map((row) => [row.title, row.day, row.time, row.ask ?? false]);

describe("one trip, from raw mail to the Timeline's rows", () => {
  it("a trip reads the same from booking data, a model reading and a boarding pass", async () => {
    const fromData = await timeline([file("booking", await booking(mail.BOOKING_WITH_HOTEL)), file("pass", pass(), false)]);
    const fromWords = await timeline([
      file("booking", await booking(mail.BOOKING_FLIGHTS_ONLY)),
      file("guesthouse", guesthouse(true)),
      file("pass", pass(), false),
    ]);

    const flights = [
      ["TP 236", Date.UTC(2026, 10, 13, 2, 10), Date.UTC(2026, 10, 13, 14, 5), "pass"],
      ["TP 237", Date.UTC(2026, 10, 16, 13, 20), Date.UTC(2026, 10, 17, 1, 5), undefined],
    ];
    expect(journey(fromData.rows)).toEqual(flights);
    expect(journey(fromWords.rows)).toEqual(flights);

    expect(stays(fromData.rows)).toEqual([
      ["Check in · Casa do Rio", "2026-11-13", "15:00", false],
      ["Check out · Casa do Rio", "2026-11-16", "11:00", false],
    ]);
    expect(stays(fromWords.rows)).toEqual([
      ["Check in · Casa Azulejo", "2026-11-13", "15:00", false],
      ["Check out · Casa Azulejo", "2026-11-16", "11:00", false],
    ]);

    expect(fromData.plan).toMatchObject({ destination: "Lisbon", start: "2026-11-12", end: "2026-11-16" });
    expect(fromWords.plan.exact.get("guesthouse")).toBe("away");
    expect(fromWords.plan.exact.get("pass")).toBe("reference");
    expect(tripsOf(fromWords.files)[0]!.members.map((member) => member.id).sort()).toEqual(["booking", "guesthouse", "pass"]);
    // The pass's inferred date asks nothing: its flight is booked.
    expect(fromData.rows.filter((row) => row.ask)).toEqual([]);
  });

  it("the guesthouse the model read asks first, and is a stay after the yes", async () => {
    expect(stays(await rowsOf([file("guesthouse", guesthouse(false))], none, NOW))).toEqual([
      ["Check in · Casa Azulejo", "2026-11-13", "15:00", true],
      ["Check out · Casa Azulejo", "2026-11-16", "11:00", true],
    ]);
    expect(stays(await rowsOf([file("guesthouse", guesthouse(true))], none, NOW))).toEqual([
      ["Check in · Casa Azulejo", "2026-11-13", "15:00", false],
      ["Check out · Casa Azulejo", "2026-11-16", "11:00", false],
    ]);
  });

  it("reading the same mail twice changes nothing", async () => {
    const first = await booking(mail.BOOKING_WITH_HOTEL);
    const second = await booking(mail.BOOKING_WITH_HOTEL);
    expect(second).toEqual(first);
    expect(mergeFacts(first, second)).toEqual(mergeFacts([], first));
  });
});
