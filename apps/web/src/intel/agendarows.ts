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
import { lookupAirport } from "./airports";
import { documentLabel } from "./describe";
import { basisOf, isDated, isTracked, offeredFacts, type Fact } from "./facts";
import { isTripTag, tripTitle } from "./trips";

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
  title: string;
  sub?: string;
  amount?: { currency: string; value: string };
  source: "EMAIL" | "PDF" | "RECEIPT" | "PHOTOS" | "FILE";
  fileIds: string[];
  /** The facts a dated row stands for, so a yes or a no can answer all of them. */
  factIds?: string[];
  flight?: { from: string; to: string; number: string; dep?: string; arr?: string; plusDays: number };
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

const pad = (n: number) => String(n).padStart(2, "0");

/** The device-local date of an instant, as an ISO day. */
export function localDay(ms: number): string {
  const at = new Date(ms);
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/** The device-local time of an instant, as HH:MM. */
export function localTime(ms: number): string {
  const at = new Date(ms);
  return `${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** The date of an instant in a named zone, as an ISO day; the device's when the zone is unknown. */
export function zonedDay(ms: number, zone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);
  } catch {
    return localDay(ms);
  }
}

/** The time of an instant in a named zone, as HH:MM; the device's when the zone is unknown. */
export function zonedTime(ms: number, zone: string): string {
  try {
    return new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(ms);
  } catch {
    return localTime(ms);
  }
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const LEG = /^((?:flight|train|bus|boat)\b.*?)\s+(departs|arrives)\b\s*(.*)$/i;
const MODE = /^(?:flight|train|bus|boat)\s*/i;
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

  const rows: Omit<AgendaRow, "past">[] = [];
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
    const legFacts = new Map<string, { fact: Fact; ask: boolean }[]>();
    const deliveries = new Map<string, { opens?: Fact; by?: Fact; ask: boolean }>();
    for (const { fact, ask } of entries) {
      const label = fact.label ?? "";
      const leg = fact.kind === "event" ? LEG.exec(label) : null;
      if (leg) {
        const held = legFacts.get(leg[1]!) ?? [];
        held.push({ fact, ask });
        legFacts.set(leg[1]!, held);
        continue;
      }
      if (fact.kind === "event" && fact.document === "delivery") {
        const entry = deliveries.get(fact.value) ?? { ask: false };
        entry[/opens/i.test(label) ? "opens" : "by"] = fact;
        entry.ask ||= ask;
        deliveries.set(fact.value, entry);
        continue;
      }
      if (fact.kind === "event" && / ends$/.test(label)) {
        continue;
      }
      const common = { ...base(file), id: `${file.id}:${fact.id}`, factIds: [fact.id], day: fact.value, ...(fact.time ? { time: fact.time } : {}), ...(ask ? { ask: true as const } : {}) };
      const stay = /^check-(in|out):\s*(.*)$/i.exec(label);
      const car = /^(pick-up|drop-off):\s*(.*)$/i.exec(label);
      if (fact.kind === "event" && stay) {
        rows.push({ ...common, kind: "stay", tag: "STAY", title: `Check ${stay[1]!.toLowerCase()} · ${stay[2]}`, sub: subOf(file) });
      } else if (fact.kind === "event" && car) {
        rows.push({ ...common, kind: "event", tag: "BOOKED", title: `${/^pick/i.test(car[1]!) ? "Pick up" : "Drop off"} · ${car[2]}`, sub: subOf(file) });
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
    // One designator can name several legs (a round trip by the same bus
    // line): each departure pairs with the next arrival after it.
    const legs: { designator: string; departs?: Fact; arrives?: Fact; ask: boolean }[] = [];
    for (const [designator, held] of legFacts) {
      held.sort((a, b) => `${a.fact.value} ${a.fact.time ?? ""}`.localeCompare(`${b.fact.value} ${b.fact.time ?? ""}`));
      let open: (typeof legs)[number] | undefined;
      for (const { fact, ask } of held) {
        if (/\bdeparts\b/i.test(fact.label ?? "")) {
          open = { designator, departs: fact, ask };
          legs.push(open);
        } else if (open && !open.arrives) {
          open.arrives = fact;
          open.ask ||= ask;
        } else {
          legs.push({ designator, arrives: fact, ask });
        }
      }
    }
    for (const { designator, departs, arrives, ask } of legs) {
      const start = departs ?? arrives!;
      const from = departs ? LEG.exec(departs.label ?? "")![3]! : "";
      const to = arrives ? LEG.exec(arrives.label ?? "")![3]! : "";
      const title = [from && (await placeName(from)), to && (await placeName(to))].filter(Boolean).join(" to ") || designator;
      rows.push({
        ...base(file),
        id: `flight:${file.id}:${designator}:${start.value} ${start.time ?? ""}`,
        factIds: [departs?.id, arrives?.id].filter((id): id is string => id !== undefined),
        kind: "flight",
        tag: "FLIGHT",
        day: start.value,
        ...(start.time ? { time: start.time } : {}),
        ...(arrives ? { endDay: arrives.value, ...(arrives.time ? { endTime: arrives.time } : {}) } : {}),
        title,
        sub: subOf(file),
        flight: {
          from,
          to,
          number: designator.replace(MODE, ""),
          ...(departs?.time ? { dep: departs.time } : {}),
          ...(arrives?.time ? { arr: arrives.time } : {}),
          plusDays: departs && arrives ? dayNumber(arrives.value) - dayNumber(departs.value) : 0,
        },
        ...(ask ? { ask: true as const } : {}),
      });
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
  const clock = localTime(now);
  return rows
    .map((row) => {
      const day = row.endDay ?? row.day;
      const time = row.endDay ? row.endTime : row.time;
      return { ...row, past: day < today || (day === today && time !== undefined && time < clock) };
    })
    .sort((a, b) => a.day.localeCompare(b.day) || (a.time ?? "").localeCompare(b.time ?? "") || a.id.localeCompare(b.id));
}
