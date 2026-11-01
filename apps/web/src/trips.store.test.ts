import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKey, ready, secretBoxSeal } from "@engramer/crypto";
import type { FileDto } from "./api";

/**
 * Trips through the store's own writes: who tagged what, what Not a trip
 * takes away, and what a file taken out of a trip leaves behind. Synthetic
 * bookings only; the server is a stub that echoes each sealed write.
 */

const writes = vi.hoisted(() => ({ patches: 0, batches: 0 }));
/** Something the owner does while a write is on its way, once. */
const during = vi.hoisted(() => ({ hook: null as null | (() => Promise<unknown>) }));
const knobs = vi.hoisted(() => ({ facts: true }));

vi.mock("./api", async (importOriginal) => {
  const original = await importOriginal<typeof import("./api")>();
  return { ...original, api: { ...original.api }, uploadBlob: async () => {} };
});

vi.mock("./intel/scan", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./intel/scan")>()),
  factsEnabled: () => knobs.facts,
}));

import { api, ApiError } from "./api";
import { decide, decided } from "./decisions";
import { planTrips, type TripPlan } from "./intel/agenda";
import { withExactAcceptance, type Fact } from "./intel/facts";
import { setAssembleTripsEnabled } from "./intel/trips";
import { noticeKeys } from "./notices";
import { useStore, type FileEntry } from "./store";

const ACCOUNT = "t@example.com";
const NOW = Date.UTC(2026, 8, 10, 12);
const masterKey = vi.hoisted(() => ({ value: new Uint8Array(32) as Uint8Array }));

let seq = 0;
const exact = (value: string, label: string, extra: Partial<Fact> = {}): Fact =>
  withExactAcceptance({
    id: `event:${value}:${seq++}`,
    kind: "event",
    document: "itinerary",
    value,
    label,
    source: "jsonld",
    confidence: 1,
    ...extra,
  });

