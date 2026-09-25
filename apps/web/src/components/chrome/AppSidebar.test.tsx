// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AppSidebar, type AppSidebarProps } from "./AppSidebar";

/**
 * The sidebar's contracts, now that shadcn/ui draws it:
 * - the rail never hides a group: each group keeps a header button with its
 *   icon, only its rows fold away (the hidden-albums lesson);
 * - a group's rows never shrink below themselves in a short window;
 * - the account shows the whole address (name line + email line).
 */

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const props = (collapsed: boolean): AppSidebarProps => ({
  collapsed,
  places: [
    { key: "files", label: "Files", icon: <svg data-icon="files" />, active: true, onSelect: vi.fn() },
    { key: "trash", label: "Trash", icon: <svg data-icon="trash" />, active: false, onSelect: vi.fn() },
  ],
  groups: [
    {
      key: "albums",
      label: "Albums",
      icon: <svg data-icon="albums" />,
      open: true,
      onToggle: vi.fn(),
      rows: [{ key: "t", label: "Trip", icon: <svg />, active: false, count: 3, onSelect: vi.fn(), attrs: { "data-album": "t" } }],
    },
    {
      key: "library",
      label: "Library",
      icon: <svg data-icon="library" />,
      open: true,
      onToggle: vi.fn(),
      rows: [{ key: "p", label: "Photos", icon: <svg />, active: false, count: 9, onSelect: vi.fn() }],
    },
  ],
  usage: { label: "1 GB of 10 GB", percent: 10 },
  version: "0.0.0",
  account: { email: "alexandra.rivera@example.com", onOpen: vi.fn() },
});

function render(collapsed: boolean) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<AppSidebar {...props(collapsed)} />));
}

describe("AppSidebar", () => {
  it("keeps every group's header and icon in the rail; only the rows fold away", () => {
    render(true);
    expect(container.querySelector("[data-collapsible='icon']")).not.toBeNull();
    for (const key of ["albums", "library"]) {
      const group = container.querySelector(`[data-group='${key}']`)!;
      const header = group.querySelector(".sidebar-label")!;
      expect(header).not.toBeNull();
      expect(header.querySelector(`[data-icon='${key}']`)).not.toBeNull();
      expect(header.className).not.toContain("group-data-[collapsible=icon]:hidden");
    }
  });

  it("never lets a group's rows shrink below themselves", () => {
    render(false);
    const lists = container.querySelectorAll(".library-list");
    expect(lists.length).toBe(2);
    lists.forEach((list) => expect(list.className).toContain("tw:shrink-0"));
    expect(container.querySelector("[data-album='t']")).not.toBeNull();
  });

  it("shows the account's name and whole email on their own lines", () => {
    render(false);
    const account = container.querySelector(".account-button")!;
    expect(account.textContent).toContain("alexandra.rivera");
    expect(account.querySelector(".account-link")?.textContent).toBe("alexandra.rivera@example.com");
  });
});
