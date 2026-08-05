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

export type Severity = "overdue" | "soon" | "info";

export interface Insight {
  /** Stable across runs, so a dismissal can be remembered. */
  id: string;
  ruleId: string;
  /** The file it came from. Absent when the observation is library-wide. */
  fileId?: string;
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
            text:
              `Your passport expires ${shown(fact.value)}. Many countries require six ` +
              `months of validity, so it stops being useful for travel around ` +
              `${shown(useful)}. Renewals commonly take six to eight weeks.`,
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
          text:
            `This insurance period ended ${shown(fact.value)} and nothing newer has ` +
            `been added.`,
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
          text: `The warranty on this ends in ${daysUntil(fact.value, now)} days, on ${shown(
            fact.value,
          )}. Last window to claim.`,
        }));
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
            text: `This was due ${shown(fact.value)}, ${-daysUntil(fact.value, now)} days ago.`,
          })),
      );
    },
  },
  {
    id: "unconfirmed-expiries",
    run(files) {
      const waiting = files.filter((file) =>
        file.facts.some((fact) => fact.kind === "expiry" && !fact.confirmed && !fact.dismissed),
      );
      if (waiting.length === 0) {
        return [];
      }
      return [
        {
          severity: "info" as const,
          text:
            `${waiting.length} document${waiting.length === 1 ? "" : "s"} carry expiry ` +
            `dates you have not tracked yet.`,
        },
      ];
    },
  },
];

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
