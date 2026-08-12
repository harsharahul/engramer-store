// @vitest-environment jsdom
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The paste path, pinned.
 *
 * The engine pastes HTML by writing it into an iframe it creates. This
 * document is sandboxed without allow-same-origin and those flags inherit,
 * so that iframe gets its own opaque origin and reading its document
 * throws. The throw escapes before Paste_End(), the only decrement of the
 * long-action counter that gates every keystroke: nothing pastes AND the
 * document stops taking input. The shim takes the HTML path over and feeds
 * the engine directly; these tests pin the takeover, the two vendor paths
 * deliberately left alone, and the counter discipline that makes a failed
 * paste survivable.
 *
 * The engine here is a fake with the real counter semantics; the shim is
 * the real file, executed against jsdom.
 */

// Not new URL(..., import.meta.url): under the jsdom environment that URL
// is not file-scheme and readFileSync refuses it. Vitest runs with the
// package as its working directory; the repo-root form covers a run from
// the workspace root.
const SHIM_PATH = ["office/engram-sandbox-shim.js", "apps/web/office/engram-sandbox-shim.js"]
  .map((candidate) => resolve(process.cwd(), candidate))
  .find((candidate) => existsSync(candidate));
if (!SHIM_PATH) {
  throw new Error("engram-sandbox-shim.js not found from " + process.cwd());
}
const SHIM_SOURCE = readFileSync(SHIM_PATH, "utf8");

interface FakeEngine {
  api: {
    IsLongActionCurrent: number;
    isLongAction(): boolean;
    incrementCounterLongAction(): void;
    decrementCounterLongAction(): void;
    asc_IsFocus(): boolean;
    asc_PasteData(...args: unknown[]): void;
  };
  clipboardBase: {
    Api: FakeEngine["api"];
    PasteFlag: boolean;
    CopyFlag: boolean;
    pastedFrom: unknown;
    Paste_End(): void;
    EndFocus(): void;
  };
  pasteCalls: unknown[][];
}

function makeEngine(): FakeEngine {
  const pasteCalls: unknown[][] = [];
  const api: FakeEngine["api"] = {
    IsLongActionCurrent: 0,
    isLongAction() {
      return this.IsLongActionCurrent !== 0;
    },
    incrementCounterLongAction() {
      this.IsLongActionCurrent += 1;
    },
    decrementCounterLongAction() {
      this.IsLongActionCurrent -= 1;
      if (this.IsLongActionCurrent < 0) {
        this.IsLongActionCurrent = 0;
      }
    },
    asc_IsFocus: () => true,
    asc_PasteData(...args: unknown[]) {
      pasteCalls.push(args);
      // The real engine finishes asynchronously and reports through the
      // callback argument; calling it synchronously here keeps the tests
      // single-turn while still exercising the completion path.
      const done = args[5];
      if (typeof done === "function") {
        (done as () => void)();
      }
    },
  };
  const clipboardBase: FakeEngine["clipboardBase"] = {
    Api: api,
    PasteFlag: false,
    CopyFlag: false,
    pastedFrom: null,
    Paste_End() {
      this.Api.decrementCounterLongAction();
      this.PasteFlag = false;
    },
    EndFocus() {},
  };
  const w = window as unknown as Record<string, unknown>;
  w.AscCommon = {
    g_clipboardBase: clipboardBase,
    c_oAscClipboardDataFormat: { Text: 1, Html: 2, Internal: 4, HtmlElement: 8 },
    c_oClipboardPastedFrom: { Word: 0, Excel: 1, PowerPoint: 2 },
    g_specialPasteHelper: { specialPasteData: {}, Paste_Process_End() {} },
    g_inputContext: { HtmlArea: document.createElement("textarea") },
    AscBrowser: { isSafariMacOs: false },
  };
  w.editor = api;
  delete w.editorCell;
  return { api, clipboardBase, pasteCalls };
}

interface FakeDataTransfer {
  types?: string[];
  items?: unknown[];
  getData?(type: string): string;
}

function pasteEvent(dt: FakeDataTransfer | undefined): Event {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  if (dt !== undefined) {
    Object.defineProperty(event, "clipboardData", { value: dt });
  }
  return event;
}

function byType(map: Record<string, string>): FakeDataTransfer {
  return {
    types: Object.keys(map),
    items: [],
    getData: (type: string) => map[type] ?? "",
  };
}

interface PostedMessage {
  t?: string;
  kind?: string;
  message?: string;
  id?: number;
  value?: unknown;
  error?: unknown;
}

