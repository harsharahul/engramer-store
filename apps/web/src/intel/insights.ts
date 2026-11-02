/**
 * Turning confirmed facts into the few observations worth interrupting for.
 *
 * An insight is a fact, a small rule, and a time. Each rule is a pure function
 * of the library and the current date, with a stable identifier, so every one
 * can be tested at its boundaries and the whole set can be read in a sitting.
 * That readability is the point: this is the part of the feature that speaks
 * with confidence, so it has to be the part nobody has to guess about.
 *
 * The rules worth having do arithmetic the owner would not have done. A
 * passport stops being useful for travel about six months before the date
 * printed on it, and that date appears on no document they own. Others fire on
 * absence: an insurance period that ended with nothing newer stored is only
 * visible to something that can see the whole library at once.
 *
 * Rules read confirmed facts only. A rule firing on a guess would be the
 * confidently-wrong failure this design exists to prevent, and it would be
 * doing it in the most authoritative voice the product has.
 */

import { isTracked, type Fact } from "./facts";
import { daysUntil } from "./dates";
import { subjectOf } from "./subject";
import { travelSpans, type TravelSpan } from "./trips";

export type Severity = "overdue" | "soon" | "info";

export interface Insight {
  /** Stable across runs, so a dismissal can be remembered. */
  id: string;
  ruleId: string;
  /** The file it came from. Absent when the observation is library-wide. */
  fileId?: string;
  /**
   * The whole point, in a few words. This is what gets read: an alert column
   * is scanned, not studied, and a paragraph in it is a paragraph nobody
   * finishes. Everything a rule wants to explain goes in `text`, behind a
   * click, where it is available to whoever wants the reasoning.
   */
  title: string;
  /** Why, for when the title has earned the attention. */
  text: string;
  severity: Severity;
}

export interface FactfulFile {
  id: string;
  name: string;
  facts: Fact[];
}

/** What a rule produces; the identity is added centrally. */
type Finding = Omit<Insight, "id" | "ruleId">;

/**
 * One trip as the rules need it. Built from the trip view (tripview.ts
 * windowOf), so the bell and the Timeline's hero check the same trip.
 */
export interface TripWindow {
  /** The trip's tag: its checks are its own on the bell. */
  tag: string;
  start: string;
  end: string;
  international: boolean;
  memberIds: string[];
  /** Landing at the destination. */
  firstArrival?: { day: string; time?: string };
  /** Each stay, with the file that books it, which its check lines open. */
  stays: { name: string; checkIn?: { day: string; time?: string }; checkOut?: { day: string }; fileId?: string }[];
  /** Days whose night is spent on a plane. */
  overnightLegs: string[];
}

/** A trip check: OK says what is in order; a note or a warning reaches the bell too. */
export interface Check {
  ruleId: string;
  state: "ok" | "note" | "warn";
  title: string;
  text?: string;
  fileId?: string;
  /** How the bell ranks a note or a warning. */
  severity?: Severity;
}

interface Rule {
  id: string;
  /** Over the library's travel windows, for a caller with no trips read. */
  run(files: FactfulFile[], now: number, held?: readonly TripWindow[]): Finding[];
  /** Over one trip, with what is in order as well as what is not. */
  trip?(window: TripWindow, files: FactfulFile[], now: number): Omit<Check, "ruleId">[];
}

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** Written out rather than localized, so a rule reads the same everywhere. */
function shown(iso: string): string {
  const [year, month, day] = iso.split("-") as [string, string, string];
  return `${Number(day)} ${MONTHS[Number(month) - 1]} ${year}`;
}

/** "16 Nov": a day near enough that its year goes without saying. */
function dayMonth(iso: string): string {
  const [, month, day] = iso.split("-") as [string, string, string];
  return `${Number(day)} ${MONTHS[Number(month) - 1]}`;
}

/** "Mar 2029". */
function monthYear(iso: string): string {
  const [year, month] = iso.split("-") as [string, string];
  return `${MONTHS[Number(month) - 1]} ${year}`;
}

