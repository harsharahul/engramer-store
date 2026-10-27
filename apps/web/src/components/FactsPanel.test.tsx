// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Fact } from "../intel/facts";
import type { FileEntry } from "../store";
import { LibraryIntel } from "./FactsPanel";

vi.mock("../store", () => ({
  useStore: (select: (state: unknown) => unknown) =>
    select({ session: { email: "a@example.com" }, dismissFact: vi.fn() }),
}));

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const DAY = 86_400_000;
const isoIn = (days: number) => new Date(Date.now() + days * DAY).toISOString().slice(0, 10);

const due = (value: string, confirmed: boolean): Fact => ({
  id: `due:${value}`,
  kind: "due",
  document: "other",
  value,
  label: "Payment due",
  source: "label",
  confidence: 0.7,
  ...(confirmed ? { confirmed: true } : {}),
});

const file = (id: string, name: string, facts: Fact[], tags: string[] = []): FileEntry =>
  ({
    id,
    folderId: null,
    name,
    mime: "application/pdf",
    size: 10,
    mtime: 0,
    hasText: true,
    hasClip: false,
    inlineText: false,
    tags,
    facts,
    favorite: false,
    key: new Uint8Array(32),
    hasThumb: false,
    trashed: false,
    createdAt: 0,
    updatedAt: 0,
  }) as FileEntry;

function render(files: FileEntry[]) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<LibraryIntel files={files} onOpen={() => {}} />));
}

describe("the Notices panel", () => {
  it("Coming up lists a tracked due date and leaves an untracked one out", () => {
    render([file("a", "Water bill.pdf", [due(isoIn(10), true)]), file("b", "Flyer.pdf", [due(isoIn(12), false)])]);
    expect(container.textContent).toContain("Coming up");
    expect(container.textContent).toContain("Water bill.pdf");
    expect(container.textContent).not.toContain("Flyer.pdf");
  });
});
