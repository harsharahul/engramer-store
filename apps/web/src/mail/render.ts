/**
 * An email, made safe to show.
 *
 * Mail is written by strangers, so the body is sanitized into a standalone
 * document for a sandboxed frame: no script, no handler, no form, nothing
 * that navigates the frame. Remote images and CSS backgrounds are removed
 * until the reader asks for them, so opening an email tells no sender it
 * was read; images the email carries itself (cid) show at once from the
 * record. A content security policy in the document backs all of this up:
 * whatever the sanitizer missed still cannot run or load.
 */

import DOMPurify from "dompurify";
import type { EmailRecord } from "./record";

const FORBID_TAGS = [
  "script",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "form",
  "input",
  "button",
  "select",
  "textarea",
  "meta",
  "base",
  "link",
];

/** Attributes that fetch something when the element renders. */
const FETCHING_ATTRS = new Set(["src", "srcset", "background", "poster"]);

const REMOTE = /(?:^|[\s,])(?:https?:)?\/\//i;
const CSS_IMPORT = /@import\b[^;]*;?/gi;
const CSS_REMOTE_URL = /url\(\s*(['"]?)\s*(?:https?:)?\/\/[^)]*\)/gi;

const BASE_STYLE = [
  ":root { color-scheme: light; }",
  "body { margin: 16px; background: #fff; color: #111; font: 14px/1.5 -apple-system, system-ui, sans-serif; overflow-wrap: anywhere; }",
  "img { max-width: 100%; height: auto; }",
  "pre.mail-text { white-space: pre-wrap; font: inherit; margin: 0; }",
  "p.mail-empty { color: #666; }",
].join("\n");

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function stripRemoteCss(css: string): string {
  return css.replace(CSS_IMPORT, "").replace(CSS_REMOTE_URL, "none");
}

function sanitizeHtml(record: EmailRecord, allowRemote: boolean): { head: string; body: string } {
  const purifier = DOMPurify(window);
  const inline = new Map(
    record.inline.map((part) => [part.cid.toLowerCase(), `data:${part.mime};base64,${part.data}`]),
  );

  purifier.addHook("uponSanitizeElement", (node, data) => {
    if (data.tagName === "style" && node.textContent) {
      // Imports never apply under the policy; remote URLs only once asked.
      const css = node.textContent.replace(CSS_IMPORT, "");
      node.textContent = allowRemote ? css : stripRemoteCss(css);
    }
  });

  purifier.addHook("uponSanitizeAttribute", (_node, data) => {
    const name = data.attrName;
    const value = data.attrValue;
    if (name.startsWith("on")) {
      data.keepAttr = false;
      return;
    }
    if (name === "src" && /^\s*cid:/i.test(value)) {
      const found = inline.get(value.trim().slice(4).toLowerCase());
      if (found) {
        data.attrValue = found;
      } else {
        data.keepAttr = false;
      }
      return;
    }
    if (name === "style") {
      data.attrValue = allowRemote ? value.replace(CSS_IMPORT, "") : stripRemoteCss(value);
      return;
    }
    if (FETCHING_ATTRS.has(name) && REMOTE.test(value) && !allowRemote) {
      data.keepAttr = false;
    }
  });

  purifier.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName === "A" && node.hasAttribute("href")) {
      const href = node.getAttribute("href")!;
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
      // Link text in mail often hides where it goes; the address shows on hover.
      node.setAttribute("title", href);
    }
  });

  const clean = purifier.sanitize(record.html ?? "", {
    WHOLE_DOCUMENT: true,
    FORBID_TAGS,
    FORBID_ATTR: ["action", "formaction", "ping"],
    ADD_ATTR: ["target"],
  });
  const parsed = new DOMParser().parseFromString(clean, "text/html");
  return { head: parsed.head.innerHTML, body: parsed.body.innerHTML };
}

/**
 * A complete document for the viewer's frame `srcdoc`. HTML is sanitized
 * as above; a plain-text email is shown as escaped text that keeps its line
 * breaks.
 */
export function prepareMailDocument(record: EmailRecord, opts: { allowRemote: boolean }): string {
  const csp = `default-src 'none'; img-src data:${opts.allowRemote ? " https:" : ""}; style-src 'unsafe-inline'`;
  let head = "";
  let body: string;
  if (record.html) {
    ({ head, body } = sanitizeHtml(record, opts.allowRemote));
  } else if (record.text) {
    body = `<pre class="mail-text">${escapeHtml(record.text)}</pre>`;
  } else {
    body = '<p class="mail-empty">This email has no text.</p>';
  }
  return (
    "<!doctype html><html><head>" +
    `<meta http-equiv="Content-Security-Policy" content="${csp}">` +
    '<meta name="referrer" content="no-referrer">' +
    `<style>${BASE_STYLE}</style>${head}</head><body>${body}</body></html>`
  );
}

/** Whether the HTML asks for anything remote, so the viewer offers to load it. */
export function hasRemoteImages(record: EmailRecord): boolean {
  return /(?:src|srcset|background)\s*=\s*["']?\s*(?:https?:)?\/\/|url\(\s*['"]?\s*(?:https?:)?\/\//i.test(
    record.html ?? "",
  );
}