const nightsWord = (n: number) => `${n} night${n === 1 ? "" : "s"}`;

function nextDay(iso: string): string {
  const at = new Date(Date.parse(`${iso}T00:00:00Z`) + 86_400_000);
  return at.toISOString().slice(0, 10);
}

/** The same day, some months earlier. Used for validity windows. */
function monthsBefore(iso: string, months: number): string {
  const [year, month, day] = iso.split("-") as [string, string, string];
  const at = new Date(Date.UTC(Number(year), Number(month) - 1 - months, Number(day)));
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, "0")}-${String(
    at.getUTCDate(),
  ).padStart(2, "0")}`;
}

/**
 * Facts a rule may read: confirmed by the owner, and not dismissed.
 *
 * A stale fact still counts. The owner confirmed it, so the reminder is
 * theirs; that the document has since been edited is reported separately
 * rather than by silently withdrawing what they asked to be told.
 */
function usable(file: FactfulFile): Fact[] {
  return file.facts.filter(isTracked);
}

function expiriesOf(files: FactfulFile[], document: Fact["document"]) {
  return files.flatMap((file) =>
    usable(file)
      .filter((fact) => fact.kind === "expiry" && fact.document === document)
      .map((fact) => ({ file, fact })),
  );
}

/** The document of this kind that runs latest, and its expiry. */
function latestExpiry(files: FactfulFile[], document: Fact["document"]) {
  return expiriesOf(files, document)
    .sort((a, b) => a.fact.value.localeCompare(b.fact.value))
    .at(-1);
}

/** Six months of validity is what a great many destinations ask for. */
const PASSPORT_RULE_MONTHS = 6;
const PASSPORT_WARN_DAYS = 270;
const WARRANTY_WARN_DAYS = 30;

/**
 * Travel windows built from confirmed events only. The clustering machinery
 * accepts exact unconfirmed sources; a rule speaking in the product's most
 * authoritative voice does not, and accepting a trip proposal confirms its
 * exact events, so a ratified trip passes this bar on its own.
 */
function confirmedSpans(files: FactfulFile[], now: number, held: readonly TripWindow[] = []): TravelSpan[] {
  // Travel a trip already holds is checked as that trip.
  return travelSpans(files, isTracked).filter(
    (span) =>
      daysUntil(span.end, now) >= 0 &&
      !held.some((window) => window.start && span.start <= window.end && span.end >= window.start),
  );
}

const roleOf = (fact: Fact) => subjectOf(fact)?.role;

const RULES: Rule[] = [
  {
    id: "passport-six-months",
    run(files, now) {
      return expiriesOf(files, "passport").flatMap(({ file, fact }) => {
        const days = daysUntil(fact.value, now);
        if (days > PASSPORT_WARN_DAYS) {
          return [];
        }
        const useful = monthsBefore(fact.value, PASSPORT_RULE_MONTHS);
        return [
          {
            fileId: file.id,
            severity:
              days < 0 ? "overdue" : daysUntil(useful, now) <= 0 ? ("soon" as const) : "info",
            title:
              days < 0
                ? `Passport expired ${shown(fact.value)}`
                : `Passport is travel-ready only until ${shown(useful)}`,
            text:
              `It expires ${shown(fact.value)}, but many countries require six months ` +
              `of validity on arrival, so it stops being useful for travel about six ` +
              `months earlier. Renewals commonly take six to eight weeks.`,
          } satisfies Finding,
        ];
      });
    },
  },
  {
    id: "permit-outlives-passport",
    run(files) {
      const passport = expiriesOf(files, "passport")
        .map((entry) => entry.fact.value)
        .sort()
        .at(-1);
      if (!passport) {
        return [];
      }
      const attached = [...expiriesOf(files, "residence-permit"), ...expiriesOf(files, "visa")];
      return attached
        .filter(({ fact }) => fact.value > passport)
        .map(({ file, fact }) => ({
          fileId: file.id,
          severity: "info" as const,
          title: "Outlives the passport it is attached to",
          text:
            `This runs to ${shown(fact.value)}, but the passport it is attached to ` +
            `expires ${shown(passport)}.`,
        }));
    },
  },
  {
    id: "insurance-lapsed",
    run(files, now) {
      const policies = expiriesOf(files, "insurance");
      const newest = policies.map((entry) => entry.fact.value).sort().at(-1);
      return policies
        // Only the most recent policy can have lapsed. An older one being past
        // its end date is just history, and saying so every time would train
        // the owner to ignore the strip.
        .filter(({ fact }) => daysUntil(fact.value, now) < 0 && fact.value === newest)
        .map(({ file, fact }) => ({
          fileId: file.id,
          severity: "overdue" as const,
          title: `Insurance lapsed ${shown(fact.value)}`,
          text:
            "The period ended and nothing newer has been added, so there may be no " +
            "cover in force right now.",
        }));
    },
  },
  {
    id: "warranty-ending",
    run(files, now) {
      return expiriesOf(files, "warranty")
        .filter(({ fact }) => {
          const days = daysUntil(fact.value, now);
          return days >= 0 && days <= WARRANTY_WARN_DAYS;
        })
        .map(({ file, fact }) => ({
          fileId: file.id,
          severity: "soon" as const,
          title: `Warranty ends in ${daysUntil(fact.value, now)} days`,
          text: `Cover runs out on ${shown(fact.value)}. This is the last window to make a claim.`,
        }));
    },
  },
  {
    // The founding example of the whole feature: neither document says it,
    // and only a reader holding both the passport and the trip can.
    id: "passport-short-for-trip",
    trip(window, files) {
      // A trip that stays inside one country asks nothing of a passport.
      const passport = window.international ? latestExpiry(files, "passport") : undefined;
      if (!passport) {
        return [];
      }
      const expiry = passport.fact.value;
      const fileId = passport.file.id;
      if (expiry <= window.end) {
        return [
          {
            state: "warn",
            severity: "overdue",
            fileId,
            title: "Passport expires during this trip",
            text: `The trip runs to ${shown(window.end)} and the passport expires ${shown(expiry)}. Renew before travelling.`,
          },
        ];
      }
      if (window.end > monthsBefore(expiry, PASSPORT_RULE_MONTHS)) {
        return [{ state: "note", severity: "soon", fileId, title: `Passport expires ${shown(expiry)}`, text: `Inside six months of your return on ${dayMonth(window.end)}` }];
      }
      return [{ state: "ok", fileId, title: `Passport valid to ${monthYear(expiry)}`, text: `Well past your return on ${dayMonth(window.end)}` }];
    },
    run(files, now, held) {
      const passport = expiriesOf(files, "passport")
        .sort((a, b) => a.fact.value.localeCompare(b.fact.value))
        .at(-1);
      if (!passport) {
        return [];
      }
      const expiry = passport.fact.value;
      const cutoff = monthsBefore(expiry, PASSPORT_RULE_MONTHS);
      return confirmedSpans(files, now, held).flatMap((span): Finding[] => {
        if (span.end >= expiry) {
          return [
            {
              fileId: passport.file.id,
              severity: "overdue" as const,
              title: "Passport expires during this trip",
              text:
                `The trip runs to ${shown(span.end)} and the passport expires ` +
                `${shown(expiry)}. Renew before travelling.`,
            } satisfies Finding,
          ];
        }
        if (span.end > cutoff) {
          return [
            {
              fileId: passport.file.id,
              severity: "soon" as const,
              title: "This trip returns inside the passport's six-month window",
              text:
                `The trip returns ${shown(span.end)} and the passport expires ` +
                `${shown(expiry)}, under six months later. Many destinations require ` +
                `six months of validity on arrival.`,
            } satisfies Finding,
          ];
        }
        return [];
      });
    },
  },
  {
    id: "permit-ends-mid-trip",
    trip(window, files) {
      return [...expiriesOf(files, "residence-permit"), ...expiriesOf(files, "visa")]
        .filter(({ fact }) => fact.value >= window.start && fact.value <= window.end)
        .map(({ file, fact }) => ({
          state: "warn" as const,
          severity: "soon" as const,
          fileId: file.id,
          title: `${file.name} expires ${dayMonth(fact.value)}, during this trip`,
          text: `This expires ${shown(fact.value)}, inside the ${shown(window.start)} to ${shown(window.end)} trip.`,
        }));
    },
    run(files, now, held) {
      const attached = [...expiriesOf(files, "residence-permit"), ...expiriesOf(files, "visa")];
      return confirmedSpans(files, now, held).flatMap((span) =>
        attached
          .filter(({ fact }) => fact.value >= span.start && fact.value <= span.end)
          .map(({ file, fact }) => ({
            fileId: file.id,
            severity: "soon" as const,
            title: "Expires during the trip",
            text:
              `This expires ${shown(fact.value)}, inside the ${shown(span.start)} to ` +
              `${shown(span.end)} trip.`,
          })),
      );
    },
  },
  {
    // Only a policy that is part of the trip: an "insurance" document may as
    // well cover a home or a car.
    id: "insurance-short-for-trip",
    trip(window, files) {
      const members = new Set(window.memberIds);
      const policy = latestExpiry(
        files.filter((file) => members.has(file.id)),
        "insurance",
      );
      if (!policy) {
        return [];
      }
      const ends = policy.fact.value;
      return ends >= window.end
        ? [{ state: "ok", fileId: policy.file.id, title: `Travel insurance valid to ${dayMonth(ends)}`, text: `From ${policy.file.name}` }]
        : [
            {
              state: "note",
              severity: "soon",
              fileId: policy.file.id,
              title: `Travel insurance ends ${dayMonth(ends)}, before your return`,
              text: `The trip runs to ${shown(window.end)}. From ${policy.file.name}`,
            },
          ];
    },
    run() {
      return [];
    },
  },
  {
    id: "checkin-gap",
    trip(window) {
      // Each night from the first day to the night before the last: on a
      // plane, or inside a stay.
      const covered = (day: string) =>
        window.overnightLegs.includes(day) ||
        window.stays.some((stay) => stay.checkIn && stay.checkOut && stay.checkIn.day <= day && day < stay.checkOut.day);
      const nights: string[] = [];
      for (let day = window.start; day < window.end; day = nextDay(day)) {
        nights.push(day);
      }
      const open = nights.filter((day) => !covered(day));
      if (nights.length === 0) {
        return [];
      }
      const source = window.stays.find((stay) => stay.fileId)?.fileId;
      const opens = source ? { fileId: source } : {};
      if (open.length > 0) {
        return [
          {
            state: "note",
            severity: "info",
            ...opens,
            title: `${nightsWord(open.length)} ${open.length === 1 ? "has" : "have"} no stay stored`,
            text: open.map(dayMonth).join(", "),
          },
        ];
      }
      const parts = [
        ...window.overnightLegs.filter((day) => nights.includes(day)).map((day) => `${dayMonth(day)} on the plane`),
        ...window.stays
          .filter((stay) => stay.checkIn && stay.checkOut)
          .map((stay) => {
            const count = nights.filter((day) => stay.checkIn!.day <= day && day < stay.checkOut!.day).length;
            return stay.name ? `${nightsWord(count)} at ${stay.name}` : `${nightsWord(count)} booked`;
          }),
      ];
      return [{ state: "ok", ...opens, title: "Every night has a place to sleep", text: parts.join(", then ") }];
    },
    run(files, now, held) {
      return confirmedSpans(files, now, held).flatMap((span) => {
        const landing = span.events
          .filter(({ fact }) => roleOf(fact) === "arrive")
          .map(({ fact }) => fact.value)
          .sort()[0];
        const stay = span.events
          .filter(({ fact }) => roleOf(fact) === "check-in")
          .sort((a, b) => a.fact.value.localeCompare(b.fact.value))[0];
        if (!landing || !stay || stay.fact.value <= landing) {
          return [];
        }
        return [
          {
            fileId: stay.fileId,
            severity: "info" as const,
            title: "A gap between landing and check-in",
            text:
              `You land ${shown(landing)} but the room starts ${shown(stay.fact.value)}. ` +
              `One night is not covered by anything stored here.`,
          } satisfies Finding,
        ];
      });
    },
  },
  {
    id: "lands-before-checkin",
    trip(window) {
      const landing = window.firstArrival;
      const stay = window.stays.find((candidate) => candidate.checkIn?.day === landing?.day);
      if (!landing?.time || !stay?.checkIn?.time || landing.time >= stay.checkIn.time) {
        return [];
      }
      return [
        {
          state: "note",
          severity: "info",
          ...(stay.fileId ? { fileId: stay.fileId } : {}),
          title: `You land at ${landing.time}; check-in opens at ${stay.checkIn.time}`,
          text: stay.name ? `At ${stay.name}, on ${dayMonth(landing.day)}.` : `On ${dayMonth(landing.day)}.`,
        },
      ];
    },
    run() {
      return [];
    },
  },
  {
    id: "checkin-opens",
    run(files, now) {
      return files.flatMap((file) =>
        usable(file)
          .filter(
            (fact) =>
              fact.kind === "event" &&
              roleOf(fact) === "depart" &&
              subjectOf(fact)?.mode === "flight" &&
              daysUntil(fact.value, now) === 1,
          )
          .map((fact) => ({
            fileId: file.id,
            severity: "info" as const,
            title: "Flight check-in likely opens today",
            text:
              `The flight leaves ${shown(fact.value)}${fact.time ? ` at ${fact.time}` : ""}, ` +
              `and airlines commonly open check-in 24 hours before departure.`,
          })),
      );
    },
  },
  {
    id: "invoice-overdue",
    run(files, now) {
      return files.flatMap((file) =>
        usable(file)
          .filter((fact) => fact.kind === "due" && daysUntil(fact.value, now) < 0)
          .map((fact) => ({
            fileId: file.id,
            severity: "overdue" as const,
            title: `Overdue by ${-daysUntil(fact.value, now)} days`,
            text: `This was due ${shown(fact.value)}.`,
          })),
      );
    },
  },
];

// There was a rule here counting expiry dates nobody had confirmed yet. It
// was removed rather than fixed: the bar above the files lists those very
// documents, by name, with the answer buttons attached. A rule that narrates
// what is already on screen is not an insight, and it teaches people that
// this section is filler.

const ORDER: Record<Severity, number> = { overdue: 0, soon: 1, info: 2 };

/** Everything the rules have to say, most urgent first. */
export function insightsFor(files: FactfulFile[], now: number, views?: readonly TripWindow[]): Insight[] {
  const found: Insight[] = [];
  // Only a trip not yet over has anything to check.
  const current = (views ?? []).filter((window) => window.start && daysUntil(window.end, now) >= 0);
  for (const rule of RULES) {
    const add = (finding: Finding, id: string) => found.push({ ...finding, ruleId: rule.id, id });
    if (views && rule.trip) {
      // With the trips read, a trip rule checks each trip as the hero does and
      // brings only what is not in order, under that trip's own identity.
      for (const window of current) {
        for (const check of rule.trip(window, files, now)) {
          if (check.state !== "ok") {
            add(
              { ...(check.fileId ? { fileId: check.fileId } : {}), severity: check.severity ?? "info", title: check.title, text: check.text ?? "" },
              `${rule.id}:${window.tag}:${check.fileId ?? "trip"}`,
            );
          }
        }
      }
    }
    // Travel no trip holds is still checked over its travel windows.
    for (const finding of rule.run(files, now, views)) {
      add(finding, `${rule.id}:${finding.fileId ?? "library"}`);
    }
  }
  return found.sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
}

/** One trip's checks for the Timeline: what is in order, and what is not, in the rules' order. */
export function tripChecks(window: TripWindow, files: FactfulFile[], now: number): Check[] {
  if (!window.start || !window.end) {
    return [];
  }
  return RULES.flatMap((rule) => (rule.trip ? rule.trip(window, files, now).map((check) => ({ ...check, ruleId: rule.id })) : []));
}
