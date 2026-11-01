import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKey, ready, secretBoxSeal } from "@engramer/crypto";
import type { FileDto } from "./api";

/**
 * Trips through the store's own writes: who tagged what, what Not a trip
 * takes away, and what a file taken out of a trip leaves behind. Synthetic
 * bookings only; the server is a stub that echoes each sealed write.
 */

const writes = vi.hoisted(() => ({ patches: 0, batches: 0 }));

vi.mock("./api", async (importOriginal) => {
  const original = await importOriginal<typeof import("./api")>();
  return { ...original, api: { ...original.api }, uploadBlob: async () => {} };
});

import { api, ApiError } from "./api";
import { decide, decided } from "./decisions";
import { planTrips, type TripPlan } from "./intel/agenda";
import { withExactAcceptance, type Fact } from "./intel/facts";
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

function library(files: FileEntry[]) {
  masterKey.value = generateKey();
  useStore.setState({
    session: { email: ACCOUNT, token: "t", masterKey: masterKey.value, privateKey: new Uint8Array(32), publicKey: "" },
    files: new Map(files.map((f) => [f.id, f])),
  });
}

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
    expect(file("flight").facts.every((fact) => fact.confirmed)).toBe(true);
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

  it("taking a file out of a trip remembers it", async () => {
    library([flight({ tags: [TAG] }), hotel({ tags: [TAG] })]);
    await useStore.getState().leaveTrip(["hotel"], TAG);
    expect(file("hotel").tags).not.toContain(TAG);
    expect(file("flight").tags).toContain(TAG);
    expect(decided(ACCOUNT, "tripExclusions")).toEqual(new Set([`${TAG}|hotel`]));
    expect(decided(ACCOUNT, "ownedTrips").has(TAG)).toBe(true);
  });
});
