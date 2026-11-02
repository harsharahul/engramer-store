/**
 * The one way a journey's legs are built from the dated facts that state them.
 *
 * A leg is a departure and the arrival that belongs to it, each read as the
 * real instant at its own place. Facts read from one reservation pair by that
 * reservation; otherwise each departure pairs with the next arrival under the
 * same flight or service, so a round trip by the same bus line folds into two
 * legs. A boarding pass for a booked flight adds itself to that flight rather
 * than standing beside it; a pass alone is a leg of its own, and its date
 * still asks, because the barcode's year is inferred.
 */
import type { Fact } from "./facts";
import { instantOf, zoneOf } from "./instants";
import { arrivalCode, designatorOf, isLegEnd, subjectOf, type Mode, type Subject } from "./subject";

/** A dated fact as the Timeline holds it: whose it is, and whether it still asks. */
export interface DatedEntry {
  fileId: string;
  fact: Fact;
  ask: boolean;
}

export interface Stop {
  day: string;
  time?: string;
  zone: string;
  at: number;
  code?: string;
  place: string;
  factId: string;
}

export interface Leg {
  /** "Flight TP 236": the mode and the service, unique within a file. */
  key: string;
  mode: Mode;
  /** "TP 236", or empty when the booking named no service. */
  designator: string;
  /** Each end as its facts state it: an airport code, else the place's name. */
  from: string;
  to: string;
  dep?: Stop;
  arr?: Stop;
  fileId: string;
  factIds: string[];
  ask: boolean;
  passFileId?: string;
  seat?: string;
  gate?: string;
  boardingGroup?: string;
  boardingTime?: string;
}

interface Held {
  fact: Fact;
  ask: boolean;
  subject: Subject & { mode: Mode };
  stop: Stop;
}

interface Draft {
  fileId: string;
  key: string;
  departs?: Held;
  arrives?: Held;
  ask: boolean;
}

function keyOf(subject: Subject & { mode: Mode }): string {
  return [subject.mode[0]!.toUpperCase() + subject.mode.slice(1), designatorOf(subject)].filter(Boolean).join(" ");
}

function nameOf(subject: Subject | undefined): string {
  return subject?.code ?? subject?.place ?? "";
}

const isPass = (leg: Leg, passes: ReadonlySet<Leg>) => passes.has(leg);

/**
 * The legs the entries state, in order of departure. `tripZoneOf` names the
 * destination zone of a file's trip, for an end with no airport of its own.
 */
export async function legsOf(
  entries: readonly DatedEntry[],
  tripZoneOf: (fileId: string) => Promise<string | undefined> = async () => undefined,
): Promise<Leg[]> {
  const stopOf = async (fileId: string, fact: Fact, subject: Subject): Promise<Stop> => {
    const zone = await zoneOf(fact, { tripZone: await tripZoneOf(fileId) });
    return {
      day: fact.value,
      ...(fact.time ? { time: fact.time } : {}),
      zone,
      at: instantOf(fact.value, fact.time, zone),
      ...(subject.code ? { code: subject.code } : {}),
      place: nameOf(subject),
      factId: fact.id,
    };
  };

  const groups = new Map<string, { fileId: string; key: string; held: Held[] }>();
  for (const { fileId, fact, ask } of entries) {
    const subject = fact.kind === "event" ? subjectOf(fact) : undefined;
    if (!isLegEnd(subject)) {
      continue;
    }
    const key = keyOf(subject);
    const group = groups.get(`${fileId}|${key}`) ?? { fileId, key, held: [] };
    group.held.push({ fact, ask, subject, stop: await stopOf(fileId, fact, subject) });
    groups.set(`${fileId}|${key}`, group);
  }

  const drafts: Draft[] = [];
  for (const { fileId, key, held } of groups.values()) {
    // Ends of one reservation belong together, whatever their printed order.
    const slots = new Map<number, { departs?: Held; arrives?: Held }>();
    const loose: Held[] = [];
    for (const item of held) {
      const reservation = item.subject.reservation;
      const side = item.subject.role === "depart" ? "departs" : "arrives";
      const slot = reservation === undefined ? undefined : (slots.get(reservation) ?? {});
      if (!slot || slot[side]) {
        loose.push(item);
        continue;
      }
      slot[side] = item;
      slots.set(reservation!, slot);
    }
    for (const slot of slots.values()) {
      if (slot.departs && slot.arrives) {
        drafts.push({ fileId, key, departs: slot.departs, arrives: slot.arrives, ask: slot.departs.ask || slot.arrives.ask });
      } else {
        loose.push((slot.departs ?? slot.arrives)!);
      }
    }
    // The rest pair in real time: each departure with the next arrival after
    // it. Printed clocks cannot order them: an eastbound Pacific flight lands
    // at an earlier printed clock than it left.
    loose.sort(
      (a, b) =>
        a.stop.at - b.stop.at ||
        (a.subject.role === b.subject.role ? 0 : a.subject.role === "depart" ? -1 : 1) ||
        a.fact.id.localeCompare(b.fact.id),
    );
    let latest: Draft | undefined;
    for (const item of loose) {
      if (item.subject.role === "depart") {
        latest = { fileId, key, departs: item, ask: item.ask };
        drafts.push(latest);
      } else if (latest && !latest.arrives) {
        latest.arrives = item;
        latest.ask ||= item.ask;
      } else {
        drafts.push({ fileId, key, arrives: item, ask: item.ask });
      }
    }
  }

  const legs: Leg[] = [];
  const passes = new Set<Leg>();
  for (const draft of drafts) {
    const leaving = draft.departs?.subject;
    const service = (draft.departs ?? draft.arrives)!.subject;
    const leg: Leg = {
      key: draft.key,
      mode: service.mode,
      designator: designatorOf(service) ?? "",
      from: nameOf(leaving),
      // A boarding pass names both ends on its one departure.
      to: draft.arrives ? nameOf(draft.arrives.subject) : (arrivalCode(leaving) ?? ""),
      ...(draft.departs ? { dep: draft.departs.stop } : {}),
      ...(draft.arrives ? { arr: draft.arrives.stop } : {}),
      fileId: draft.fileId,
      factIds: [draft.departs?.fact.id, draft.arrives?.fact.id].filter((id): id is string => id !== undefined),
      ask: draft.ask,
      ...(leaving?.seat ? { seat: leaving.seat } : {}),
      ...(leaving?.gate ? { gate: leaving.gate } : {}),
      ...(leaving?.boardingGroup ? { boardingGroup: leaving.boardingGroup } : {}),
      ...(leaving?.boardingTime ? { boardingTime: leaving.boardingTime } : {}),
    };
    legs.push(leg);
    if (draft.departs?.fact.document === "boarding-pass" && !draft.arrives) {
      passes.add(leg);
    }
  }

  // A pass for a flight booked elsewhere belongs to that flight.
  const joined = new Set<Leg>();
  for (const pass of passes) {
    const booked = legs.find(
      (leg) =>
        !isPass(leg, passes) &&
        leg.fileId !== pass.fileId &&
        leg.mode === pass.mode &&
        leg.designator !== "" &&
        leg.designator === pass.designator &&
        leg.dep?.day === pass.dep?.day,
    );
    if (booked) {
      booked.passFileId ??= pass.fileId;
      joined.add(pass);
    }
  }

  return legs
    .filter((leg) => !joined.has(leg))
    .sort((a, b) => (a.dep ?? a.arr)!.at - (b.dep ?? b.arr)!.at || a.key.localeCompare(b.key));
}
