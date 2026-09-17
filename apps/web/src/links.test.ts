import { describe, expect, it } from "vitest";
import { parseLinkFile } from "./links";

/**
 * A saved link is what a shared web page becomes when the extension
 * could not render it: an Internet Shortcut (.url) or a Safari
 * bookmark (.webloc). The preview reads the address and title out of
 * either, and refuses anything that is not a web address.
 */
describe("parseLinkFile", () => {
  it("reads an Internet Shortcut with its title comment", () => {
    const body = "[InternetShortcut]\r\nURL=https://example.com/a?b=1\r\n; Title=Filing taxes\r\n";
    expect(parseLinkFile(body, "Filing taxes.url")).toEqual({
      url: "https://example.com/a?b=1",
      title: "Filing taxes",
    });
  });

  it("falls back to the file name for the title", () => {
    const body = "[InternetShortcut]\nURL=https://example.com/\n";
    expect(parseLinkFile(body, "Example site.url")?.title).toBe("Example site");
  });

  it("reads a Safari webloc plist", () => {
    const body = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>URL</key><string>https://apple.com/</string></dict></plist>`;
    expect(parseLinkFile(body, "Apple.webloc")).toEqual({ url: "https://apple.com/", title: "Apple" });
  });

  it("refuses anything that is not a web address", () => {
    expect(parseLinkFile("[InternetShortcut]\nURL=javascript:alert(1)\n", "x.url")).toBeNull();
    expect(parseLinkFile("[InternetShortcut]\nURL=file:///etc/passwd\n", "x.url")).toBeNull();
    expect(parseLinkFile("just some text", "x.url")).toBeNull();
  });
});
