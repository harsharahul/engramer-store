/**
 * The Timeline's rows: one per dated thing in the library, in order. A
 * flight's two legs are one row, a delivery window is one row, a day of
 * photos is one row, a bill sits on its document's date, and a trip that
 * only dates link is one question. The list, the Month view and the
 * Everyday cards all read these rows, so they cannot disagree about what
 * happened when.
 *
 * Days and times are kept as printed, local to their place; "today" and
 * the now line are the device's.
 */

import { isEmailRecord } from "../mail/kind";
import { isPlanDismissed, itemsOf, type PlanFile, type TripPlan } from "./agenda";
import { lookupAirport, placeForCity } from "./airports";
import { deviceZone, instantOf, localDay, localTime, zoneOf } from "./instants";
import { legsOf, type DatedEntry, type Leg } from "./legs";
import { documentLabel } from "./describe";
import { basisOf, isDated, isTracked, offeredFacts, type Fact } from "./facts";
import { isTripTag, tripTitle } from "./trips";
import { isLegEnd, subjectOf } from "./subject";

export interface RowFile extends PlanFile {
  mime: string;
  mtime: number;
  category?: string;
  shared?: boolean;
  mail?: { subject?: string; from?: string; date?: number };
}

export type RowKind = "flight" | "stay" | "bill" | "due" | "event" | "doc" | "parcel" | "photos" | "trip";

export interface RowTrip {
  tag: string;
  title: string;
  /** The trip's place, as the row's chip and questions say it. */
  name: string;
  /** exact: the file carries the trip's tag; weak: only its date matches. */
  evidence: "exact" | "weak";
}

export interface AgendaRow {
  id: string;
  kind: RowKind;
  /** The label above the row: FLIGHT, STAY, BILL, DUE, TICKETS, BOOKED, DOCUMENT, DELIVERY, PHOTOS, TRIP?. */
  tag: string;
  day: string;
  time?: string;
  endDay?: string;
  endTime?: string;
  /** When it happens: the printed day and time read in their own place's zone. */
  at: number;
  /** When a journey arrives, likewise. */
  endAt?: number;
  title: string;
  sub?: string;
  amount?: { currency: string; value: string };
  source: "EMAIL" | "PDF" | "RECEIPT" | "PHOTOS" | "FILE";
  fileIds: string[];
  /** The facts a dated row stands for, so a yes or a no can answer all of them. */
  factIds?: string[];
  flight?: {
    from: string;
    to: string;
    number: string;
    dep?: string;
    arr?: string;
    plusDays: number;
    /** The boarding pass stored for this flight, when one is. */
    passFileId?: string;
    /** The leg itself, with the real instants at each end. */
    leg: Leg;
  };
  trip?: RowTrip;
  /** A date nobody has said yes to yet. */
  ask?: true;
  /** A date the owner confirmed. */
  confirmedByYou?: true;
  proposal?: TripPlan;
  past: boolean;
}

/** The plans and the account's answers that shape the rows. */
export interface RowContext {
  plans: readonly TripPlan[];
  dismissed: ReadonlySet<string>;
  excluded: ReadonlySet<string>;
  /** Whether journeys group themselves; when not, a booked journey is asked about too. */
  assembling: boolean;
}

// Time lives in intel/instants.ts; the Timeline's callers reach it here too.
export { localDay, localTime, zonedDay, zonedTime } from "./instants";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayNumber = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 86_400_000;

function sourceOf(file: RowFile): AgendaRow["source"] {
  if (isEmailRecord(file.name, file.mime)) {
    return "EMAIL";
  }
  if (file.mime === "application/pdf") {
    return "PDF";
  }
  return file.mime.startsWith("image/") && file.category === "Receipts" ? "RECEIPT" : "FILE";
}

const capitalised = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** A place as a person says it: the city for an airport code, else as written. */
async function placeName(place: string): Promise<string> {
  if (/^[A-Z]{3}$/.test(place)) {
    return (await lookupAirport(place))?.city ?? place;
  }
  return place;
}

