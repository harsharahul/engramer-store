import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The details panel is one element wearing two hats: a pane beside the grid
 * on a wide screen, and a bottom sheet over it on a phone. A rule that hides
 * the PANE on narrow screens will hide the SHEET too unless it stops above
 * the phone breakpoint, because both are `.details` and the hiding selector
 * is the more specific of the two.
 *
 * That is not hypothetical. `.frame > .details { display: none }` sat in a
 * plain `max-width: 900px` query and silently hid the sheet on every phone
 * for the sheet's entire life. Three fixes went into the component's state
 * before anyone measured the element and found it `display: none`.
 */

const CSS = readFileSync(join(__dirname, "styles.css"), "utf8");
/** Keep in sync with MOBILE_QUERY in media.ts. */
const PHONE_MAX = 760;

/** Every `@media (...) { ... }` block, as [condition, body] pairs. */
function mediaBlocks(css: string): Array<[string, string]> {
  const blocks: Array<[string, string]> = [];
  const re = /@media([^{]+)\{/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(css)) !== null) {
    // Walk braces from the query's opening brace to find its matching close.
    let depth = 1;
    let i = re.lastIndex;
    while (i < css.length && depth > 0) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") depth--;
      i++;
    }
    blocks.push([match[1]!.trim(), css.slice(re.lastIndex, i - 1)]);
  }
  return blocks;
}

/** Whether a media condition can match a phone-width viewport. */
function appliesToPhones(condition: string): boolean {
  const min = /min-width:\s*(\d+)px/.exec(condition);
  if (min && Number(min[1]) > PHONE_MAX) {
    return false;
  }
  const max = /max-width:\s*(\d+)px/.exec(condition);
  return !max || Number(max[1]) >= PHONE_MAX;
}

describe("the details panel survives the phone layout", () => {
  it("is never hidden by a rule that reaches phone widths", () => {
    const offenders = mediaBlocks(CSS)
      .filter(([condition]) => appliesToPhones(condition))
      .flatMap(([condition, body]) =>
        // A `.details` rule whose declarations turn it off entirely.
        [...body.matchAll(/([^{}]*\.details[^{},]*)\{([^}]*)\}/g)]
          .filter((rule) => /display:\s*none/.test(rule[2]!))
          .map((rule) => `@media ${condition} { ${rule[1]!.trim()} }`),
      );
    expect(offenders).toEqual([]);
  });

  it("is never hidden at any width: a window with no third column floats it", () => {
    // The 761-899 px hide rule is gone for good. A window too narrow for a
    // third column gets the pane as an overlay (layout.ts decides when), so
    // the info toggle can never read "showing" while nothing shows.
    const hidesPane = mediaBlocks(CSS).some(([, body]) =>
      /\.frame\s*>\s*\.details[^{]*\{[^}]*display:\s*none/.test(body),
    );
    expect(hidesPane).toBe(false);
    expect(/\.frame\.details-overlay\s*>\s*\.details\s*\{[^}]*position:\s*absolute/.test(CSS)).toBe(true);
  });
});

/**
 * The sidebar rail keeps a footprint for every group. An album the owner
 * had just made vanished with its whole group when the sidebar railed on a
 * laptop window, because the rail hid the group header outright. A group
 * header may lose its words in the rail, never its icon.
 */
const APP_CSS = readFileSync(join(__dirname, "app.css"), "utf8");

/**
 * Two stylesheets share the page, and cascade layers decide between them.
 * Before the layers, Tailwind's utilities were imported unlayered next to
 * the unlayered legacy stylesheet, so a `tw:` class lost to any legacy
 * selector with more specificity (a phone `input` rule lost to
 * `tw:text-[14px]`, and iOS zoomed the whole app on focus). Every
 * stylesheet names its layer, and the platform layer stays on top.
 */
