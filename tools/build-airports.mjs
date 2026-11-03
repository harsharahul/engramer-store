#!/usr/bin/env node
/**
 * Builds the offline airport table the intel layer ships.
 *
 * Two public datasets join here, fetched separately and passed in as files
 * so the build itself never touches the network:
 *
 *  - OurAirports airports.csv (public domain): which airports exist, their
 *    IATA codes, cities, countries, and whether they see scheduled service.
 *    https://davidmegginson.github.io/ourairports-data/airports.csv
 *  - mwgg/Airports airports.json (MIT): IANA timezones, keyed by ICAO.
 *    https://github.com/mwgg/Airports
 *
 * Usage: node tools/build-airports.mjs <ourairports.csv> <mwgg-airports.json> [previous-airports.json]
 *
 * With the previous table, every code it knew stays known, even when the
 * airport has since lost its scheduled service or been renamed (bookings
 * already stored still name it): its position comes from the airport's row,
 * found by code or by a former code listed in its keywords.
 *
 * Writes apps/web/src/intel/tables/airports.json as [iata, city, country, zone,
 * lat, lon] tuples, sorted by code, scheduled-service airports only, with
 * coordinates to two decimals (about a kilometre, enough to draw a route and
 * work out the sun). A row without a timezone, a city or a position is
 * dropped: a code the table cannot place is worse than a code it does not
 * know.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const [csvPath, tzPath, previousPath] = process.argv.slice(2);
if (!csvPath || !tzPath) {
  console.error("usage: build-airports.mjs <ourairports.csv> <mwgg-airports.json>");
  process.exit(1);
}

function parseCsvLine(line) {
  const out = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      out.push(field);
      field = "";
    } else {
      field += ch;
    }
  }
  out.push(field);
  return out;
}

const lines = readFileSync(csvPath, "utf8").split("\n");
const header = parseCsvLine(lines[0]);
const col = (name) => header.indexOf(name);
const IATA = col("iata_code");
const TYPE = col("type");
const SCHED = col("scheduled_service");
const CITY = col("municipality");
const COUNTRY = col("iso_country");
const LAT = col("latitude_deg");
const LON = col("longitude_deg");
const KEYWORDS = col("keywords");
const round = (n) => Math.round(n * 100) / 100;

const zones = new Map();
const fallbackCities = new Map();
for (const entry of Object.values(JSON.parse(readFileSync(tzPath, "utf8")))) {
  if (entry.iata && entry.tz) {
    zones.set(entry.iata.toUpperCase(), entry.tz);
    if (entry.city) {
      fallbackCities.set(entry.iata.toUpperCase(), entry.city);
    }
  }
}

const rows = [];
const seen = new Set();
for (const line of lines.slice(1)) {
  if (!line.trim()) {
    continue;
  }
  const fields = parseCsvLine(line);
  const iata = fields[IATA]?.trim().toUpperCase();
  if (!iata || !/^[A-Z]{3}$/.test(iata) || seen.has(iata)) {
    continue;
  }
  if (fields[SCHED] !== "yes" || !fields[TYPE]?.includes("airport")) {
    continue;
  }
  const zone = zones.get(iata);
  if (!zone) {
    continue;
  }
  const city = (fields[CITY]?.trim() || fallbackCities.get(iata) || "").trim();
  if (!city) {
    continue;
  }
  const lat = Number.parseFloat(fields[LAT] ?? "");
  const lon = Number.parseFloat(fields[LON] ?? "");
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    continue;
  }
  seen.add(iata);
  rows.push([iata, city, fields[COUNTRY]?.trim() ?? "", zone, round(lat), round(lon)]);
}

if (previousPath) {
  // Where each code is now: its own row, else the row that lists it as a former code.
  const byCode = new Map();
  const byKeyword = new Map();
  for (const line of lines.slice(1)) {
    if (!line.trim()) {
      continue;
    }
    const fields = parseCsvLine(line);
    const iata = fields[IATA]?.trim().toUpperCase();
    if (iata && !byCode.has(iata)) {
      byCode.set(iata, fields);
    }
    for (const token of (fields[KEYWORDS] ?? "").split(/[,\s]+/)) {
      if (/^[A-Z]{3}$/.test(token) && !byKeyword.has(token)) {
        byKeyword.set(token, fields);
      }
    }
  }
  const kept = [];
  const lost = [];
  for (const [code, city, country, zone, lat, lon] of JSON.parse(readFileSync(previousPath, "utf8"))) {
    if (seen.has(code)) {
      continue;
    }
    const fields = byCode.get(code) ?? byKeyword.get(code);
    const la = lat ?? Number.parseFloat(fields?.[LAT] ?? "");
    const lo = lon ?? Number.parseFloat(fields?.[LON] ?? "");
    if (!Number.isFinite(la) || !Number.isFinite(lo)) {
      lost.push(code);
      continue;
    }
    seen.add(code);
    rows.push([code, city, country, zone, round(la), round(lo)]);
    kept.push(code);
  }
  console.log(`kept ${kept.length} codes the previous table knew; lost: ${lost.join(" ") || "none"}`);
}
rows.sort((a, b) => a[0].localeCompare(b[0]));

const out = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "apps",
  "web",
  "src",
  "intel",
  "tables",
  "airports.json",
);
mkdirSync(dirname(out), { recursive: true });
const json = JSON.stringify(rows);
writeFileSync(out, json);
console.log(`airports: ${rows.length} rows, ${(json.length / 1024).toFixed(0)}KB`);
