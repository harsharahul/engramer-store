// @vitest-environment jsdom
// The details pane and the bell show an invite at the same day and time as
// its Timeline row. Pin a zone behind UTC, where the difference shows.
process.env.TZ = "America/Los_Angeles";

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withExactAcceptance, type Fact } from "../intel/facts";
import type { FileEntry } from "../store";
import { FileFacts, LibraryIntel } from "./FactsPanel";

vi.mock("../store", () => ({
  useStore: (select: (state: unknown) => unknown) =>
    select({
      session: { email: "a@example.com" },
      files: new Map(),
      confirmFact: vi.fn(),
      dismissFact: vi.fn(),
      factEvidence: vi.fn(async () => []),
      undoTrip: vi.fn(),
    }),
}));

// Mon 30 Nov 2026, 10:00 in San Francisco.
const NOW = new Date("2026-11-30T10:00:00-08:00").getTime();
// 03:00 UTC on Wed 2 Dec is 19:00 on Tue 1 Dec in San Francisco.
const call: Fact = withExactAcceptance({
  id: "event:2026-12-02 team call",
  kind: "event",
  document: "other",
  value: "2026-12-02",
  time: "03:00",
  zone: "UTC",
  label: "Team call",
  source: "ics",
  confidence: 1,
});
const invite = {
  id: "invite",
  folderId: null,
  name: "invite.ics",
  mime: "text/calendar",
  size: 10,
  mtime: NOW,
  hasText: true,
  hasClip: false,
  inlineText: false,
  tags: [],
  facts: [call],
  favorite: false,
  key: new Uint8Array(32),
  hasThumb: false,
  trashed: false,
  createdAt: NOW,
  updatedAt: NOW,
} as unknown as FileEntry;

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe("an invite in the details pane and the bell", () => {
  it("the file's dates show the invite at the device's day and time", () => {
    act(() => root.render(<FileFacts file={invite} />));
    expect(container.textContent).toContain("1 December 2026 at 19:00");
    expect(container.textContent).not.toContain("03:00");
    expect(container.textContent).toContain("tomorrow");
  });

  it("Coming up names the same time and opens the same day", () => {
    const onOpenDay = vi.fn();
    act(() => root.render(<LibraryIntel files={[invite]} onOpen={() => {}} onOpenDay={onOpenDay} />));
    expect(container.textContent).toContain("Team call, 1 December 2026 at 19:00");
    const row = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Team call"))!;
    act(() => row.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onOpenDay).toHaveBeenCalledWith("2026-12-01");
  });
});
