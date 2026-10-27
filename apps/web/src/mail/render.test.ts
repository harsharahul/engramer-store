// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { EmailRecord } from "./record";
import { prepareMailDocument } from "./render";

const record = (over: Partial<EmailRecord>): EmailRecord => ({
  v: 1,
  messageId: "<r1@example.com>",
  date: Date.UTC(2026, 5, 15, 12),
  from: { name: "Example Sender", address: "sender@example.com" },
  to: ["owner@example.com"],
  cc: [],
  subject: "Hello",
  headers: "",
  inline: [],
  attachments: [],
  source: { kind: "import", label: "export.mbox" },
  ...over,
});

const off = { allowRemote: false };

describe("prepareMailDocument", () => {
  it("strips scripts, handlers, forms and meta refresh", () => {
    const doc = prepareMailDocument(
      record({
        html:
          '<html><head><meta http-equiv="refresh" content="0;url=https://elsewhere.example/">' +
          '<base href="https://elsewhere.example/"><link rel="stylesheet" href="https://elsewhere.example/a.css">' +
          "</head><body><script>steal()</script>" +
          '<p onclick="steal()">Hi</p><img src="data:image/gif;base64,R0lGOD" onerror="steal()">' +
          '<form action="https://elsewhere.example/"><input name="password"></form>' +
          '<a href="javascript:steal()">bad link</a><iframe src="https://elsewhere.example/"></iframe>' +
          "</body></html>",
      }),
      off,
    );
    expect(doc).not.toMatch(/<script/i);
    expect(doc).not.toMatch(/\son[a-z]+=/i);
    expect(doc).not.toMatch(/<form|<input|<iframe|<base|<link/i);
    expect(doc).not.toMatch(/refresh/i);
    expect(doc).not.toContain("javascript:");
    expect(doc).not.toContain("elsewhere.example");
    expect(doc).toContain("Hi");
  });

  it("removes remote images and css urls while remote images are off", () => {
    const doc = prepareMailDocument(
      record({
        html:
          "<style>.hero { background: url('https://tracker.example/a.png') } @import url(https://tracker.example/b.css);</style>" +
          '<img src="https://tracker.example/pixel.gif" srcset="https://tracker.example/2x.gif 2x">' +
          '<div style="background-image: url(https://tracker.example/bg.png); color: red">Text</div>' +
          '<table><tr><td background="https://tracker.example/td.png">Cell</td></tr></table>',
      }),
      off,
    );
    expect(doc).not.toContain("tracker.example");
    expect(doc).toContain("color: red");
    expect(doc).toContain("Text");
    expect(doc).toContain("Cell");
  });

  it("keeps https images when remote images are allowed", () => {
    const doc = prepareMailDocument(
      record({ html: '<img src="https://images.example/logo.png" alt="Logo">' }),
      { allowRemote: true },
    );
    expect(doc).toContain('src="https://images.example/logo.png"');
    expect(doc).toContain("img-src data: https:");
  });

  it("replaces cid images with inline data", () => {
    const doc = prepareMailDocument(
      record({
        html: '<p>Logo</p><img src="cid:logo1@example"><img src="cid:missing@example">',
        inline: [{ cid: "logo1@example", mime: "image/png", data: "iVBORw0KGgo=" }],
      }),
      off,
    );
    expect(doc).toContain('src="data:image/png;base64,iVBORw0KGgo="');
    expect(doc).not.toContain("cid:");
  });

  it("links open outside and show their real address", () => {
    const doc = prepareMailDocument(
      record({ html: '<a href="https://real.example/path?q=1">Track your order</a>' }),
      off,
    );
    const link = new DOMParser().parseFromString(doc, "text/html").querySelector("a")!;
    expect(link.getAttribute("href")).toBe("https://real.example/path?q=1");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link.getAttribute("title")).toBe("https://real.example/path?q=1");
  });

  it("the document carries a CSP that forbids scripts", () => {
    const doc = prepareMailDocument(record({ html: "<p>Hi</p>" }), off);
    const csp = new DOMParser()
      .parseFromString(doc, "text/html")
      .querySelector('meta[http-equiv="Content-Security-Policy"]')!
      .getAttribute("content");
    expect(csp).toBe("default-src 'none'; img-src data:; style-src 'unsafe-inline'");
  });

  it("plain text is escaped", () => {
    const doc = prepareMailDocument(record({ text: "<b>not bold</b> & <script>x()</script>" }), off);
    expect(doc).toContain("&lt;b&gt;not bold&lt;/b&gt; &amp; &lt;script&gt;x()&lt;/script&gt;");
    expect(doc).toContain("pre-wrap");
    expect(doc).not.toMatch(/<script/i);
  });
});
