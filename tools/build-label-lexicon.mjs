#!/usr/bin/env node
/**
 * Builds the label tables the intel layer ships.
 *
 * Sources, in tools/label-lexicon: dates.tsv (the labels beside dates) and
 * amounts.tsv (the labels beside amounts). One label and its meaning on a
 * line, a tab between them; a line that starts with # is a heading.
 *
 * A date label means: event, check-in, check-out, depart, arrive, due,
 * expiry, issued, or none ("none": the date is nobody's business as a
 * reminder). An amount label means: due (the whole amount still to pay),
 * total (the whole amount a document came to or was paid), or part (a
 * subtotal, a tax, a fee, a discount, a deposit, an earlier balance, a
 * rate: never the whole).
 *
 * Usage: node tools/build-label-lexicon.mjs
 *
 * Writes apps/web/src/intel/tables/labels.json as { v, edition, dates,
 * amounts }, each a list of [label, meaning] pairs, labels normalized and
 * sorted. The edition is a short digest of the date pairs: stored files are
 * looked at again for a changed date table, and never for an amount row. A
 * label listed with two meanings, a meaning that is not in its list, or a
 * line that cannot be read stops the build: a wrong meaning is worse than a
 * missing label.
 *
 * The normalization here is the app's (apps/web/src/intel/lexicon.ts); the
 * test suite checks that the written table is what the app reads from the
 * same sources.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sources = join(root, "tools", "label-lexicon");
const out = join(root, "apps", "web", "src", "intel", "tables", "labels.json");

const DATE_MEANINGS = new Set(["event", "check-in", "check-out", "depart", "arrive", "due", "expiry", "issued", "none"]);
const AMOUNT_MEANINGS = new Set(["due", "total", "part"]);

function normalizeLabel(label) {
  const words = label
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  while (words.length > 1 && (words[words.length - 1] === "date" || words[words.length - 1] === "on")) {
    words.pop();
  }
  return words.join(" ");
}

/** One source file as sorted [label, meaning] pairs, or the problems that stop the build. */
function readTable(name, known) {
  const source = join(sources, name);
  const meanings = new Map();
  const problems = [];
  for (const line of readFileSync(source, "utf8").split(/\r?\n/)) {
    if (!line.trim() || line.startsWith("#")) {
      continue;
    }
    const [label, meaning, ...more] = line.split("\t").map((part) => part.trim());
    if (!label || !meaning || more.length > 0) {
      problems.push(`no label and meaning in "${line.trim()}"`);
      continue;
    }
    if (!known.has(meaning)) {
      problems.push(`unknown meaning "${meaning}" for "${label}"`);
      continue;
    }
    const key = normalizeLabel(label);
    if (!key) {
      problems.push(`a label with no words: "${label}"`);
      continue;
    }
    meanings.set(key, (meanings.get(key) ?? new Set()).add(meaning));
  }
  const rows = [];
  for (const [key, held] of [...meanings].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (held.size > 1) {
      problems.push(`two meanings for "${key}": ${[...held].sort().join(", ")}`);
    } else {
      rows.push([key, [...held][0]]);
    }
  }
  if (problems.length > 0) {
    console.error(`${problems.length} problem(s) in ${source}:`);
    for (const problem of problems) {
      console.error(`  ${problem}`);
    }
    process.exit(1);
  }
  return rows;
}

const dates = readTable("dates.tsv", DATE_MEANINGS);
const amounts = readTable("amounts.tsv", AMOUNT_MEANINGS);

// The edition names the date rows, so the app can tell a changed date table
// from the one a file was last read with.
const edition = createHash("sha256").update(JSON.stringify(dates)).digest("hex").slice(0, 8);
writeFileSync(out, `${JSON.stringify({ v: 1, edition, dates, amounts })}\n`);
console.log(`${dates.length} date labels and ${amounts.length} amount labels written to ${out}`);