/**
 * The trips a document matched only by its date may be asked to join: a
 * booked journey that exists as a trip (some file carries its tag), is
 * recent, and was not refused.
 */
export function joinablePlans(
  plans: readonly TripPlan[],
  dismissed: ReadonlySet<string>,
  carries: (fileId: string, tag: string) => boolean,
): TripPlan[] {
  return plans.filter(
    (plan) =>
      plan.anchorId !== undefined &&
      plan.recent &&
      !isPlanDismissed(plan, dismissed) &&
      [...plan.exact.keys()].some((id) => carries(id, plan.tag)),
  );
}

/**
 * What the library asks about trips: whole trips to keep or refuse (a
 * date-only plan, or a booked journey while trips do not group
 * themselves), and documents a date suggests for an existing trip.
 */
export function offeredTrips(
  plans: readonly TripPlan[],
  ctx: Pick<RowContext, "dismissed" | "excluded" | "assembling">,
  fileOf: (fileId: string) => { tags: readonly string[]; facts: readonly Fact[] } | undefined,
): { proposals: TripPlan[]; joins: number } {
  const tagsOf = (id: string) => fileOf(id)?.tags;
  const carries = (id: string, tag: string) => tagsOf(id)?.includes(tag) ?? false;
  // Dates alone make a trip question only around somewhere to stay: an
  // ordinary week of dinners, deliveries and a concert is not a trip.
  const staysAway = (plan: TripPlan) =>
    plan.weak.some((id) =>
      fileOf(id)?.facts.some(
        (fact) => fact.kind === "event" && isTracked(fact) && (fact.document === "hotel-booking" || fact.document === "car-rental"),
      ),
    );
  const proposals = plans.filter(
    (plan) =>
      (plan.anchorId !== undefined ? !ctx.assembling : staysAway(plan)) &&
      plan.recent &&
      !isPlanDismissed(plan, ctx.dismissed) &&
      ![...plan.exact.keys(), ...plan.weak].some((id) => carries(id, plan.tag)),
  );
  const joins = joinablePlans(plans, ctx.dismissed, carries).reduce(
    (count, plan) =>
      count +
      plan.weak.filter((id) => tagsOf(id) !== undefined && !tagsOf(id)!.some(isTripTag) && !ctx.excluded.has(`${plan.tag}|${id}`)).length,
    0,
  );
  return { proposals, joins };
}

/** "18-21 Dec", or "30 Nov-2 Dec" across months. */
function range(start: string, end: string): string {
  const [, sm, sd] = start.split("-").map(Number) as [number, number, number];
  const [, em, ed] = end.split("-").map(Number) as [number, number, number];
  return sm === em ? `${sd}-${ed} ${MONTHS[em - 1]}` : `${sd} ${MONTHS[sm - 1]}-${ed} ${MONTHS[em - 1]}`;
}

