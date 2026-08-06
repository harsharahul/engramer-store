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

import type { Fact } from "./facts";
import { daysUntil } from "./dates";
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

interface Rule {
  id: string;
  run(files: FactfulFile[], now: number): Finding[];
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
  return file.facts.filter((fact) => fact.confirmed && !fact.dismissed);
}

function expiriesOf(files: FactfulFile[], document: Fact["document"]) {
  return files.flatMap((file) =>
    usable(file)
      .filter((fact) => fact.kind === "expiry" && fact.document === document)
      .map((fact) => ({ file, fact })),
  );
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
function confirmedSpans(files: FactfulFile[], now: number): TravelSpan[] {
  return travelSpans(files, (fact) => fact.confirmed === true && !fact.dismissed).filter(
    (span) => daysUntil(span.end, now) >= 0,
  );
}

const ARRIVES = /\barriv/i;
const CHECKIN = /^check[- ]?in\b/i;
const FLIGHT = /\bflight\b|\bdepart/i;

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
    run(files, now) {
      const passport = expiriesOf(files, "passport")
        .sort((a, b) => a.fact.value.localeCompare(b.fact.value))
        .at(-1);
      if (!passport) {
        return [];
      }
      const expiry = passport.fact.value;
      const cutoff = monthsBefore(expiry, PASSPORT_RULE_MONTHS);
      return confirmedSpans(files, now).flatMap((span): Finding[] => {
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
    run(files, now) {
      const attached = [...expiriesOf(files, "residence-permit"), ...expiriesOf(files, "visa")];
      return confirmedSpans(files, now).flatMap((span) =>
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
    id: "checkin-gap",
    run(files, now) {
      return confirmedSpans(files, now).flatMap((span) => {
        const landing = span.events
          .filter(({ fact }) => ARRIVES.test(fact.label ?? ""))
          .map(({ fact }) => fact.value)
          .sort()[0];
        const stay = span.events
          .filter(({ fact }) => CHECKIN.test(fact.label ?? ""))
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
    id: "checkin-opens",
    run(files, now) {
      return files.flatMap((file) =>
        usable(file)
          .filter(
            (fact) =>
              fact.kind === "event" &&
              FLIGHT.test(fact.label ?? "") &&
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
export function insightsFor(files: FactfulFile[], now: number): Insight[] {
  const found: Insight[] = [];
  for (const rule of RULES) {
    for (const finding of rule.run(files, now)) {
      found.push({
        ...finding,
        ruleId: rule.id,
        id: `${rule.id}:${finding.fileId ?? "library"}`,
      });
    }
  }
  return found.sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
}
