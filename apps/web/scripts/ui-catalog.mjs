#!/usr/bin/env node
// Desktop screen catalog for the web app.
//
//   node catalog.mjs capture <outDir>
//   node catalog.mjs compare <baselineDir> <afterDir> <diffDir>
//
// capture: drives the app in Chromium and WebKit across viewports and themes with the Mac
// desktop shell stubbed, screenshots every catalogued state, runs layout invariants in the page,
// and writes <outDir>/report.json, <outDir>/summary.md and <outDir>/meta.json.
// compare: diffs two capture dirs pixel by pixel (per-channel delta > 16) and writes
// red-highlighted diff PNGs plus <diffDir>/compare.md.
//
// Environment overrides (all optional):
//   CATALOG_URL       app origin (default http://127.0.0.1:3181)
//   CATALOG_EMAIL / CATALOG_PASSPHRASE   test account
//   CATALOG_JOBS      parallel combinations (default 4)
//   CATALOG_REDUCED   "1": all four sizes for chromium light only, 1280x800 for the rest
//   CATALOG_ONLY      comma list of engine:WxH:theme to run (debug), e.g. chromium:1280x800:light
//   CATALOG_STATES    comma list of state names or numbers to run (debug)
//
// The vault is shared test data: this script only views, opens, hovers and closes.

import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
// playwright-core and the browser builds are found through the environment
// (CATALOG_PLAYWRIGHT, CATALOG_CHROMIUM, CATALOG_WEBKIT); unset, Playwright's
// own installed browsers are used.
const PW = process.env.CATALOG_PLAYWRIGHT || "playwright-core";
const { chromium, webkit } = require(PW);
const CHROMIUM_EXE = process.env.CATALOG_CHROMIUM || undefined;
const WEBKIT_EXE = process.env.CATALOG_WEBKIT || undefined;

const BASE = process.env.CATALOG_URL || "http://127.0.0.1:3181";
const EMAIL = process.env.CATALOG_EMAIL || "";
const PASSPHRASE = process.env.CATALOG_PASSPHRASE || "";
if (!EMAIL || !PASSPHRASE) {
  console.error("set CATALOG_EMAIL and CATALOG_PASSPHRASE to a test account on the server");
  process.exit(1);
}
const JOBS = Math.max(1, Number(process.env.CATALOG_JOBS || 4));

const SIZES = [
  [1024, 700],
  [1280, 800],
  [1440, 900],
  [1920, 1080],
];
const THEMES = ["light", "dark"];
const ENGINES = ["chromium", "webkit"];

function buildMatrix() {
  const combos = [];
  const reduced = process.env.CATALOG_REDUCED === "1";
  for (const engine of ENGINES) {
    for (const theme of THEMES) {
      for (const [w, h] of SIZES) {
        if (reduced && !(engine === "chromium" && theme === "light") && !(w === 1280 && h === 800)) continue;
        combos.push({ engine, theme, w, h });
      }
    }
  }
  const only = process.env.CATALOG_ONLY;
  if (only) {
    const want = new Set(only.split(",").map((s) => s.trim()));
    return combos.filter((c) => want.has(`${c.engine}:${c.w}x${c.h}:${c.theme}`));
  }
  return combos;
}

