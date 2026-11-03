// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { PhoneTabs } from "./PhoneTabs";

let container: HTMLDivElement;
let root: Root;
const handlers = {
  onTimeline: vi.fn(),
  onFiles: vi.fn(),
  onPhotos: vi.fn(),
  onSearch: vi.fn(),
  onMore: vi.fn(),
};

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function mount(active: Parameters<typeof PhoneTabs>[0]["active"]) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<PhoneTabs active={active} {...handlers} />));
}

const tabs = () => [...container.querySelectorAll("nav.tabbar button")];

describe("the phone's tabs", () => {
  it("the phone's tabs are Timeline, Files, Photos, Search and More", () => {
    mount("files");
    expect(tabs().map((tab) => tab.textContent)).toEqual(["Timeline", "Files", "Photos", "Search", "More"]);
    expect(tabs().filter((tab) => tab.classList.contains("active")).map((tab) => tab.textContent)).toEqual(["Files"]);
    // Notices is no tab: the bell sits in the top bar, as on the Mac.
    expect(container.textContent).not.toContain("Notices");
  });

  it("Timeline opens at now, even from the trip page", () => {
    mount("timeline");
    act(() => tabs()[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(handlers.onTimeline).toHaveBeenCalledTimes(1);
    expect(tabs()[0]!.getAttribute("aria-current")).toBe("page");
  });
});
