// @vitest-environment jsdom
process.env.TZ = "America/Los_Angeles";

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withExactAcceptance, type Fact } from "../intel/facts";
import { useStore, type FileEntry } from "../store";
import { TimelineView } from "./TimelineView";

const NOW = Date.UTC(2026, 8, 8, 15, 40); // Tue 8 Sep 2026, 08:40 PDT
let container: HTMLDivElement;
let root: Root;
const scrolled = vi.fn();

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled(this);
  };
});

const entry = (id: string, facts: Fact[]): FileEntry =>
  ({
    id,
    folderId: null,
    name: `${id}.email`,
    mime: "application/vnd.engram.email+json",
    size: 10,
    mtime: NOW,
    hasText: false,
    hasClip: false,
    inlineText: false,
    tags: [],
    facts,
    favorite: false,
    key: new Uint8Array(32),
    hasThumb: false,
    trashed: false,
    createdAt: 0,
    updatedAt: 0,
    mail: { messageId: id, from: "Sender", fromAddress: "s@example.com", to: [], date: NOW, subject: id, attachmentIds: [] },
  }) as FileEntry;
const event = (value: string, label: string, time: string): Fact =>
  withExactAcceptance({ id: `event:${value}:${label}`, kind: "event", document: "dining", value, label, time, source: "jsonld", confidence: 1 });
const files = [entry("dinner", [event("2026-09-08", "Table at Cedar & Salt", "19:30")]), entry("concert", [event("2026-09-20", "Concert", "19:00")])];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  scrolled.mockClear();
  localStorage.clear();
  useStore.setState({
    session: { email: "t@example.com", token: "t", masterKey: new Uint8Array(32), privateKey: new Uint8Array(32), publicKey: "" },
    files: new Map(files.map((file) => [file.id, file])),
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

async function settle() {
  await act(async () => {
    await import("../intel/tables/airports.json");
    for (let i = 0; i < 3; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  });
}

async function render(focus?: { day?: string; now?: boolean; nonce: number }) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root.render(
      <TimelineView
        files={files}
        factsOn
        {...(focus ? { focus } : {})}
        onInspect={() => {}}
        onOpen={() => {}}
        onToast={() => {}}
        onTurnOnDates={() => {}}
      />,
    ),
  );
  await settle();
}

const button = (label: RegExp) => [...container.querySelectorAll("button")].find((b) => label.test(b.textContent ?? ""))!;
const press = async (label: RegExp) => {
  act(() => button(label).dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await settle();
};

describe("the Timeline view", () => {
  it("the view bar switches to Month and back, and Now scrolls to now", async () => {
    await render();
    expect(container.querySelector(".tln-list")).not.toBeNull();
    expect(container.textContent).toContain("Table at Cedar & Salt");
    await press(/^Month$/);
    expect(container.querySelector(".mon h3")!.textContent).toBe("September 2026");
    expect(container.querySelector(".tln-list")).toBeNull();
    await press(/^Next$/);
    expect(container.querySelector(".mon h3")!.textContent).toBe("October 2026");
    await press(/^Timeline$/);
    expect(container.querySelector(".tln-list")).not.toBeNull();
    scrolled.mockClear();
    await press(/^Now$/);
    expect(scrolled.mock.calls.some(([el]) => (el as Element).classList.contains("tln-now"))).toBe(true);
  });

  it("the Month view opens at its top, wherever the list was scrolled", async () => {
    await render();
    const scroller = container.querySelector<HTMLElement>(".tln-scroll")!;
    scroller.scrollTop = 300;
    await press(/^Month$/);
    expect(scroller.scrollTop).toBe(0);
  });

  it("a day asked for from elsewhere opens there, not at now", async () => {
    await render({ day: "2026-09-20", nonce: 1 });
    const last = scrolled.mock.calls.map(([el]) => el as Element).at(-1);
    expect(last?.textContent).toContain("Sun 20 Sep");
  });

  it("a day picked in the Month view opens on the list, with every row shown", async () => {
    await render();
    await press(/^Bills$/);
    await press(/^Month$/);
    act(() => container.querySelector('[data-day="2026-09-20"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await settle();
    expect(button(/^All$/).getAttribute("aria-pressed")).toBe("true");
  });

  it("a day picked in the Month view opens on the list", async () => {
    await render();
    await press(/^Month$/);
    scrolled.mockClear();
    act(() => container.querySelector('[data-day="2026-09-20"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await settle();
    expect(container.querySelector(".tln-list")).not.toBeNull();
    const target = scrolled.mock.calls.map(([el]) => el as Element).find((el) => el.classList.contains("tln-dayh"));
    expect(target?.textContent).toContain("Sun 20 Sep");
  });
});