// ------------------------------------------------------------------------------------------
// Page-side invariants. Runs inside the page via page.evaluate, so it must be self-contained.
// ------------------------------------------------------------------------------------------
function pageInvariants(opts) {
  const IW = window.innerWidth;
  const IH = window.innerHeight;
  const de = document.documentElement;
  const csCache = new WeakMap();
  const cs = (e) => {
    let s = csCache.get(e);
    if (!s) {
      s = getComputedStyle(e);
      csCache.set(e, s);
    }
    return s;
  };
  const vis = (e) => {
    if (typeof e.checkVisibility === "function") {
      if (!e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    } else {
      const s = cs(e);
      if (s.display === "none" || s.visibility !== "visible" || parseFloat(s.opacity) === 0) return false;
    }
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const desc = (e) => {
    const cls =
      typeof e.className === "string"
        ? e.className
            .split(/\s+/)
            .filter((c) => c && !c.startsWith("tw:"))
            .slice(0, 3)
            .join(".")
        : "";
    const slot = e.getAttribute("data-slot");
    const role = e.getAttribute("role");
    const label = (e.getAttribute("aria-label") || e.getAttribute("title") || "").slice(0, 28);
    const own = [...e.childNodes]
      .filter((n) => n.nodeType === 3)
      .map((n) => n.textContent.trim())
      .join(" ")
      .slice(0, 24);
    return (
      e.tagName.toLowerCase() +
      (cls ? "." + cls : "") +
      (slot ? `{${slot}}` : "") +
      (role ? `[role=${role}]` : "") +
      (label ? `[${label}]` : "") +
      (own ? ` "${own}"` : "")
    );
  };
  const round = (n) => Math.round(n * 10) / 10;
  const all = [...document.body.querySelectorAll("*")].filter(
    (e) => !["SCRIPT", "STYLE", "NOSCRIPT", "LINK", "META", "TEMPLATE"].includes(e.tagName),
  );

  // a. horizontal overflow ------------------------------------------------------------------
  const clippedByAncestor = (e) => {
    const pos = cs(e).position;
    if (pos === "fixed") return false;
    for (let p = e.parentElement; p && p !== document.body && p !== de; p = p.parentElement) {
      const ps = cs(p);
      if (ps.overflowX !== "visible") {
        if (pos === "absolute" && ps.position === "static") continue;
        return true;
      }
    }
    return false;
  };
  const overSet = new Set();
  for (const e of all) {
    if (e instanceof SVGElement && !(e instanceof SVGSVGElement)) continue;
    const r = e.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    if (!(r.right > IW + 0.5 || r.left < -0.5)) continue;
    if (r.left >= IW || r.right <= 0) continue; // fully off-screen on purpose
    if (!vis(e)) continue;
    if (clippedByAncestor(e)) continue;
    overSet.add(e);
  }
  const offenders = [];
  for (const e of overSet) {
    let nested = false;
    for (let p = e.parentElement; p; p = p.parentElement) {
      if (overSet.has(p)) {
        nested = true;
        break;
      }
    }
    if (nested) continue;
    const r = e.getBoundingClientRect();
    offenders.push({
      el: desc(e),
      left: round(r.left),
      right: round(r.right),
      overBy: round(Math.max(r.right - IW, -r.left)),
    });
  }
  const horizontalOverflow = {
    pass: !(de.scrollWidth > IW) && offenders.length === 0,
    scrollWidth: de.scrollWidth,
    innerWidth: IW,
    docOverflow: de.scrollWidth > IW,
    offenderCount: offenders.length,
    offenders: offenders.slice(0, 10),
  };

  // b. overlay on top -----------------------------------------------------------------------
  const OV =
    '[role=menu],[role=dialog],[role=listbox],[data-open],.search-panel,.ctx-menu,[class*=popover],[class*=menu],[class*=panel],.preview-shell,[class*=modal],[class*=toast]';
  const overlays = [...document.querySelectorAll(OV)].filter((e) => {
    const s = cs(e);
    if (s.position !== "absolute" && s.position !== "fixed") return false;
    if (s.pointerEvents === "none") return false;
    if (!vis(e)) return false;
    const r = e.getBoundingClientRect();
    return r.right > 0 && r.left < IW && r.bottom > 0 && r.top < IH;
  });
  const ovSet = new Set(overlays);
  const topOverlays = overlays.filter((e) => {
    for (let p = e.parentElement; p; p = p.parentElement) if (ovSet.has(p)) return false;
    return true;
  });
  const overlayResults = [];
  for (const e of topOverlays) {
    const r = e.getBoundingClientRect();
    const x0 = Math.max(r.left, 0);
    const y0 = Math.max(r.top, 0);
    const x1 = Math.min(r.right, IW - 1);
    const y1 = Math.min(r.bottom, IH - 1);
    const radius = Math.max(0, parseFloat(cs(e).borderTopLeftRadius) || 0);
    const inset = Math.max(8, Math.ceil(radius * 0.3) + 1);
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    const pts = [["center", cx, cy]];
    if (x1 - x0 > inset * 2 && y1 - y0 > inset * 2) {
      pts.push(["top-left", x0 + inset, y0 + inset]);
      pts.push(["top-right", x1 - inset, y0 + inset]);
      pts.push(["bottom-left", x0 + inset, y1 - inset]);
      pts.push(["bottom-right", x1 - inset, y1 - inset]);
    }
    const covered = [];
    for (const [name, x, y] of pts) {
      const hit = document.elementFromPoint(x, y);
      if (!hit || !(hit === e || e.contains(hit))) {
        covered.push({ at: name, by: hit ? desc(hit) : "none", byTag: hit ? hit.tagName.toLowerCase() : null, byClass: hit && typeof hit.className === "string" ? hit.className.split(/\s+/).filter((c) => c && !c.startsWith("tw:")).join(" ") : null });
      }
    }
    overlayResults.push({ el: desc(e), sampled: pts.length, ok: covered.length === 0, covered });
  }
  const overlayOnTop = {
    pass: overlayResults.every((o) => o.ok),
    checked: overlayResults.length,
    overlays: overlayResults,
  };

  // c. toolbar centerline -------------------------------------------------------------------
  let toolbarCenterline;
  const tb = document.querySelector(".topbar");
  if (!tb) {
    toolbarCenterline = { pass: true, applicable: false, note: "no .topbar" };
  } else {
    const items = [];
    for (const c of tb.children) {
      if (!vis(c)) continue;
      const r = c.getBoundingClientRect();
      // A popover's 1px focus guards are not controls.
      if (r.height < 4) continue;
      items.push({ kind: "child", el: desc(c), cy: round(r.top + r.height / 2), h: round(r.height) });
    }
    const inDropdown = (c) => {
      for (let p = c.parentElement; p && p !== tb; p = p.parentElement) {
        const pos = cs(p).position;
        if (pos === "absolute" || pos === "fixed") return true;
      }
      return false;
    };
    for (const c of tb.querySelectorAll("button, input:not([type=hidden]), [role=button]")) {
      if (!vis(c)) continue;
      if (inDropdown(c)) continue; // controls inside a dropdown (e.g. the search panel) are not toolbar controls
      const r = c.getBoundingClientRect();
      if (r.height < 4) continue; // a popover's focus guards carry role=button at 1px tall
      items.push({ kind: "control", el: desc(c), cy: round(r.top + r.height / 2), h: round(r.height) });
    }
    const cys = items.map((i) => i.cy);
    const maxDiff = cys.length ? round(Math.max(...cys) - Math.min(...cys)) : 0;
    toolbarCenterline = { pass: maxDiff <= 1, applicable: true, maxDiff, count: items.length, items: items.slice(0, 14) };
  }

  // d. clipped text -------------------------------------------------------------------------
  const clipped = [];
  for (const e of all) {
    if (["INPUT", "TEXTAREA", "SELECT", "OPTION", "SVG", "svg"].includes(e.tagName)) continue;
    if (e instanceof SVGElement) continue;
    let hasText = false;
    for (const n of e.childNodes) {
      if (n.nodeType === 3 && n.textContent.trim()) {
        hasText = true;
        break;
      }
    }
    if (!hasText) continue;
    const s = cs(e);
    if (s.display === "inline") continue;
    if (e.clientWidth < 5) continue;
    if (e.scrollWidth <= e.clientWidth + 1) continue;
    if (s.textOverflow.includes("ellipsis")) continue;
    if (s.overflowX === "auto" || s.overflowX === "scroll") continue;
    if (!vis(e)) continue;
    clipped.push({
      el: desc(e),
      text: e.textContent.trim().slice(0, 40),
      scrollWidth: e.scrollWidth,
      clientWidth: e.clientWidth,
      overflowX: s.overflowX,
    });
  }
  const clippedText = { pass: clipped.length === 0, count: clipped.length, items: clipped.slice(0, 10) };

  // e. small targets (<= 1024 wide only) ----------------------------------------------------
  let smallTargets;
  if (!opts.checkSmall) {
    smallTargets = { pass: true, applicable: false, note: "only checked at widths <= 1024" };
  } else {
    const groups = new Map();
    let total = 0;
    const targets = document.querySelectorAll('button, a, [role=button], input:not([type=hidden]):not([type=file])');
    for (const e of targets) {
      const r = e.getBoundingClientRect();
      if (!(r.width < 28 || r.height < 28)) continue;
      if (r.right <= 0 || r.left >= IW || r.bottom <= 0 || r.top >= IH) continue;
      if (!vis(e)) continue;
      const s = cs(e);
      if (s.pointerEvents === "none") continue;
      if (e.getAttribute("aria-hidden") === "true") continue;
      total++;
      const key = desc(e);
      const g = groups.get(key);
      if (g) g.n++;
      else groups.set(key, { el: key, n: 1, w: round(r.width), h: round(r.height) });
    }
    const items = [...groups.values()].sort((a, b) => b.n - a.n).slice(0, 10);
    smallTargets = { pass: total === 0, applicable: true, count: total, unique: groups.size, items };
  }

  return { horizontalOverflow, overlayOnTop, toolbarCenterline, clippedText, smallTargets };
}

// ------------------------------------------------------------------------------------------
// Session helpers
// ------------------------------------------------------------------------------------------
const FILE_CARD = ".card:not(.folder-card)";

async function signIn(page) {
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForSelector('input[type="email"]', { timeout: 30000 });
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASSPHRASE);
  await page.keyboard.press("Enter");
  await page.waitForSelector(".sidebar-toggle", { timeout: 90000 });
  await page.waitForSelector(".card", { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(800);
}

async function isVisible(page, selector) {
  return page
    .locator(selector)
    .first()
    .isVisible()
    .catch(() => false);
}

async function closeOverlays(page) {
  for (let i = 0; i < 4; i++) {
    const open = await page.evaluate(() => {
      const vis = (s) => [...document.querySelectorAll(s)].some((e) => e.getBoundingClientRect().width > 0);
      return vis(".ctx-menu, .activity-panel, .search-panel, .preview-shell, [role=dialog]");
    });
    if (!open) return;
    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);
    if (await isVisible(page, ".preview-shell")) {
      await page.locator('.preview-shell button[title="Close"]').first().click({ timeout: 1500 }).catch(() => {});
      await page.waitForTimeout(200);
    }
  }
}

async function nav(page, label) {
  const re = new RegExp("^\\s*" + label + "\\s*$");
  await page.locator("aside.sidebar .nav-item").filter({ hasText: re }).first().click({ timeout: 8000 });
}

async function ensureGrid(page) {
  const grid = page.locator('button[title="Grid"]').first();
  if ((await grid.count()) === 0) return;
  const active = await grid.evaluate((e) => e.classList.contains("active")).catch(() => true);
  if (!active) await grid.click({ timeout: 3000 }).catch(() => {});
}

async function toRoot(page) {
  await closeOverlays(page);
  const si = page.locator(".searchbox input").first();
  if ((await si.inputValue().catch(() => "")) !== "") await si.fill("");
  await page.evaluate(() => document.activeElement && document.activeElement.blur && document.activeElement.blur());
  await nav(page, "Files");
  await page.waitForTimeout(350);
  await ensureGrid(page);
  const selected = await page.locator(".card.selected, .row.selected").count();
  if (selected > 0) {
    // click blank space in the main area to clear the selection (never a card)
    const vp = page.viewportSize();
    await page.mouse.click(Math.round(vp.width * 0.45), Math.round(vp.height * 0.93)).catch(() => {});
    await page.waitForTimeout(200);
  }
}

async function ensureApp(page) {
  const ok = await page
    .waitForSelector(".sidebar-toggle", { timeout: 2500 })
    .then(() => true)
    .catch(() => false);
  if (ok) return;
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  const hasLogin = await page
    .waitForSelector('input[type="email"]', { timeout: 6000 })
    .then(() => true)
    .catch(() => false);
  if (hasLogin) await signIn(page);
  else await page.waitForSelector(".sidebar-toggle", { timeout: 20000 });
}

async function openNotes(page) {
  await page.locator('.card.folder-card[title="Notes"]').first().click({ timeout: 8000 });
  await page.waitForSelector(FILE_CARD, { timeout: 8000 });
  await page.waitForTimeout(500);
}

async function clickToggle(page, title) {
  await page.locator(`button[title="${title}"]`).first().click({ timeout: 5000 });
  await page.waitForTimeout(350);
}

// ------------------------------------------------------------------------------------------
// States. run() drives the app into the state and may return a cleanup function.
// ------------------------------------------------------------------------------------------
const STATES = [
  { name: "files-grid", run: async (page) => { await toRoot(page); } },
  {
    name: "files-list",
    run: async (page) => {
      await toRoot(page);
      await clickToggle(page, "List");
      return async () => { await clickToggle(page, "Grid"); };
    },
  },
  {
    name: "sidebar-rail",
    run: async (page) => {
      await toRoot(page);
      await page.locator(".sidebar-toggle").first().click({ timeout: 5000 });
      await page.waitForTimeout(600);
      return async () => {
        await page.locator(".sidebar-toggle").first().click({ timeout: 5000 });
        await page.waitForTimeout(500);
      };
    },
  },
  { name: "folder", run: async (page) => { await toRoot(page); await openNotes(page); } },
  { name: "recent", run: async (page) => { await toRoot(page); await nav(page, "Recent"); await page.waitForTimeout(900); } },
  { name: "photos", run: async (page) => { await toRoot(page); await nav(page, "Photos"); await page.waitForTimeout(1200); } },
  { name: "favorites", run: async (page) => { await toRoot(page); await nav(page, "Favorites"); await page.waitForTimeout(900); } },
  { name: "shared", run: async (page) => { await toRoot(page); await nav(page, "Shared"); await page.waitForTimeout(900); } },
  { name: "trash", run: async (page) => { await toRoot(page); await nav(page, "Trash"); await page.waitForTimeout(900); } },
  {
    name: "search-focused",
    run: async (page) => {
      await toRoot(page);
      await page.locator(".searchbox input").first().click({ timeout: 5000 });
      await page.waitForSelector(".search-panel", { timeout: 4000 });
      await page.waitForTimeout(300);
    },
  },
  {
    name: "search-results",
    run: async (page) => {
      await toRoot(page);
      await page.locator(".searchbox input").first().click({ timeout: 5000 });
      await page.keyboard.type("no", { delay: 60 });
      await page.getByText(/\d+ results?/).first().waitFor({ timeout: 6000 });
      await page.waitForTimeout(600);
      return async () => { await page.locator(".searchbox input").first().fill(""); };
    },
  },
  {
    name: "preview-text",
    run: async (page) => {
      await toRoot(page);
      await openNotes(page);
      await page.locator('.card[title$=".txt"]:not(.folder-card)').first().dblclick({ timeout: 5000 });
      await page.waitForSelector(".preview-shell", { timeout: 8000 });
      await page.waitForTimeout(1000);
    },
  },
  {
    name: "details-open",
    run: async (page) => {
      await toRoot(page);
      await openNotes(page);
      await page.locator(FILE_CARD).first().click({ timeout: 5000 });
      await page.waitForTimeout(400);
      const w = await page.locator("aside.details").first().evaluate((e) => e.getBoundingClientRect().width).catch(() => 0);
      let toggled = false;
      if (w < 50) {
        await page.locator(".info-toggle").first().click({ timeout: 3000 });
        toggled = true;
        await page.waitForTimeout(500);
      }
      return async () => {
        if (toggled) await page.locator(".info-toggle").first().click({ timeout: 3000 }).catch(() => {});
      };
    },
  },
  {
    name: "file-context-menu",
    run: async (page) => {
      await toRoot(page);
      await openNotes(page);
      await page.locator(FILE_CARD).first().click({ button: "right", timeout: 5000 });
      await page.waitForSelector(".ctx-menu", { timeout: 4000 });
      await page.waitForTimeout(250);
    },
  },
  {
    name: "new-menu",
    run: async (page) => {
      await toRoot(page);
      await page.locator(".new-btn").first().click({ timeout: 5000 });
      await page.waitForSelector(".ctx-menu", { timeout: 4000 });
      await page.waitForTimeout(250);
    },
  },
  {
    name: "sort-menu",
    run: async (page) => {
      await toRoot(page);
      await page.locator(".sort-button").first().click({ timeout: 5000 });
      await page.waitForSelector(".ctx-menu", { timeout: 4000 });
      await page.waitForTimeout(250);
    },
  },
  {
    name: "notices",
    run: async (page) => {
      await toRoot(page);
      await page.locator(".activity-bell").first().click({ timeout: 5000 });
      await page.waitForSelector(".activity-panel", { timeout: 4000 });
      await page.waitForTimeout(500);
    },
  },
  {
    name: "account-menu",
    run: async (page) => {
      await toRoot(page);
      await page.locator(".account-button").first().click({ timeout: 5000 });
      await page.waitForSelector(".ctx-menu", { timeout: 4000 });
      await page.waitForTimeout(250);
    },
  },
  {
    name: "profile",
    run: async (page) => {
      await toRoot(page);
      await page.locator(".account-button").first().click({ timeout: 5000 });
      await page.getByRole("menuitem", { name: /Profile and settings/ }).click({ timeout: 4000 });
      await page.waitForSelector(".profile", { timeout: 8000 });
      await page.waitForTimeout(1200);
    },
  },
  {
    // extra state beyond the required set: list view with real file rows
    name: "folder-list",
    run: async (page) => {
      await toRoot(page);
      await openNotes(page);
      await clickToggle(page, "List");
      return async () => { await clickToggle(page, "Grid"); };
    },
  },
];

const pad2 = (n) => String(n).padStart(2, "0");

function stateFilter() {
  const want = process.env.CATALOG_STATES;
  if (!want) return null;
  return new Set(want.split(",").map((s) => s.trim()));
}

async function runCombo(combo, outDir, log) {
  const { engine, theme, w, h } = combo;
  const label = `${engine} ${w}x${h} ${theme}`;
  const browser = await (engine === "chromium" ? chromium : webkit).launch({
    executablePath: engine === "chromium" ? CHROMIUM_EXE : WEBKIT_EXE,
    headless: true,
  });
  const entries = [];
  const pageErrors = new Set();
  try {
    const ctx = await browser.newContext({
      viewport: { width: w, height: h },
      deviceScaleFactor: 1,
      serviceWorkers: "block",
      colorScheme: theme,
      locale: "en-US",
      timezoneId: "UTC",
    });
    // Mac desktop shell stub. Commands that the app iterates over must return arrays;
    // returning null from every command crashes the app (blank screen), which is a stub artifact.
    await ctx.addInitScript((t) => {
      const ARRAYS = ["watched_folders", "watched_add", "watched_remove", "watched_scan", "offline_status", "picked_sweep"];
      window.__TAURI__ = {
        core: { invoke: async (cmd) => (ARRAYS.includes(cmd) ? [] : null) },
        event: { listen: async () => () => {} },
      };
      try { localStorage.setItem("engram-theme", t); } catch {}
    }, theme);
    const page = await ctx.newPage();
    page.on("pageerror", (e) => pageErrors.add(String(e).split("\n")[0].slice(0, 200)));
    await signIn(page);
    const only = stateFilter();

    for (let i = 0; i < STATES.length; i++) {
      const st = STATES[i];
      const nn = pad2(i + 1);
      if (only && !only.has(st.name) && !only.has(nn) && !only.has(String(i + 1))) continue;
      const file = `${engine}-${w}x${h}-${theme}-${nn}-${st.name}.png`;
      const base = { engine, viewport: `${w}x${h}`, theme, state: st.name };
      try {
        const cleanup = await st.run(page);
        await page.waitForTimeout(250);
        await page.screenshot({ path: path.join(outDir, file), animations: "disabled", caret: "hide" });
        const checks = await page.evaluate(pageInvariants, { checkSmall: w <= 1024 });
        entries.push({ file, ...base, checks });
        log(`${label} ${nn}-${st.name} ok`);
        if (cleanup) await cleanup().catch(() => {});
      } catch (err) {
        const reason = String(err && err.message ? err.message : err).split("\n")[0].slice(0, 220);
        entries.push({ file: null, ...base, unreachable: reason, expectedFile: file });
        log(`${label} ${nn}-${st.name} UNREACHABLE: ${reason}`);
      }
      // Always return to a known baseline before the next state.
      try {
        await ensureApp(page);
        await toRoot(page);
      } catch (err) {
        log(`${label} recover failed after ${st.name}: ${String(err.message).split("\n")[0]}`);
        try {
          await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
          await ensureApp(page);
        } catch {}
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }
  return { entries, pageErrors: [...pageErrors], label };
}

// ------------------------------------------------------------------------------------------
// capture
// ------------------------------------------------------------------------------------------
const INVARIANTS = ["horizontalOverflow", "overlayOnTop", "toolbarCenterline", "clippedText", "smallTargets"];

function detailFor(inv, c) {
  const short = (s, n = 90) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
  switch (inv) {
    case "horizontalOverflow": {
      const bits = [];
      if (c.docOverflow) bits.push(`scrollWidth ${c.scrollWidth} > innerWidth ${c.innerWidth}`);
      for (const o of c.offenders.slice(0, 3)) bits.push(`${short(o.el, 60)} over by ${o.overBy}px (${o.left}..${o.right})`);
      if (c.offenderCount > 3) bits.push(`+${c.offenderCount - 3} more`);
      return bits.join("; ");
    }
    case "overlayOnTop":
      return c.overlays
        .filter((o) => !o.ok)
        .map((o) => `${short(o.el, 50)} covered at ${o.covered.map((x) => x.at).join(",")} by ${short(o.covered[0].by, 60)}`)
        .join("; ");
    case "toolbarCenterline":
      return `maxDiff ${c.maxDiff}px; ` + c.items.map((i) => `${short(i.el, 32)}=${i.cy}`).slice(0, 6).join(", ");
    case "clippedText":
      return `${c.count}: ` + c.items.slice(0, 3).map((i) => `${short(i.el, 40)} "${short(i.text, 24)}" ${i.scrollWidth}>${i.clientWidth}`).join("; ");
    case "smallTargets":
      return `${c.count} (${c.unique} unique): ` + c.items.slice(0, 3).map((i) => `${short(i.el, 44)} ${i.w}x${i.h}${i.n > 1 ? " x" + i.n : ""}`).join("; ");
    default:
      return "";
  }
}

function writeSummary(outDir, entries, meta) {
  const ok = entries.filter((e) => e.file);
  const unreachable = entries.filter((e) => !e.file);
  const counts = Object.fromEntries(INVARIANTS.map((i) => [i, 0]));
  const rows = [];
  for (const e of ok) {
    for (const inv of INVARIANTS) {
      const c = e.checks[inv];
      if (c && c.pass === false) {
        counts[inv]++;
        rows.push({ inv, e, detail: detailFor(inv, c) });
      }
    }
  }
  const esc = (s) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
  const lines = [];
  lines.push("# Screen catalog summary", "");
  lines.push(`- Captured: ${ok.length} screenshots, ${unreachable.length} states unreachable`);
  lines.push(`- Matrix: ${meta.matrix.map((m) => `${m.engine} ${m.w}x${m.h} ${m.theme}`).length} combinations (${meta.reduced ? "reduced" : "full"})`);
  lines.push(`- Runtime: ${meta.runtimeSeconds}s`, "");
  lines.push("## Failures per invariant", "", "| invariant | failing states |", "|---|---|");
  for (const inv of INVARIANTS) lines.push(`| ${inv} | ${counts[inv]} |`);
  lines.push("");
  for (const inv of INVARIANTS) {
    const r = rows.filter((x) => x.inv === inv);
    lines.push(`## ${inv} (${r.length})`, "");
    if (!r.length) {
      lines.push("No failures.", "");
      continue;
    }
    lines.push("| state | engine | viewport | theme | detail |", "|---|---|---|---|---|");
    r.sort((a, b) => a.e.state.localeCompare(b.e.state) || a.e.engine.localeCompare(b.e.engine) || a.e.viewport.localeCompare(b.e.viewport) || a.e.theme.localeCompare(b.e.theme));
    for (const x of r) lines.push(`| ${x.e.state} | ${x.e.engine} | ${x.e.viewport} | ${x.e.theme} | ${esc(x.detail)} |`);
    lines.push("");
  }
  lines.push(`## Unreachable states (${unreachable.length})`, "");
  if (!unreachable.length) lines.push("None.", "");
  else {
    lines.push("| state | engine | viewport | theme | reason |", "|---|---|---|---|---|");
    for (const u of unreachable) lines.push(`| ${u.state} | ${u.engine} | ${u.viewport} | ${u.theme} | ${esc(u.unreachable)} |`);
    lines.push("");
  }
  if (meta.pageErrors && Object.keys(meta.pageErrors).length) {
    lines.push("## Page errors (uncaught exceptions seen while capturing)", "");
    for (const [k, v] of Object.entries(meta.pageErrors)) lines.push(`- ${k}: ${v.map(esc).join(" | ")}`);
    lines.push("");
  }
  fs.writeFileSync(path.join(outDir, "summary.md"), lines.join("\n"));
  return { counts, rows, unreachable };
}

async function capture(outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  for (const f of fs.readdirSync(outDir)) if (f.endsWith(".png")) fs.unlinkSync(path.join(outDir, f));
  const matrix = buildMatrix();
  const t0 = Date.now();
  const log = (m) => process.stderr.write(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}\n`);
  log(`capturing ${matrix.length} combinations x ${STATES.length} states, ${JOBS} parallel`);
  const results = new Array(matrix.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(JOBS, matrix.length) }, async () => {
      while (next < matrix.length) {
        const idx = next++;
        try {
          results[idx] = await runCombo(matrix[idx], outDir, log);
        } catch (err) {
          log(`combo failed ${JSON.stringify(matrix[idx])}: ${String(err.message).split("\n")[0]}`);
          results[idx] = { entries: [], pageErrors: [], label: JSON.stringify(matrix[idx]), failed: String(err.message).split("\n")[0] };
        }
      }
    }),
  );
  const entries = results.flatMap((r) => r.entries);
  const pageErrors = {};
  for (const r of results) if (r.pageErrors.length) pageErrors[r.label] = r.pageErrors;
  const runtimeSeconds = Math.round((Date.now() - t0) / 1000);
  const meta = {
    baseUrl: BASE,
    matrix,
    reduced: process.env.CATALOG_REDUCED === "1",
    states: STATES.map((s, i) => `${pad2(i + 1)}-${s.name}`),
    runtimeSeconds,
    pageErrors,
    failedCombos: results.filter((r) => r.failed).map((r) => ({ label: r.label, reason: r.failed })),
  };
  fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify(entries, null, 1));
  fs.writeFileSync(path.join(outDir, "meta.json"), JSON.stringify(meta, null, 1));
  const { counts, unreachable } = writeSummary(outDir, entries, meta);
  const shots = entries.filter((e) => e.file).length;
  log(`done: ${shots} screenshots, ${unreachable.length} unreachable, ${runtimeSeconds}s`);
  console.log(JSON.stringify({ screenshots: shots, unreachable: unreachable.length, runtimeSeconds, failuresPerInvariant: counts }, null, 1));
}

// ------------------------------------------------------------------------------------------
// compare
// ------------------------------------------------------------------------------------------
async function compare(baseDir, afterDir, diffDir) {
  fs.mkdirSync(diffDir, { recursive: true });
  const list = (d) => fs.readdirSync(d).filter((f) => f.endsWith(".png")).sort();
  const A = new Set(list(baseDir));
  const B = new Set(list(afterDir));
  const both = [...A].filter((f) => B.has(f));
  const onlyA = [...A].filter((f) => !B.has(f));
  const onlyB = [...B].filter((f) => !A.has(f));
  const browser = await chromium.launch({ executablePath: CHROMIUM_EXE, headless: true });
  const page = await browser.newPage();
  await page.goto("about:blank");
  const THRESH = 16;
  const results = [];
  for (const f of both) {
    const a = "data:image/png;base64," + fs.readFileSync(path.join(baseDir, f)).toString("base64");
    const b = "data:image/png;base64," + fs.readFileSync(path.join(afterDir, f)).toString("base64");
    const r = await page.evaluate(
      async ({ a, b, thr }) => {
        const load = (src) =>
          new Promise((res, rej) => {
            const i = new Image();
            i.onload = () => res(i);
            i.onerror = () => rej(new Error("image load failed"));
            i.src = src;
          });
        const [ia, ib] = await Promise.all([load(a), load(b)]);
        const W = Math.max(ia.width, ib.width);
        const H = Math.max(ia.height, ib.height);
        const data = (img) => {
          const c = document.createElement("canvas");
          c.width = W;
          c.height = H;
          const x = c.getContext("2d", { willReadFrequently: true });
          x.drawImage(img, 0, 0);
          return x.getImageData(0, 0, W, H);
        };
        const da = data(ia);
        const db = data(ib);
        const out = new ImageData(W, H);
        let changed = 0;
        let x0 = W, y0 = H, x1 = -1, y1 = -1;
        for (let y = 0; y < H; y++) {
          for (let x = 0; x < W; x++) {
            const i = (y * W + x) * 4;
            const outside = x >= ia.width || y >= ia.height || x >= ib.width || y >= ib.height;
            const diff =
              outside ||
              Math.abs(da.data[i] - db.data[i]) > thr ||
              Math.abs(da.data[i + 1] - db.data[i + 1]) > thr ||
              Math.abs(da.data[i + 2] - db.data[i + 2]) > thr;
            if (diff) {
              changed++;
              if (x < x0) x0 = x;
              if (x > x1) x1 = x;
              if (y < y0) y0 = y;
              if (y > y1) y1 = y;
              out.data[i] = 255;
              out.data[i + 1] = 0;
              out.data[i + 2] = 0;
              out.data[i + 3] = 255;
            } else {
              // faded copy of the "after" image for context
              out.data[i] = 255 - (255 - db.data[i]) * 0.3;
              out.data[i + 1] = 255 - (255 - db.data[i + 1]) * 0.3;
              out.data[i + 2] = 255 - (255 - db.data[i + 2]) * 0.3;
              out.data[i + 3] = 255;
            }
          }
        }
        const c = document.createElement("canvas");
        c.width = W;
        c.height = H;
        c.getContext("2d").putImageData(out, 0, 0);
        const png = c.toDataURL("image/png").split(",")[1];
        return {
          changed,
          total: W * H,
          size: `${ia.width}x${ia.height}` + (ia.width !== ib.width || ia.height !== ib.height ? ` vs ${ib.width}x${ib.height}` : ""),
          sizeMismatch: ia.width !== ib.width || ia.height !== ib.height,
          bbox: changed ? [x0, y0, x1, y1] : null,
          png,
        };
      },
      { a, b, thr: THRESH },
    );
    fs.writeFileSync(path.join(diffDir, f), Buffer.from(r.png, "base64"));
    results.push({ file: f, pct: (r.changed / r.total) * 100, changed: r.changed, size: r.size, sizeMismatch: r.sizeMismatch, bbox: r.bbox });
  }
  await browser.close();
  results.sort((x, y) => y.pct - x.pct || x.file.localeCompare(y.file));

  const lines = [];
  lines.push("# Screen catalog comparison", "");
  lines.push(`- Baseline: ${baseDir}`, `- After: ${afterDir}`, `- Threshold: per-channel delta > ${THRESH}`);
  const differing = results.filter((r) => r.changed > 0).length;
  lines.push(`- Compared: ${results.length} screenshots, ${differing} differ, ${results.length - differing} identical`);
  if (onlyA.length) lines.push(`- Only in baseline (${onlyA.length}): ${onlyA.join(", ")}`);
  if (onlyB.length) lines.push(`- Only in after (${onlyB.length}): ${onlyB.join(", ")}`);
  lines.push("", "## Changed pixels, highest first", "", "| % changed | pixels | file | size | changed bbox (x0,y0,x1,y1) |", "|---:|---:|---|---|---|");
  for (const r of results) {
    lines.push(`| ${r.pct.toFixed(3)}% | ${r.changed} | ${r.file} | ${r.size}${r.sizeMismatch ? " (size mismatch)" : ""} | ${r.bbox ? r.bbox.join(",") : "-"} |`);
  }
  // invariant deltas when both captures carry a report.json
  const rp = (d) => {
    try { return JSON.parse(fs.readFileSync(path.join(d, "report.json"), "utf8")); } catch { return null; }
  };
  const ra = rp(baseDir);
  const rb = rp(afterDir);
  if (ra && rb) {
    const failing = (rep) => {
      const set = new Map();
      for (const e of rep) {
        if (!e.file) continue;
        for (const inv of INVARIANTS) if (e.checks[inv] && e.checks[inv].pass === false) set.set(`${e.engine} ${e.viewport} ${e.theme} ${e.state} :: ${inv}`, detailFor(inv, e.checks[inv]));
      }
      return set;
    };
    const fa = failing(ra);
    const fb = failing(rb);
    const fixed = [...fa.keys()].filter((k) => !fb.has(k));
    const added = [...fb.keys()].filter((k) => !fa.has(k));
    lines.push("", `## Invariant changes`, "", `- Fixed since baseline: ${fixed.length}`, `- New since baseline: ${added.length}`, "");
    if (added.length) {
      lines.push("### New failures", "");
      for (const k of added) lines.push(`- ${k}: ${fb.get(k)}`);
      lines.push("");
    }
    if (fixed.length) {
      lines.push("### Fixed failures", "");
      for (const k of fixed) lines.push(`- ${k}`);
      lines.push("");
    }
  }
  fs.writeFileSync(path.join(diffDir, "compare.md"), lines.join("\n") + "\n");
  console.log(`compared ${results.length} screenshots: ${differing} differ; top: ${results.slice(0, 5).map((r) => `${r.file} ${r.pct.toFixed(3)}%`).join(", ") || "-"}`);
  console.log(`wrote ${path.join(diffDir, "compare.md")}`);
}

// ------------------------------------------------------------------------------------------
// selftest: proves every invariant fires on a deliberately broken page and stays quiet on a clean one
// ------------------------------------------------------------------------------------------
async function selftest() {
  const broken = `<style>body{margin:0;font:14px sans-serif}</style>
    <div class="topbar" style="display:flex;position:relative;height:60px">
      <div style="height:40px;width:100px">a</div><button style="height:20px;margin-top:30px">misaligned</button></div>
    <div style="width:1500px;height:20px;background:#c00">wide</div>
    <div style="width:50px;overflow:hidden;white-space:nowrap">a very long text with no ellipsis at all</div>
    <button style="width:10px;height:10px;padding:0"></button>
    <div class="ctx-menu" role="menu" style="position:absolute;left:100px;top:200px;width:200px;height:100px;background:#eee">menu</div>
    <div style="position:absolute;left:100px;top:200px;width:200px;height:100px;z-index:5;background:#f00">cover</div>`;
  const clean = `<style>body{margin:0;font:14px sans-serif}</style>
    <div class="topbar" style="display:flex;position:relative;height:60px;align-items:center">
      <div style="height:40px;width:100px">a</div><button style="height:32px;min-width:40px">ok</button></div>
    <div style="width:50px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">a very long text with an ellipsis</div>
    <div class="ctx-menu" role="menu" style="position:absolute;left:100px;top:200px;width:200px;height:100px;background:#eee;z-index:9">menu</div>`;
  const browser = await chromium.launch({ executablePath: CHROMIUM_EXE, headless: true });
  const page = await browser.newPage({ viewport: { width: 1024, height: 700 } });
  let failed = 0;
  const expect = (name, cond) => {
    if (!cond) failed++;
    console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
  };
  await page.setContent(broken);
  const b = await page.evaluate(pageInvariants, { checkSmall: true });
  expect("broken: horizontalOverflow fires", b.horizontalOverflow.pass === false && b.horizontalOverflow.docOverflow && b.horizontalOverflow.offenderCount >= 1);
  expect("broken: overlayOnTop fires", b.overlayOnTop.pass === false && b.overlayOnTop.checked === 1);
  expect("broken: toolbarCenterline fires", b.toolbarCenterline.pass === false && b.toolbarCenterline.maxDiff > 1);
  expect("broken: clippedText fires", b.clippedText.pass === false && b.clippedText.count === 1);
  expect("broken: smallTargets fires", b.smallTargets.pass === false && b.smallTargets.count >= 1);
  await page.setContent(clean);
  const c = await page.evaluate(pageInvariants, { checkSmall: true });
  for (const inv of INVARIANTS) expect(`clean: ${inv} passes`, c[inv].pass === true);
  expect("clean: overlay was actually sampled", c.overlayOnTop.checked === 1);
  await browser.close();
  console.log(failed ? `${failed} selftest check(s) failed` : "selftest ok");
  process.exitCode = failed ? 1 : 0;
}

// ------------------------------------------------------------------------------------------
const [mode, ...rest] = process.argv.slice(2);
if (mode === "selftest") {
  await selftest();
} else if (mode === "capture" && rest[0]) {
  await capture(path.resolve(rest[0]));
} else if (mode === "compare" && rest.length >= 3) {
  await compare(path.resolve(rest[0]), path.resolve(rest[1]), path.resolve(rest[2]));
} else {
  console.error("usage:\n  node catalog.mjs capture <outDir>\n  node catalog.mjs compare <baselineDir> <afterDir> <diffDir>");
  process.exit(2);
}
