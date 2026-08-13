// @vitest-environment jsdom
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The copy path, pinned.
 *
 * isUseNewCopy() returns true whenever navigator.clipboard exists, which
 * routes every copy through navigator.clipboard.write(). The editor
 * document's opaque origin holds no clipboard-write permission, the write
 * rejects, and the vendor swallows the rejection: the user copies and
 * nothing lands on the OS clipboard. The shim forces the vendor's own
 * event path instead, which fills the ClipboardEvent synchronously inside
 * the gesture and needs no permission. These tests pin the override: it
 * waits for the engine, installs once, and never swallows the event the
 * vendor handler needs.
 */

const SHIM_PATH = ["office/engram-sandbox-shim.js", "apps/web/office/engram-sandbox-shim.js"]
  .map((candidate) => resolve(process.cwd(), candidate))
  .find((candidate) => existsSync(candidate));
if (!SHIM_PATH) {
  throw new Error("engram-sandbox-shim.js not found from " + process.cwd());
}
const SHIM_SOURCE = readFileSync(SHIM_PATH, "utf8");

interface FakeClipboardBase {
  Api: { asc_IsFocus(): boolean };
  isUseNewCopy(): boolean;
  __engramEventCopy?: boolean;
}

function makeClipboard(): FakeClipboardBase {
  const clipboardBase: FakeClipboardBase = {
    Api: { asc_IsFocus: () => true },
    isUseNewCopy: () => true,
  };
  (window as unknown as Record<string, unknown>).AscCommon = {
    g_clipboardBase: clipboardBase,
  };
  return clipboardBase;
}

describe("the shim copy takeover", () => {
  beforeAll(() => {
    new Function(SHIM_SOURCE)();
  });

  beforeEach(() => {
    delete (window as unknown as Record<string, unknown>).AscCommon;
  });

  it("forces the vendor's event copy path on the first copy", () => {
    const clipboardBase = makeClipboard();
    document.body.dispatchEvent(new Event("copy", { bubbles: true, cancelable: true }));
    expect(clipboardBase.isUseNewCopy()).toBe(false);
  });

  it("forces it for cut as well", () => {
    const clipboardBase = makeClipboard();
    document.body.dispatchEvent(new Event("cut", { bubbles: true, cancelable: true }));
    expect(clipboardBase.isUseNewCopy()).toBe(false);
  });

  it("installs exactly once", () => {
    const clipboardBase = makeClipboard();
    document.body.dispatchEvent(new Event("copy", { bubbles: true, cancelable: true }));
    const forced = clipboardBase.isUseNewCopy;
    document.body.dispatchEvent(new Event("copy", { bubbles: true, cancelable: true }));
    expect(clipboardBase.isUseNewCopy).toBe(forced);
  });

  it("does not swallow the event the vendor handler needs", () => {
    makeClipboard();
    const seen = vi.fn();
    document.addEventListener("copy", seen);
    const event = new Event("copy", { bubbles: true, cancelable: true });
    document.body.dispatchEvent(event);
    document.removeEventListener("copy", seen);
    expect(seen).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(false);
  });

  it("does nothing before the engine exists", () => {
    expect(() =>
      document.body.dispatchEvent(new Event("copy", { bubbles: true, cancelable: true })),
    ).not.toThrow();
  });
});
