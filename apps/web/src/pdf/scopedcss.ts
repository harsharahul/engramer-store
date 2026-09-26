/**
 * A third-party stylesheet, confined to one subtree.
 *
 * pdf.js ships one stylesheet for its whole viewer, and it names things
 * generically: `.sidebar`, `.toolbar`, `.dialog`. Loaded as is, its
 * `.sidebar { width: 239px; min-width: 180px }` landed on this app's
 * sidebar and pushed it over the content. The sheet is injected once and
 * every selector is prefixed with the viewer's root, so its rules can
 * reach nothing outside it. `:root` stays as it is: it only sets custom
 * properties the viewer reads.
 */

const SCOPE_MARK = "data-scoped-css";

export function scopeSelector(selectorText: string, scope: string): string {
  return selectorText
    .split(",")
    .map((part) => {
      const selector = part.trim();
      if (!selector) {
        return selector;
      }
      if (selector === ":root" || selector.startsWith(":root")) {
        return selector;
      }
      if (selector.startsWith(scope)) {
        return selector;
      }
      return `${scope} ${selector}`;
    })
    .join(", ");
}

// CSSRule.type values; the class globals are not present everywhere the
// code runs (test DOMs), the numbers are.
const STYLE_RULE = 1;
const KEYFRAMES_RULE = 7;

function scopeRules(rules: CSSRuleList, scope: string): void {
  for (const rule of Array.from(rules)) {
    if (rule.type === STYLE_RULE) {
      const styleRule = rule as CSSStyleRule;
      styleRule.selectorText = scopeSelector(styleRule.selectorText, scope);
    } else if (rule.type !== KEYFRAMES_RULE && "cssRules" in rule) {
      scopeRules((rule as CSSGroupingRule).cssRules, scope);
    }
  }
}

/** The cascade layer third-party sheets land in: below the app's own
 * rules (see app.css), so a vendor rule never outranks them. */
export const VENDOR_LAYER = "vendor";

/** The sheet wrapped in the vendor layer. */
export function vendorLayered(cssText: string): string {
  return `@layer ${VENDOR_LAYER} {\n${cssText}\n}`;
}

/** Injects `cssText` once, in the vendor layer and scoped under `scope`;
 * safe to call repeatedly. */
export function ensureScopedStylesheet(id: string, cssText: string, scope: string): void {
  if (typeof document === "undefined" || document.querySelector(`style[${SCOPE_MARK}="${id}"]`)) {
    return;
  }
  const style = document.createElement("style");
  style.setAttribute(SCOPE_MARK, id);
  style.textContent = vendorLayered(cssText);
  document.head.appendChild(style);
  if (style.sheet) {
    scopeRules(style.sheet.cssRules, scope);
  }
}