const entry = (id: string, facts: Fact[], over: Partial<FileEntry> = {}): FileEntry => ({
  id,
  folderId: null,
  name: `${id}.pdf`,
  mime: "application/pdf",
  size: 400,
  mtime: 1,
  hasText: false,
  hasClip: false,
  inlineText: false,
  category: "Documents",
  tags: [],
  facts,
  favorite: false,
  digest: `d-${id}`,
  key: generateKey(),
  hasThumb: false,
  trashed: false,
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

const flight = (over: Partial<FileEntry> = {}) =>
  entry(
    "flight",
    [
      exact("2026-11-12", "Flight TP 236 departs SFO"),
      exact("2026-11-13", "Flight TP 236 arrives LIS"),
      exact("2026-11-16", "Flight TP 237 departs LIS"),
      exact("2026-11-16", "Flight TP 237 arrives SFO"),
      exact("4F2K", "Confirmation number", { kind: "identifier", masked: "4F2K" }),
    ],
    over,
  );
const hotel = (over: Partial<FileEntry> = {}) =>
  entry(
    "hotel",
    [
      exact("2026-11-13", "Check-in: Casa do Rio", { document: "hotel-booking" }),
      exact("2026-11-16", "Check-out: Casa do Rio", { document: "hotel-booking" }),
      // A soft reading nobody has looked at: grouping never confirms it.
      { id: "dated:soft", kind: "dated", document: "hotel-booking", value: "2026-11-01", label: "Booked", source: "label", confidence: 0.7 },
    ],
    over,
  );

/** A trip to Lisbon: six documents that link exactly, and a taxi receipt that does not. */
const lisbon = (): FileEntry[] => [
  flight(),
  hotel(),
  entry("pass", [
    // The barcode knows the flight, not its date for certain.
    { id: "event:pass", kind: "event", document: "boarding-pass", value: "2026-11-12", label: "Flight TP 236 departs SFO", source: "barcode", confidence: 0.6 },
    exact("4F2K", "Booking reference", { kind: "identifier", masked: "4F2K", document: "boarding-pass", source: "barcode" }),
  ]),
  entry("museum", [exact("2026-11-14", "Museu do Azulejo", { document: "event-ticket" })]),
  entry("dinner", [exact("2026-11-15", "Dinner: Taberna da Rua", { document: "dining" })]),
  entry("eticket", [], { mailParent: "flight" }),
  entry("taxi", [
    { id: "event:taxi", kind: "event", document: "invoice", value: "2026-11-13", label: "Taxi", source: "model", confidence: 0.8, accepted: "grounded" },
  ]),
];
const EXACT = ["dinner", "eticket", "flight", "hotel", "museum", "pass"];

/** A trip two years over: a round trip to Rome and its stay. */
const rome2024 = (): FileEntry[] => [
  entry("rome-flight", [
    exact("2024-05-02", "Flight AQ 5 departs BOS"),
    exact("2024-05-02", "Flight AQ 5 arrives FCO"),
    exact("2024-05-09", "Flight AQ 6 departs FCO"),
    exact("2024-05-09", "Flight AQ 6 arrives BOS"),
  ]),
  entry("rome-stay", [
    exact("2024-05-03", "Check-in: Albergo", { document: "hotel-booking" }),
    exact("2024-05-08", "Check-out: Albergo", { document: "hotel-booking" }),
  ]),
];

function library(files: FileEntry[]) {
  masterKey.value = generateKey();
  useStore.setState({
    session: { email: ACCOUNT, token: "t", masterKey: masterKey.value, privateKey: new Uint8Array(32), publicKey: "" },
    files: new Map(files.map((f) => [f.id, f])),
    activity: { job: null, log: [] },
  });
}

const tagged = (tag: string) =>
  [...useStore.getState().files.values()]
    .filter((f) => f.tags.includes(tag))
    .map((f) => f.id)
    .sort();
const lines = () => useStore.getState().activity.log.map((e) => e.title);

const file = (id: string) => useStore.getState().files.get(id)!;

async function planFor(tag?: string): Promise<TripPlan> {
  const plans = await planTrips([...useStore.getState().files.values()], NOW);
  const plan = tag ? plans.find((p) => p.tag === tag) : plans[0];
  return plan!;
}

beforeAll(async () => {
  await ready();
  const backing = new Map<string, string>();
  (globalThis as { localStorage?: Storage }).localStorage = {
    getItem: (k: string) => backing.get(k) ?? null,
    setItem: (k: string, v: string) => void backing.set(k, String(v)),
    removeItem: (k: string) => void backing.delete(k),
    clear: () => backing.clear(),
    key: (i: number) => [...backing.keys()][i] ?? null,
    get length() {
      return backing.size;
    },
  } as Storage;
});

beforeEach(() => {
  localStorage.clear();
  knobs.facts = true;
  during.hook = null;
  writes.patches = 0;
  writes.batches = 0;
  // An older server's answer, so writes take the single route stubbed below.
  (api as unknown as Record<string, unknown>).batchFiles = async () => {
    writes.batches++;
    throw new ApiError(404, "not found");
  };
  (api as unknown as Record<string, unknown>).patchFile = async (
    id: string,
    patch: { encryptedMeta: FileDto["encryptedMeta"] },
  ): Promise<FileDto> => {
    writes.patches++;
    const hook = during.hook;
    during.hook = null;
    await hook?.();
    const held = useStore.getState().files.get(id)!;
    return {
      id,
      folderId: held.folderId,
      encryptedKey: secretBoxSeal(held.key, masterKey.value),
      encryptedMeta: patch.encryptedMeta,
      size: held.size,
      thumbSize: 1,
      indexSize: 1,
      uploaded: true,
      trashed: false,
      deleted: false,
      updateSeq: 2,
      createdAt: 1,
      updatedAt: 2,
    };
  };
});

const TAG = "trip:lisbon-2026-11";

describe("tagging a trip", () => {
  it("Group as tags every member once, in one batch, and marks the trip the owner's", async () => {
    library([flight(), hotel()]);
    await useStore.getState().confirmTrip(await planFor());
    expect(file("flight").tags).toContain(TAG);
    expect(file("hotel").tags).toContain(TAG);
    expect(writes).toEqual({ patches: 2, batches: 1 });
    expect(file("flight").facts.filter((fact) => fact.kind === "event").every((fact) => fact.confirmed)).toBe(true);
    expect(file("hotel").facts.find((fact) => fact.id === "dated:soft")!.confirmed).toBeUndefined();
    expect(decided(ACCOUNT, "ownedTrips").has(TAG)).toBe(true);
    expect(decided(ACCOUNT, "assembledTrips").size).toBe(0);
    await useStore.getState().confirmTrip(await planFor(TAG));
    expect(writes).toEqual({ patches: 2, batches: 1 });
  });

  it("Not a trip removes what the assembler wrote and nothing the owner added", async () => {
    library([flight({ tags: [TAG] }), hotel({ tags: [TAG] })]);
    decide(ACCOUNT, "assembledTrips", [`${TAG}|flight`]);
    expect(await useStore.getState().undoTrip(TAG)).toBe(1);
    expect(file("flight").tags).not.toContain(TAG);
    expect(file("hotel").tags).toContain(TAG);
    expect(decided(ACCOUNT, "dismissedTrips")).toEqual(new Set([TAG, "anchor:flight"]));
  });

  it("Not a trip on a trip the owner kept removes nothing", async () => {
    library([flight({ tags: [TAG] }), hotel({ tags: [TAG] })]);
    decide(ACCOUNT, "assembledTrips", [`${TAG}|flight`, `${TAG}|hotel`]);
    decide(ACCOUNT, "ownedTrips", [TAG]);
    expect(await useStore.getState().undoTrip(TAG)).toBe(0);
    expect(file("flight").tags).toContain(TAG);
    expect(writes.patches).toBe(0);
  });

  it("Group as never puts back a file the owner took out", async () => {
    library(lisbon());
    await useStore.getState().assembleTrips();
    await useStore.getState().leaveTrip(["museum"], TAG);
    await useStore.getState().confirmTrip(await planFor(TAG));
    expect(tagged(TAG)).toEqual(["dinner", "eticket", "flight", "hotel", "pass", "taxi"]);
  });

  it("adding one file puts it in the trip even after it was taken out", async () => {
    library([flight({ tags: [TAG] }), hotel({ tags: [TAG] })]);
    await useStore.getState().leaveTrip(["hotel"], TAG);
    expect(file("hotel").tags).not.toContain(TAG);
    await useStore.getState().addToTrip(["hotel"], TAG);
    expect(file("hotel").tags).toContain(TAG);
    expect(decided(ACCOUNT, "ownedTrips").has(TAG)).toBe(true);
  });

  it("adding twice writes once", async () => {
    library([flight({ tags: [TAG] }), hotel()]);
    await useStore.getState().addToTrip(["hotel"], TAG);
    await useStore.getState().addToTrip(["hotel"], TAG);
    expect(writes.patches).toBe(1);
  });

  it("taking a file out of a trip remembers it", async () => {
    library([flight({ tags: [TAG] }), hotel({ tags: [TAG] })]);
    await useStore.getState().leaveTrip(["hotel"], TAG);
    expect(file("hotel").tags).not.toContain(TAG);
    expect(file("flight").tags).toContain(TAG);
    expect(decided(ACCOUNT, "tripExclusions")).toEqual(new Set([`${TAG}|hotel`]));
    expect(decided(ACCOUNT, "ownedTrips").has(TAG)).toBe(true);
  });
});

describe("trips assemble themselves", () => {
  it("a journey in booking data becomes a trip on its own", async () => {
    library(lisbon());
    expect(await useStore.getState().assembleTrips()).toBe(6);
    expect(tagged(TAG)).toEqual(EXACT);
    expect(lines()).toEqual(["Assembled Lisbon, Nov 2026 from 6 documents"]);
  });

  it("the assembler's tag write is remembered as the assembler's", async () => {
    library(lisbon());
    await useStore.getState().assembleTrips();
    expect(decided(ACCOUNT, "assembledTrips")).toEqual(new Set(EXACT.map((id) => `${TAG}|${id}`)));
    expect(decided(ACCOUNT, "ownedTrips").size).toBe(0);
    expect([...useStore.getState().files.values()].some((f) => f.facts.some((fact) => fact.confirmed))).toBe(false);
  });

  it("a second run writes nothing", async () => {
    library(lisbon());
    await useStore.getState().assembleTrips();
    const before = { ...writes };
    expect(await useStore.getState().assembleTrips()).toBe(0);
    expect(writes).toEqual(before);
    expect(lines()).toHaveLength(1);
  });

  it("a second device that already sees the tag on one member joins it, not a new tag", async () => {
    const other = "trip:lisbon-2026-11-b";
    library(lisbon().map((f) => (f.id === "hotel" ? { ...f, tags: [other] } : f)));
    await useStore.getState().assembleTrips();
    expect(tagged(other)).toEqual(EXACT);
    expect(tagged(TAG)).toEqual([]);
  });

  it("a dismissed trip stays dismissed when a receipt with its booking reference arrives", async () => {
    library(lisbon());
    await useStore.getState().assembleTrips();
    await useStore.getState().undoTrip(TAG);
    expect(tagged(TAG)).toEqual([]);
    // Dated near the journey, so its reference would join it.
    const receipt = entry("seat", [
      exact("4F2K", "Booking reference", { kind: "identifier", masked: "4F2K", document: "invoice" }),
      { id: "dated:seat", kind: "dated", document: "invoice", value: "2026-11-02", label: "Paid", source: "label", confidence: 0.7 },
    ]);
    useStore.setState({ files: new Map([...useStore.getState().files, ["seat", receipt]]) });
    expect(await useStore.getState().assembleTrips()).toBe(0);
    expect(tagged(TAG)).toEqual([]);
  });

  it("a file taken out of a trip is not put back", async () => {
    library(lisbon());
    await useStore.getState().assembleTrips();
    await useStore.getState().leaveTrip(["museum"], TAG);
    expect(await useStore.getState().assembleTrips()).toBe(0);
    expect(tagged(TAG)).toEqual(EXACT.filter((id) => id !== "museum"));
  });

  it("a trip the owner kept takes later bookings on its own", async () => {
    library([flight(), hotel()]);
    await useStore.getState().confirmTrip(await planFor());
    const museum = lisbon().find((f) => f.id === "museum")!;
    useStore.setState({ files: new Map([...useStore.getState().files, ["museum", museum]]) });
    expect(await useStore.getState().assembleTrips()).toBe(1);
    expect(tagged(TAG)).toEqual(["flight", "hotel", "museum"]);
  });

  it("nothing assembles with the switch off, or with dates off", async () => {
    library(lisbon());
    setAssembleTripsEnabled(false);
    expect(await useStore.getState().assembleTrips()).toBe(0);
    setAssembleTripsEnabled(true);
    knobs.facts = false;
    expect(await useStore.getState().assembleTrips()).toBe(0);
    expect(writes.patches).toBe(0);
    expect(tagged(TAG)).toEqual([]);
  });

  it("Not a trip while a run is under way is not undone by that run", async () => {
    library([...lisbon().map((f) => (EXACT.includes(f.id) ? { ...f, tags: [TAG] } : f)), ...rome2024()]);
    decide(ACCOUNT, "assembledTrips", EXACT.map((id) => `${TAG}|${id}`));
    // The run writes Rome first; the owner refuses Lisbon meanwhile.
    during.hook = () => useStore.getState().undoTrip(TAG);
    await useStore.getState().assembleTrips();
    expect(tagged("trip:rome-2024-05")).toEqual(["rome-flight", "rome-stay"]);
    expect(tagged(TAG)).toEqual([]);
  });

  it("two runs started at once write once", async () => {
    library(lisbon());
    await Promise.all([useStore.getState().assembleTrips(), useStore.getState().assembleTrips()]);
    expect(writes.patches).toBe(6);
    expect(lines()).toHaveLength(1);
  });

  it("a trip that ended two years ago assembles quietly", async () => {
    const rome = [
      entry("rome-flight", [
        exact("2024-05-02", "Flight AQ 5 departs BOS"),
        exact("2024-05-02", "Flight AQ 5 arrives FCO"),
        exact("2024-05-09", "Flight AQ 6 departs FCO"),
        exact("2024-05-09", "Flight AQ 6 arrives BOS"),
      ]),
      entry("rome-stay", [
        exact("2024-05-03", "Check-in: Albergo", { document: "hotel-booking" }),
        exact("2024-05-08", "Check-out: Albergo", { document: "hotel-booking" }),
      ]),
    ];
    library([...lisbon(), ...rome]);
    await useStore.getState().assembleTrips();
    expect(tagged("trip:rome-2024-05")).toEqual(["rome-flight", "rome-stay"]);
    // One line for the whole run, and the past trip raises nothing in the bell.
    expect(lines()).toEqual(["Assembled 2 trips from your bookings"]);
    const keys = noticeKeys([...useStore.getState().files.values()], NOW);
    expect(keys).toContain(`trip:${TAG}`);
    expect(keys).not.toContain("trip:trip:rome-2024-05");
  });
});