export async function rowsOf(files: readonly RowFile[], ctx: RowContext, now: number): Promise<AgendaRow[]> {
  const live = files.filter((file) => !file.trashed);
  const byId = new Map(live.map((file) => [file.id, file]));
  const subOf = (file: RowFile) =>
    file.mail?.subject ?? (file.mailParent ? byId.get(file.mailParent)?.mail?.subject : undefined) ?? file.name;
  const amountOf = (file: RowFile) => {
    const fact = file.facts.find((candidate) => candidate.kind === "amount" && isTracked(candidate) && candidate.unit);
    return fact ? { currency: fact.unit!, value: fact.value } : undefined;
  };

  // The trip each file belongs to, and the trips a date only suggests.
  const planByTag = new Map(ctx.plans.map((plan) => [plan.tag, plan]));
  const nameOf = (tag: string) => planByTag.get(tag)?.destination ?? tripTitle(tag).split(",")[0]!;
  const tripOf = (file: RowFile): RowTrip | undefined => {
    const tag = file.tags.find(isTripTag);
    return tag ? { tag, title: tripTitle(tag), name: nameOf(tag), evidence: "exact" } : undefined;
  };
  const anchored = joinablePlans(ctx.plans, ctx.dismissed, (id, tag) => byId.get(id)?.tags.includes(tag) ?? false);
  const suggested = (file: RowFile, day?: string): RowTrip | undefined => {
    if (file.tags.some(isTripTag)) {
      return undefined;
    }
    const plan = anchored.find(
      (candidate) =>
        (day === undefined ? candidate.weak.includes(file.id) : day >= candidate.start && day <= candidate.end) &&
        !ctx.excluded.has(`${candidate.tag}|${file.id}`),
    );
    return plan ? { tag: plan.tag, title: plan.title, name: plan.destination ?? nameOf(plan.tag), evidence: "weak" } : undefined;
  };

  const rows: (Omit<AgendaRow, "past" | "at"> & { at?: number })[] = [];
  // A booking with no airport of its own keeps its trip's destination time.
  const tripZones = new Map<string, Promise<string | undefined>>();
  const tripZoneOf = (file: RowFile): Promise<string | undefined> => {
    const tag = file.tags.find(isTripTag);
    if (!tag) {
      return Promise.resolve(undefined);
    }
    if (!tripZones.has(tag)) {
      tripZones.set(tag, placeForCity(nameOf(tag)).then((place) => place?.zone));
    }
    return tripZones.get(tag)!;
  };
  const whenOf = async (file: RowFile, fact: Fact) =>
    instantOf(fact.value, fact.time, await zoneOf(fact, { tripZone: await tripZoneOf(file) }));
  const base = (file: RowFile) => {
    const trip = tripOf(file) ?? suggested(file);
    return { source: sourceOf(file), fileIds: [file.id], ...(trip ? { trip } : {}) };
  };

  // Dated facts, tracked and still asking, grouped per file so the legs of
  // one flight and the window of one delivery fold together.
  const dated = new Map<string, { fact: Fact; ask: boolean }[]>();
  const note = (fileId: string, fact: Fact, ask: boolean) => {
    const held = dated.get(fileId) ?? [];
    held.push({ fact, ask });
    dated.set(fileId, held);
  };
  for (const { file, fact } of itemsOf(live, now, { name: "all" })) {
    note(file.id, fact, false);
  }
  for (const { fileId, fact } of offeredFacts(live, now)) {
    if (isDated(fact)) {
      note(fileId, fact, true);
    }
  }

  const ticketed = new Set<string>();
  for (const [fileId, entries] of dated) {
    const file = byId.get(fileId)!;
    const deliveries = new Map<string, { opens?: Fact; by?: Fact; ask: boolean }>();
    for (const { fact, ask } of entries) {
      const label = fact.label ?? "";
      const subject = fact.kind === "event" ? subjectOf(fact) : undefined;
      if (isLegEnd(subject)) {
        // Journeys are built below, across files, by the one leg builder.
        continue;
      }
      if (fact.kind === "event" && fact.document === "delivery") {
        const entry = deliveries.get(fact.value) ?? { ask: false };
        entry[subject?.role === "opens" ? "opens" : "by"] = fact;
        entry.ask ||= ask;
        deliveries.set(fact.value, entry);
        continue;
      }
      if (subject?.role === "end") {
        continue;
      }
      const common = {
        ...base(file),
        id: `${file.id}:${fact.id}`,
        factIds: [fact.id],
        day: fact.value,
        ...(fact.time ? { time: fact.time } : {}),
        at: await whenOf(file, fact),
        ...(ask ? { ask: true as const } : {}),
      };
      const named = (words: string) => [words, subject?.place].filter(Boolean).join(" · ");
      if (subject?.role === "check-in" || subject?.role === "check-out") {
        rows.push({ ...common, kind: "stay", tag: "STAY", title: named(subject.role === "check-in" ? "Check in" : "Check out"), sub: subOf(file) });
      } else if (subject?.role === "pick-up" || subject?.role === "drop-off") {
        rows.push({ ...common, kind: "event", tag: "BOOKED", title: named(subject.role === "pick-up" ? "Pick up" : "Drop off"), sub: subOf(file) });
      } else if (fact.kind === "event") {
        const price = amountOf(file);
        if (price) {
          ticketed.add(file.id);
        }
        rows.push({ ...common, kind: "event", tag: price ? "TICKETS" : "BOOKED", title: label || capitalised(documentLabel(fact.document)), sub: subOf(file), ...(price ? { amount: price } : {}) });
      } else if (fact.kind === "dated") {
        rows.push({ ...common, kind: "doc", tag: "DOCUMENT", title: label || "Document", sub: subOf(file), ...(basisOf(fact) === "confirmed" ? { confirmedByYou: true as const } : {}) });
      } else {
        const price = amountOf(file);
        rows.push({
          ...common,
          kind: "due",
          tag: "DUE",
          title: label || `${capitalised(documentLabel(fact.document))} ${fact.kind === "expiry" ? "expiring" : "due"}`,
          sub: subOf(file),
          ...(price ? { amount: price } : {}),
          ...(basisOf(fact) === "confirmed" ? { confirmedByYou: true as const } : {}),
        });
      }
    }
    for (const [day, { opens, by, ask }] of deliveries) {
      const sub =
        opens?.time && by?.time
          ? `Between ${opens.time} and ${by.time}`
          : by?.time
            ? `By ${by.time}`
            : opens?.time
              ? `From ${opens.time}`
              : undefined;
      const time = opens?.time ?? by?.time;
      rows.push({
        ...base(file),
        id: `parcel:${file.id}:${day}`,
        factIds: [opens?.id, by?.id].filter((id): id is string => id !== undefined),
        kind: "parcel",
        tag: "DELIVERY",
        day,
        ...(time ? { time } : {}),
        title: subOf(file),
        ...(sub ? { sub } : {}),
        ...(ask ? { ask: true as const } : {}),
      });
    }
  }

  // Journeys: one builder pairs every file's legs, and a boarding pass joins
  // the flight it was issued for instead of standing beside it.
  const entries: DatedEntry[] = [...dated].flatMap(([fileId, held]) => held.map(({ fact, ask }) => ({ fileId, fact, ask })));
  for (const leg of await legsOf(entries, (fileId) => tripZoneOf(byId.get(fileId)!))) {
    const file = byId.get(leg.fileId)!;
    const start = (leg.dep ?? leg.arr)!;
    const title = [leg.from && (await placeName(leg.from)), leg.to && (await placeName(leg.to))].filter(Boolean).join(" to ") || leg.key;
    rows.push({
      ...base(file),
      id: `flight:${file.id}:${leg.key}:${start.day} ${start.time ?? ""}`,
      factIds: leg.factIds,
      kind: "flight",
      tag: "FLIGHT",
      day: start.day,
      ...(start.time ? { time: start.time } : {}),
      ...(leg.arr ? { endDay: leg.arr.day, ...(leg.arr.time ? { endTime: leg.arr.time } : {}) } : {}),
      at: start.at,
      ...(leg.dep && leg.arr ? { endAt: leg.arr.at } : {}),
      title,
      sub: subOf(file),
      flight: {
        from: leg.from,
        to: leg.to,
        number: leg.designator,
        ...(leg.dep?.time ? { dep: leg.dep.time } : {}),
        ...(leg.arr?.time ? { arr: leg.arr.time } : {}),
        plusDays: leg.dep && leg.arr ? dayNumber(leg.arr.day) - dayNumber(leg.dep.day) : 0,
        ...(leg.passFileId ? { passFileId: leg.passFileId } : {}),
        leg,
      },
      ...(leg.ask ? { ask: true as const } : {}),
    });
  }

  // Bills: a tracked amount, once per email and its attachments, on the
  // email's date. Never for anything holding a due date, answered or not
  // (an unpaid invoice is not a payment), nor for a ticket that already
  // shows its price.
  const photosByDay = new Map<string, RowFile[]>();
  const threads = new Map<string, RowFile[]>();
  for (const file of live) {
    if (!file.shared && (file.mime.startsWith("image/") || file.mime.startsWith("video/")) && file.category !== "Receipts") {
      const day = localDay(file.mtime);
      const held = photosByDay.get(day) ?? [];
      held.push(file);
      photosByDay.set(day, held);
      continue;
    }
    const root = file.mailParent && byId.has(file.mailParent) ? file.mailParent : file.id;
    const held = threads.get(root) ?? [];
    held.push(file);
    threads.set(root, held);
  }
  const owes = (file: RowFile) => file.facts.some((fact) => fact.kind === "due" || fact.kind === "expiry");
  for (const [rootId, members] of threads) {
    if (members.some((file) => owes(file) || ticketed.has(file.id))) {
      continue;
    }
    const root = byId.get(rootId)!;
    const payer = [root, ...members.filter((file) => file.id !== rootId)].find((file) => amountOf(file));
    if (!payer) {
      continue;
    }
    const when = root.mail?.date ?? payer.mtime;
    const day = localDay(when);
    const trip = tripOf(root) ?? tripOf(payer) ?? suggested(root, day);
    rows.push({
      id: `bill:${rootId}`,
      kind: "bill",
      tag: "BILL",
      day,
      time: localTime(when),
      at: when,
      title: root.mail?.subject ?? payer.name,
      amount: amountOf(payer)!,
      source: sourceOf(payer),
      fileIds: [payer.id],
      ...(trip ? { trip } : {}),
    });
  }

  for (const [day, photos] of photosByDay) {
    const ordered = [...photos].sort((a, b) => a.mtime - b.mtime || a.id.localeCompare(b.id));
    rows.push({
      id: `photos:${day}`,
      kind: "photos",
      tag: "PHOTOS",
      day,
      time: localTime(ordered[0]!.mtime),
      at: ordered[0]!.mtime,
      title: ordered.length === 1 ? "1 photo" : `${ordered.length} photos`,
      source: "PHOTOS",
      fileIds: ordered.map((file) => file.id),
    });
  }

  // A trip only dates link is asked about once, as one row; so is a booked
  // journey while trips do not group themselves.
  for (const plan of offeredTrips(ctx.plans, ctx, (id) => byId.get(id)).proposals) {
    const booked = plan.anchorId !== undefined;
    const members = [...plan.exact.keys(), ...plan.weak].flatMap((id) => byId.get(id) ?? []);
    rows.push({
      id: `trip:${plan.dismissKeys[0]}`,
      kind: "trip",
      tag: "TRIP?",
      day: plan.start,
      title: `${plan.destination ?? "Trip"}, ${range(plan.start, plan.end)}?`,
      sub: booked
        ? `${members.length} documents from one booked journey. Trips do not group themselves now, so Engram asks first.`
        : `${members.length} documents share these dates. Only the dates match, so Engram asks first.`,
      source: members.every((file) => sourceOf(file) === "EMAIL") ? "EMAIL" : "FILE",
      fileIds: members.map((file) => file.id),
      proposal: plan,
    });
  }

  const today = localDay(now);
  const here = deviceZone();
  return rows
    .map((row) => {
      const at = row.at ?? instantOf(row.day, row.time, here);
      // A timed row is over when its real instant has passed; a whole day is
      // over once this device's calendar has moved past it.
      const timed = (row.endDay ? row.endTime : row.time) !== undefined;
      const past = timed ? (row.endAt ?? at) < now : (row.endDay ?? row.day) < today;
      return { ...row, at, past };
    })
    .sort((a, b) => a.day.localeCompare(b.day) || (a.time ?? "").localeCompare(b.time ?? "") || a.id.localeCompare(b.id));
}
