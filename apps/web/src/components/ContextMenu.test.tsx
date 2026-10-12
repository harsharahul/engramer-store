// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ContextMenu } from "./ContextMenu";

/**
 * In local mode a server-only action stays where it always was but cannot
 * run: it is shown greyed with its reason, so a person learns the shape of
 * the app without being able to trigger a request the backend answers 404.
 */

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  if (!window.matchMedia) {
    window.matchMedia = () =>
      ({ matches: false, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList;
  }
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("a greyed menu item", () => {
  it("is shown disabled and never runs", () => {
    const run = vi.fn();
    const onClose = vi.fn();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(
        <ContextMenu
          x={0}
          y={0}
          onClose={onClose}
          items={[
            { id: "share", label: "Share · needs a server", disabled: true, run },
            { id: "open", label: "Open", run },
          ]}
        />,
      );
    });
    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>("button.ctx-item"));
    expect(buttons).toHaveLength(2);
    const [share, open] = buttons as [HTMLButtonElement, HTMLButtonElement];
    expect(share.disabled).toBe(true);
    expect(share.getAttribute("aria-disabled")).toBe("true");
    expect(share.textContent).toContain("needs a server");
    act(() => share.click());
    expect(run).not.toHaveBeenCalled();
    act(() => open.click());
    expect(run).toHaveBeenCalledTimes(1);
  });
});
