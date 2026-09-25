// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { ensureScopedStylesheet, scopeSelector, vendorLayered } from "./scopedcss";

/**
 * pdf.js's stylesheet names a `.sidebar`; so does the app. Loaded
 * globally, the viewer's rule pushed the app's sidebar over the content.
 * Every selector of the sheet is confined to the viewer's root.
 */
describe("a scoped third-party stylesheet", () => {
  it("prefixes every selector in a list and leaves :root alone", () => {
    expect(scopeSelector(".sidebar, .toolbar > button", ".pdfv")).toBe(".pdfv .sidebar, .pdfv .toolbar > button");
    expect(scopeSelector(":root", ".pdfv")).toBe(":root");
    expect(scopeSelector(".pdfv .page", ".pdfv")).toBe(".pdfv .page");
  });

  it("lands the sheet in the vendor cascade layer, below the app's own rules", () => {
    // app.css orders the layers `theme, vendor, legacy, ...`: a viewer rule
    // can never outrank an app rule, whatever its specificity.
    expect(vendorLayered(".sidebar { width: 239px; }")).toBe("@layer vendor {\n.sidebar { width: 239px; }\n}");
  });

  it("injects once and confines the rules, media blocks included", () => {
    const css = `.sidebar { width: 239px; } :root { --x: 1; } @media (max-width: 500px) { .toolbar { display: none; } }`;
    ensureScopedStylesheet("test-sheet", css, ".pdfv");
    ensureScopedStylesheet("test-sheet", css, ".pdfv");
    const styles = document.querySelectorAll<HTMLStyleElement>('style[data-scoped-css="test-sheet"]');
    expect(styles).toHaveLength(1);
    // The sheet is one `@layer vendor` block; the viewer's rules sit inside it.
    const layer = styles[0]!.sheet!.cssRules[0] as CSSGroupingRule;
    expect(styles[0]!.textContent).toMatch(/^@layer vendor \{/);
    const rules = Array.from(layer.cssRules);
    expect((rules[0] as CSSStyleRule).selectorText).toBe(".pdfv .sidebar");
    expect((rules[1] as CSSStyleRule).selectorText).toBe(":root");
    const media = rules[2] as CSSMediaRule;
    expect((media.cssRules[0] as CSSStyleRule).selectorText).toBe(".pdfv .toolbar");
  });
});
