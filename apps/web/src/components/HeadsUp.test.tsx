// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Fact } from "../intel/facts";
import type { FileEntry } from "../store";
import { HeadsUp } from "./HeadsUp";

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const amount = (value: string, source: Fact["source"], confidence: number, other: string): Fact => ({
  id: `amount:${value}`,
  kind: "amount",
  document: "invoice",
  value,
  unit: "USD",
  label: "Amount due",
  source,
  confidence,
  disputed: `amount:${other}`,
});

const bill = {
  id: "bill",
  folderId: null,
  name: "Your bill.email",
  mime: "application/vnd.engram.email+json",
  size: 10,
  mtime: 0,
  hasText: true,
  hasClip: false,
  inlineText: false,
  tags: [],
  facts: [amount("56.00", "label", 0.7, "65.00"), amount("65.00", "model", 0.45, "56.00")],
  favorite: false,
  key: new Uint8Array(32),
  hasThumb: false,
  trashed: false,
  createdAt: 0,
  updatedAt: 0,
} as FileEntry;

describe("a disagreement in the heads-up strip", () => {
  it("offers both readings as one question and confirms the one picked", () => {
    const onConfirm = vi.fn();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(<HeadsUp files={[bill]} onOpen={() => {}} onConfirm={onConfirm} onDismiss={() => {}} />);
    });
    const choices = [...container.querySelectorAll("button")].filter((b) => /USD/.test(b.textContent ?? ""));
    expect(choices.map((b) => b.textContent)).toEqual(["USD 56.00", "USD 65.00"]);
    act(() => {
      choices[1]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onConfirm).toHaveBeenCalledWith("bill", "amount:65.00", undefined);
  });
});