describe("the cascade is layered", () => {
  it("declares the layer order once, lowest to highest", () => {
    expect(APP_CSS).toMatch(/^@layer theme, vendor, legacy, components, utilities, platform;/m);
  });

  it("imports every stylesheet into a named layer", () => {
    const imports = [...APP_CSS.matchAll(/^@import\s+"([^"]+)"([^;]*);/gm)];
    expect(imports.length).toBeGreaterThan(0);
    const unlayered = imports
      .filter(([, path, rest]) => !/layer\(/.test(rest ?? "") && path !== "tw-animate-css")
      .map(([, path]) => path);
    // tw-animate-css is a Tailwind plugin (@theme and @utility blocks), so
    // its utilities compile into the utilities layer on their own.
    expect(unlayered).toEqual([]);
  });

  it("keeps touch inputs at 16px in the platform layer, and nowhere else", () => {
    const platform = /@layer platform\s*\{([\s\S]*)\}\s*$/.exec(APP_CSS)?.[1] ?? "";
    expect(platform).toMatch(/@media \(pointer: coarse\)/);
    expect(platform).toMatch(/font-size:\s*max\(16px, 1em\)/);
    // The legacy stylesheet no longer carries its own copy of the rule.
    const coarse = mediaBlocks(CSS).filter(([condition]) => /pointer:\s*coarse/.test(condition));
    for (const [, body] of coarse) {
      expect(body).not.toMatch(/\n\s*input,\s*\n\s*textarea,\s*\n\s*select\s*\{[^}]*font-size/);
    }
  });
});

/**
 * What covers what is decided once, by the z scale in app.css. Before it,
 * 21 hand-picked numbers were scattered through the stylesheet: the phone
 * bottom stack (250) trapped toasts under the preview (300), the update bar
 * (60) hid under an expanded rail (230), and nobody could tell without a
 * table. A stacked element takes a tier, never a number.
 */
describe("the z scale", () => {
  it("defines every tier once in app.css", () => {
    for (const tier of ["behind", "raised", "sticky", "toolbar", "pane", "sheet", "drawer", "floating", "modal", "popover", "toast", "veil", "grain"]) {
      expect(APP_CSS).toMatch(new RegExp(`--z-${tier}:\\s*-?\\d+;`));
    }
  });

  it("lets no rule pick a z-index number of its own", () => {
    const literals = [...CSS.matchAll(/z-index:\s*(-?\d+)\s*;/g)].map((m) => m[0]);
    expect(literals).toEqual([]);
    const ui = readdirSync(join(__dirname, "components", "ui")).filter((f) => f.endsWith(".tsx"));
    const utilities = ui.flatMap((f) =>
      [...readFileSync(join(__dirname, "components", "ui", f), "utf8").matchAll(/tw:z-\d+/g)].map((m) => `${f}: ${m[0]}`),
    );
    expect(utilities).toEqual([]);
  });

  it("ends every entrance animation with transform: none, so a finished pane traps nothing", () => {
    // A retained translate(0) from `animation ... both` still makes the
    // element a containing block for fixed descendants and a stacking
    // context: the details pane clipped its own confirm dialog that way.
    for (const name of ["fade-rise", "scale-in", "slide-in-right", "sheet-up"]) {
      const frames = new RegExp(`@keyframes ${name}\\s*\\{[\\s\\S]*?to\\s*\\{([^}]*)\\}`).exec(CSS)?.[1] ?? "";
      expect(frames, name).toMatch(/transform:\s*none/);
    }
  });
});

/**
 * One phone breakpoint, everywhere. The stylesheet's phone block and its
 * complement must meet at exactly 760px (a `min-width: 761px` block left a
 * gap for fractional widths), and shadcn's hook must read the same query
 * as the app (it shipped with 768px, so between 761 and 767px the sidebar
 * thought it was on a phone while the layout did not).
 */
describe("one phone breakpoint", () => {
  it("uses the exact complement of the phone query for the desktop block", () => {
    expect(CSS).not.toMatch(/@media \(min-width: 761px\)/);
    expect(CSS).toMatch(/@media not all and \(max-width: 760px\)/);
  });

  it("points shadcn's mobile hook at the app's query", () => {
    const hook = readFileSync(join(__dirname, "hooks", "use-mobile.ts"), "utf8");
    expect(hook).toMatch(/MOBILE_QUERY/);
    expect(hook).not.toMatch(/768/);
  });
});

/**
 * The search suggestions opened UNDER the content (folder cards, the albums
 * shelf, insight cards) on every platform: each glass capsule's backdrop
 * blur is a stacking context that traps the panel's z-index, so the
 * toolbar itself must be a layer above the content.
 */
describe("the toolbar's panels open over the content", () => {
  it("puts the toolbar on its own layer above the content", () => {
    const rule = /\n\.topbar\s*\{([^}]*)\}/.exec(CSS)?.[1] ?? "";
    expect(rule).toMatch(/position:\s*relative/);
    expect(rule).toMatch(/z-index:\s*var\(--z-toolbar\)/);
  });
});

describe("the Mac shell's hidden title bar", () => {
  it("keeps the toolbar's controls clear of the traffic lights at every sidebar width", () => {
    // The lights end 79px from the window's left edge (19px in, as macOS
    // places them in a toolbar window). Beside a full sidebar they sit
    // inside the sidebar pane; in the rail and on a phone-width window the
    // toolbar itself must leave that corner free with a 14px gap, which one
    // rule does by reserving whatever of the first 93px the sidebar does not.
    const bodies = [...CSS.matchAll(/\.frame\.shell-mac \.topbar\s*\{([^}]*)\}/g)].map((m) => m[1] ?? "");
    expect(bodies.some((b) => /padding-left:\s*max\(16px,\s*calc\(93px - var\(--sidebar-w/.test(b))).toBe(true);
  });

  it("starts the sidebar's contents below the toolbar row the lights sit in", () => {
    const rule = /\.frame\.shell-mac > \.sidebar\s*\{([^}]*)\}/.exec(CSS);
    expect(rule?.[1] ?? "").toMatch(/padding-top:\s*calc\(var\(--toolbar-h\) - var\(--pane-inset\)\)/);
  });
});
