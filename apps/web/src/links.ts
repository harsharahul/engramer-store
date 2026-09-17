/**
 * Saved links: the small file a shared web page becomes when the share
 * extension could not render it to a PDF, and the Safari bookmark format
 * for good measure. Only web addresses are accepted, so a link file can
 * never open anything but a page.
 */

export interface SavedLink {
  url: string;
  title: string;
}

function webAddress(raw: string | undefined): string | null {
  if (!raw) {
    return null;
  }
  try {
    const url = new URL(raw.trim());
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function titleFromName(name: string): string {
  return name.replace(/\.(url|webloc)$/i, "").trim() || "Link";
}

export function parseLinkFile(body: string, name: string): SavedLink | null {
  const trimmed = body.trim();
  if (/^\[InternetShortcut\]/i.test(trimmed)) {
    const urlLine = /^URL=(.+)$/im.exec(trimmed);
    const titleLine = /^;\s*Title=(.+)$/im.exec(trimmed);
    const url = webAddress(urlLine?.[1]);
    if (!url) {
      return null;
    }
    return { url, title: titleLine?.[1]?.trim() || titleFromName(name) };
  }
  if (trimmed.includes("<plist")) {
    const match = /<key>URL<\/key>\s*<string>([^<]+)<\/string>/i.exec(trimmed);
    const url = webAddress(match?.[1]);
    return url ? { url, title: titleFromName(name) } : null;
  }
  return null;
}