describe("the shim paste takeover", () => {
  let engine: FakeEngine;
  let vendorSpy: ReturnType<typeof vi.fn<(event: Event) => void>>;
  let postedMessages: PostedMessage[];
  let originalPostMessage: typeof window.postMessage;

  const notices = () => postedMessages.filter((message) => message?.t === "engramNotice");

  const rpcResults = () =>
    postedMessages.filter((message) => message?.t === "engramEditorRpcResult");

  beforeAll(() => {
    new Function(SHIM_SOURCE)();
  });

  beforeEach(() => {
    engine = makeEngine();
    vendorSpy = vi.fn<(event: Event) => void>();
    document.addEventListener("paste", vendorSpy);
    postedMessages = [];
    originalPostMessage = window.postMessage;
    window.postMessage = ((message: unknown) => {
      postedMessages.push(message as PostedMessage);
    }) as typeof window.postMessage;
  });

  afterEach(() => {
    document.removeEventListener("paste", vendorSpy);
    window.postMessage = originalPostMessage;
  });

  it("feeds rich HTML to the engine and balances the counter", () => {
    const event = pasteEvent(
      byType({
        "text/html":
          '<meta name="ProgId" content="Word.Document"><p><b>hello</b> world</p>',
        "text/plain": "hello world",
      }),
    );
    document.body.dispatchEvent(event);

    expect(engine.pasteCalls).toHaveLength(1);
    const [format, element, , text] = engine.pasteCalls[0]!;
    expect(format).toBe(8); // HtmlElement
    expect((element as HTMLElement).textContent).toContain("hello world");
    expect((element as HTMLElement).querySelector("b")).not.toBeNull();
    expect(text).toBe("hello world");
    // The element the engine reads styles from has to be in the document.
    expect(document.body.contains(element as HTMLElement)).toBe(true);
    // Word announces itself through the ProgId meta; the engine's paste
    // processor changes behavior on it.
    expect(engine.clipboardBase.pastedFrom).toBe(0);
    expect(engine.api.IsLongActionCurrent).toBe(0);
    expect(engine.clipboardBase.PasteFlag).toBe(false);
    expect(vendorSpy).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });

  it("cannot wedge the editor when there is no clipboard data at all", () => {
    const event = pasteEvent(undefined);
    document.body.dispatchEvent(event);

    expect(engine.pasteCalls).toHaveLength(0);
    expect(engine.api.IsLongActionCurrent).toBe(0);
    expect(engine.clipboardBase.PasteFlag).toBe(false);
    expect(vendorSpy).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
    expect(notices()).toHaveLength(1);
    expect(notices()[0]!.message).toMatch(/nothing was pasted/i);
  });

  it("stops a getData that throws instead of handing it to the engine", () => {
    const event = pasteEvent({
      types: ["text/html"],
      items: [],
      getData: () => {
        throw new Error("denied");
      },
    });
    document.body.dispatchEvent(event);

    expect(engine.pasteCalls).toHaveLength(0);
    expect(engine.api.IsLongActionCurrent).toBe(0);
    expect(vendorSpy).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
    expect(notices()).toHaveLength(1);
  });

  it("leaves a plain-text paste to the engine's own handler", () => {
    const event = pasteEvent(byType({ "text/plain": "hello" }));
    document.body.dispatchEvent(event);

    expect(vendorSpy).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(false);
    expect(engine.pasteCalls).toHaveLength(0);
    expect(engine.api.IsLongActionCurrent).toBe(0);
  });

  it("leaves the editor's own internal payload to the engine's handler", () => {
    const event = pasteEvent(
      byType({
        "text/x-custom": "asc_internalData2;AAAA",
        "text/html": "<p>the html mirror of the internal copy</p>",
      }),
    );
    document.body.dispatchEvent(event);

    expect(vendorSpy).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(false);
    expect(engine.pasteCalls).toHaveLength(0);
  });

  it("reports an images-only paste instead of silently dropping it", () => {
    const event = pasteEvent(
      byType({ "text/html": '<img src="blob:whatever">', "text/plain": "" }),
    );
    document.body.dispatchEvent(event);

    expect(engine.pasteCalls).toHaveLength(0);
    expect(engine.api.IsLongActionCurrent).toBe(0);
    expect(event.defaultPrevented).toBe(true);
    expect(notices()).toHaveLength(1);
    expect(notices()[0]!.message).toMatch(/images/i);
  });

  it("pastes the text of mixed content and says the pictures were left out", () => {
    const event = pasteEvent(
      byType({
        "text/html": '<p>kept</p><img src="blob:whatever"><p>also kept</p>',
        "text/plain": "kept\nalso kept",
      }),
    );
    document.body.dispatchEvent(event);

    expect(engine.pasteCalls).toHaveLength(1);
    const element = engine.pasteCalls[0]![1] as HTMLElement;
    expect(element.querySelector("img")).toBeNull();
    expect(element.textContent).toContain("kept");
    expect(engine.api.IsLongActionCurrent).toBe(0);
    expect(notices()).toHaveLength(1);
    expect(notices()[0]!.message).toMatch(/without the pictures/i);
  });

  it("never lets pasted markup keep script or handler attributes", () => {
    const w = window as unknown as { __pwned?: boolean };
    const event = pasteEvent(
      byType({
        "text/html":
          '<p onclick="window.__pwned=true">hi</p>' +
          '<svg onload="window.__pwned=true"></svg>' +
          "<script>window.__pwned=true</script>" +
          '<a href="javascript:window.__pwned=true">link</a>' +
          '<iframe src="https://example.com"></iframe>',
        "text/plain": "hi link",
      }),
    );
    document.body.dispatchEvent(event);

    expect(engine.pasteCalls).toHaveLength(1);
    const element = engine.pasteCalls[0]![1] as HTMLElement;
    expect(element.querySelector("script")).toBeNull();
    expect(element.querySelector("iframe")).toBeNull();
    expect(element.querySelector("[onclick]")).toBeNull();
    expect(element.querySelector("[onload]")).toBeNull();
    const link = element.querySelector("a");
    expect(link?.getAttribute("href") ?? "").not.toMatch(/^\s*javascript:/i);
    expect(element.textContent).toContain("hi");
    expect(w.__pwned).toBeUndefined();
  });

  it("releases the counter through the spreadsheet's own paste end", () => {
    // The spreadsheet engine's cell-edit paste stores the completion
    // callback and never invokes it (its in-cell branches end with
    // Paste_Process_End only), so the shim must also take completion from
    // Paste_Process_End when the cell editor is the one running.
    const w = window as unknown as {
      editor?: unknown;
      editorCell?: unknown;
      AscCommon: { g_specialPasteHelper: { Paste_Process_End(): void } };
    };
    w.editorCell = engine.api;
    w.editor = undefined;
    const originalEnd = w.AscCommon.g_specialPasteHelper.Paste_Process_End;
    engine.api.asc_PasteData = (...args: unknown[]) => {
      engine.pasteCalls.push(args);
      w.AscCommon.g_specialPasteHelper.Paste_Process_End();
    };
    const event = pasteEvent(
      byType({ "text/html": "<p>cell content</p>", "text/plain": "cell content" }),
    );
    document.body.dispatchEvent(event);

    expect(engine.pasteCalls).toHaveLength(1);
    expect(engine.api.IsLongActionCurrent).toBe(0);
    expect(engine.clipboardBase.PasteFlag).toBe(false);
    // The wrapper restores the engine's own function after the first signal.
    expect(w.AscCommon.g_specialPasteHelper.Paste_Process_End).toBe(originalEnd);
  });

  it("answers the paste RPC through the same takeover path", () => {
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          t: "engramEditorRpc",
          id: 41,
          method: "paste",
          arg: { html: "<p><i>driven</i> paste</p>", text: "driven paste" },
        },
        source: window,
      }),
    );

    expect(engine.pasteCalls).toHaveLength(1);
    expect(engine.pasteCalls[0]![0]).toBe(8);
    expect(engine.api.IsLongActionCurrent).toBe(0);
    const results = rpcResults().filter((r) => r.id === 41);
    expect(results).toHaveLength(1);
    expect(results[0]!.error).toBeNull();
    expect(results[0]!.value).toBe(true);
  });

  it("answers the paste RPC with text alone through the engine's text format", () => {
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { t: "engramEditorRpc", id: 42, method: "paste", arg: { text: "plain drive" } },
        source: window,
      }),
    );

    expect(engine.pasteCalls).toHaveLength(1);
    expect(engine.pasteCalls[0]![0]).toBe(1); // Text
    expect(engine.pasteCalls[0]![1]).toBe("plain drive");
    expect(engine.api.IsLongActionCurrent).toBe(0);
  });

  it("reports the counters and the last paste through pasteProbe", () => {
    document.body.dispatchEvent(
      pasteEvent(byType({ "text/html": "<p>probe me</p>", "text/plain": "probe me" })),
    );
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { t: "engramEditorRpc", id: 43, method: "pasteProbe" },
        source: window,
      }),
    );

    const results = rpcResults().filter((r) => r.id === 43);
    expect(results).toHaveLength(1);
    const probe = results[0]!.value as {
      IsLongActionCurrent: number;
      PasteFlag: boolean;
      lastPaste: {
        hadClipboardData: boolean;
        htmlLength: number;
        textLength: number;
        handledBy: string;
      };
    };
    expect(probe.IsLongActionCurrent).toBe(0);
    expect(probe.PasteFlag).toBe(false);
    expect(probe.lastPaste.hadClipboardData).toBe(true);
    expect(probe.lastPaste.htmlLength).toBeGreaterThan(0);
    expect(probe.lastPaste.handledBy).toBe("shim");
  });
});
