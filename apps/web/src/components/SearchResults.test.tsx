// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { SearchHit } from "../search";
import type { FileEntry } from "../store";
import { ResultRow } from "./SearchResults";

/**
 * A search result is an answer: one click opens it, the way the Ask
 * card and the command palette already behave. Selecting for a batch
 * action is what modifier clicks are for. The row used to copy the
 * Finder convention (click selects, double click opens), which read as
 * "clicking a result does nothing".
 */

const file = {
  id: "f1",
  folderId: null,
  name: "lease.pdf",
  mime: "application/pdf",
  size: 1024,
  mtime: 1_700_000_000_000,
  hasText: false,
  hasClip: false,
  hasThumb: false,
} as unknown as FileEntry;

const hit: SearchHit = {
  file,
  score: 1,
  matchedText: null,
  textRanges: [],
  nameRanges: [],
  matchedFolder: null,
};

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // jsdom has no matchMedia; the row asks it whether the pointer is coarse.
  window.matchMedia = (() => ({ matches: false })) as unknown as typeof window.matchMedia;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function mount(handlers: { onOpen: () => void; onSelect: (event: React.MouseEvent) => void }) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      <ResultRow
        hit={hit}
        path={null}
        index={0}
        cursor={false}
        selected={false}
        onSelect={handlers.onSelect}
        onOpen={handlers.onOpen}
        onMenu={() => {}}
      />,
    );
  });
  return container.querySelector<HTMLElement>(".row.result")!;
}

function click(target: HTMLElement, init: MouseEventInit = {}) {
  act(() => {
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...init }));
  });
}

describe("a search result row", () => {
  it("opens on one plain click", () => {
    const onOpen = vi.fn();
    const onSelect = vi.fn();
    const row = mount({ onOpen, onSelect });
    click(row);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("selects instead when a modifier is held, for batch actions", () => {
    const onOpen = vi.fn();
    const onSelect = vi.fn();
    const row = mount({ onOpen, onSelect });
    click(row, { metaKey: true });
    click(row, { shiftKey: true });
    expect(onSelect).toHaveBeenCalledTimes(2);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("reads as clickable", () => {
    const row = mount({ onOpen: () => {}, onSelect: () => {} });
    expect(row.getAttribute("role")).toBe("button");
  });
});
