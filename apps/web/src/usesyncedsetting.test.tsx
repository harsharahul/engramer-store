// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { readingWindowMonths, setReadingWindowMonths } from "./intel/reading";
import { settingsEvents, SETTINGS_APPLIED_EVENT } from "./settingsync";
import { useSyncedSetting } from "./usesyncedsetting";

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  localStorage.clear();
});

function Months() {
  const [months, refresh] = useSyncedSetting(readingWindowMonths);
  return (
    <button
      onClick={() => {
        setReadingWindowMonths(3);
        refresh();
      }}
    >
      {months}
    </button>
  );
}

function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<Months />));
}

describe("useSyncedSetting", () => {
  it("shows a choice another device made without reopening the view", () => {
    mount();
    expect(container.textContent).toBe("12");
    act(() => {
      localStorage.setItem("engram-reading-window", "6");
      settingsEvents.dispatchEvent(new Event(SETTINGS_APPLIED_EVENT));
    });
    expect(container.textContent).toBe("6");
  });

  it("shows this device's own choice once written", () => {
    mount();
    act(() => container.querySelector("button")!.click());
    expect(container.textContent).toBe("3");
  });
});
