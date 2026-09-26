import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every button is one of two components. The legacy `.btn` and `.icon-btn`
 * classes were hand-assembled per call site, and the toolbar showed the
 * cost: one button never received the round capsule classes its siblings
 * had. With the rules gone from the stylesheet, a stray class would render
 * an unstyled button; this test catches it before a screenshot does.
 */

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return tsxFiles(path);
    }
    return path.endsWith(".tsx") && !path.endsWith(".test.tsx") ? [path] : [];
  });
}

// A class token: not part of a longer name such as `add-btn` or `new-btn`.
const LEGACY = /(?<![\w-])(icon-btn|btn|btn-primary|btn-ghost|btn-danger|btn-small|btn-quiet)(?![-\w])/;

describe("buttons are the Button and IconButton components", () => {
  it("leaves no legacy button class in any component", () => {
    const offenders = tsxFiles(join(__dirname)).flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .map((line, i) => ({ line, i }))
        .filter(({ line }) => /className/.test(line) && LEGACY.test(line))
        .map(({ i }) => `${file.replace(__dirname, "components")}:${i + 1}`),
    );
    expect(offenders).toEqual([]);
  });

  it("keeps no legacy button rule in the stylesheet", () => {
    const css = readFileSync(join(__dirname, "..", "styles.css"), "utf8");
    const rules = css
      .split("\n")
      .filter((line) => /\.(icon-btn|btn)(?![-\w])/.test(line) && !/btn-(word|label)/.test(line));
    expect(rules).toEqual([]);
  });

  it("gives every IconButton a label", () => {
    // The prop is required by the type; this guards the runtime contract
    // for call sites that spread props.
    const source = readFileSync(join(__dirname, "ui", "icon-button.tsx"), "utf8");
    expect(source).toMatch(/aria-label=\{label\}/);
  });
});
