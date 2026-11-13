#!/usr/bin/env node
/**
 * Builds the label table the intel layer ships.
 *
 * Source: tools/label-lexicon/dates.tsv. One label and its meaning on a
 * line, a tab between them; a line that starts with # is a heading. The
 * meanings are: event, check-in, check-out, depart, arrive, due, expiry,
 * issued, none ("none": the date is nobody's business as a reminder).
 *
 * Usage: node tools/build-label-lexicon.mjs
 *
 * Writes apps/web/src/intel/tables/labels.json as { v, edition, dates:
 * [label, meaning] pairs }, labels normalized and sorted; the edition is a
 * short digest of the pairs. A label listed with two
 * meanings, a meaning that is not in the list, or a line that cannot be
 * read stops the build: a wrong meaning is worse than a missing label.
 *
 * The normalization here is the app's (apps/web/src/intel/lexicon.ts); the
 * test suite checks that the written table is what the app reads from the
 * same source.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "tools", "label-lexicon", "dates.tsv");
const out = join(root, "apps", "web", "src", "intel", "tables", "labels.json");

const MEANINGS = new Set(["event", "check-in", "check-out", "depart", "arrive", "due", "expiry", "issued", "none"]);

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
  if (!MEANINGS.has(meaning)) {
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

const dates = [];
for (const [key, held] of [...meanings].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
  if (held.size > 1) {
    problems.push(`two meanings for "${key}": ${[...held].sort().join(", ")}`);
  } else {
    dates.push([key, [...held][0]]);
  }
}

if (problems.length > 0) {
  console.error(`${problems.length} problem(s) in ${source}:`);
  for (const problem of problems) {
    console.error(`  ${problem}`);
  }
  process.exit(1);
}

// The edition names the table's contents, so the app can tell a changed
// table from the one a file was last read with.
const edition = createHash("sha256").update(JSON.stringify(dates)).digest("hex").slice(0, 8);
writeFileSync(out, `${JSON.stringify({ v: 1, edition, dates })}\n`);
console.log(`${dates.length} labels written to ${out}`);
