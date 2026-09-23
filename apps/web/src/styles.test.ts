import { readFileSync } from "node:fs";
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
describe("the sidebar rail never hides a group", () => {
  /** Every selector list whose rule turns display off. */
  function hiddenSelectors(css: string): string[] {
    return [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
      .filter((rule) => /display:\s*none/.test(rule[2]!))
      .flatMap((rule) => rule[1]!.split(",").map((s) => s.trim()));
  }

  it("hides a group header's words, not the header", () => {
    const railHidden = hiddenSelectors(CSS).filter((s) => s.includes(".sidebar-rail"));
    expect(railHidden.length).toBeGreaterThan(0);
    const hidesHeader = railHidden.filter((s) => /\.sidebar-label\s*$/.test(s));
    expect(hidesHeader).toEqual([]);
    expect(railHidden.some((s) => s.endsWith(".sidebar-label-text"))).toBe(true);
  });
});

describe("sidebar groups keep their rows", () => {
  it("never lets a group list shrink below its rows", () => {
    // The lists scroll internally, so as flex children they may shrink to
    // nothing when the sidebar is taller than the window; that cut the first
    // album to half a row. The sidebar scrolls as a whole instead.
    const rule = /\.library-list\s*\{([^}]*)\}/.exec(CSS);
    expect(rule).not.toBeNull();
    expect(rule![1]).toMatch(/flex-shrink:\s*0/);
  });
});

describe("the Mac shell's hidden title bar", () => {
  it("keeps the traffic lights off the top bar at phone widths", () => {
    // Below the phone breakpoint the sidebar is off-canvas, so nothing else
    // reserves the corner the traffic lights occupy; the top bar must.
    const phoneBlock = CSS.slice(CSS.indexOf(`@media (max-width: ${PHONE_MAX}px)`));
    const rule = /\.frame\.shell-mac\s+\.topbar\s*\{([^}]*)\}/.exec(phoneBlock);
    expect(rule).not.toBeNull();
    const padding = /padding-left:\s*(\d+)px/.exec(rule?.[1] ?? "");
    expect(padding).not.toBeNull();
    expect(Number(padding?.[1] ?? 0)).toBeGreaterThanOrEqual(84);
  });
});
