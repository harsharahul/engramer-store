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
describe("the Mac shell's hidden title bar", () => {
  it("keeps the toolbar's controls clear of the traffic lights at every sidebar width", () => {
    // The lights end 70px from the window's left edge. Beside a full sidebar
    // they sit inside the sidebar pane; in the rail and on a phone-width
    // window the toolbar itself must leave that corner free, which one rule
    // does by reserving whatever of the first 84px the sidebar does not.
    const bodies = [...CSS.matchAll(/\.frame\.shell-mac \.topbar\s*\{([^}]*)\}/g)].map((m) => m[1] ?? "");
    expect(bodies.some((b) => /padding-left:\s*max\(16px,\s*calc\(84px - var\(--sidebar-w/.test(b))).toBe(true);
  });

  it("starts the sidebar's contents below the toolbar row the lights sit in", () => {
    const rule = /\.frame\.shell-mac > \.sidebar\s*\{([^}]*)\}/.exec(CSS);
    expect(rule?.[1] ?? "").toMatch(/padding-top:\s*calc\(var\(--toolbar-h\) - var\(--pane-inset\)\)/);
  });
});
