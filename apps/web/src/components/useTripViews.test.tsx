// @vitest-environment jsdom
process.env.TZ = "America/Los_Angeles";

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { lisbonFiles, TAG } from "../intel/__fixtures__/lisbon";
import type { TripWindow } from "../intel/insights";
import type { TripView } from "../intel/tripview";
import { useStore, type FileEntry } from "../store";
import { useTripView, useTripWindows } from "./useTripViews";

let container: HTMLDivElement;
let root: Root;
const seen: (TripWindow[] | undefined)[] = [];

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

function Probe(props: { now: number }) {
  seen.push(useTripWindows(props.now));
  return null;
}

const opened: (TripView | null | undefined)[] = [];
function OneTrip(props: { tag: string; now: number }) {
  opened.push(useTripView(props.tag, { now: props.now }));
  return null;
}

async function mountTrip(tag: string, now: number) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  const files = lisbonFiles().map((file) => ({ ...file, tags: [TAG], mail: undefined }) as unknown as FileEntry);
  useStore.setState({ files: new Map(files.map((file) => [file.id, file])), session: { email: "t@example.com" } as never });
  opened.length = 0;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<OneTrip tag={tag} now={now} />));
  await act(async () => {
    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  });
}

describe("useTripView", () => {
  it("a trip far in the past opens like any other", async () => {
    await mountTrip(TAG, Date.UTC(2027, 5, 1, 12));
    expect(opened[0]).toBeUndefined();
    expect(opened.at(-1)).toMatchObject({ tag: TAG, city: "Lisbon" });
  });

  it("a tag no trip carries reads as no trip", async () => {
    await mountTrip("trip:gone-2026-01", Date.UTC(2026, 9, 26, 17));
    expect(opened.at(-1)).toBeNull();
  });
});

describe("useTripWindows", () => {
  it("says nothing until the trips are read, so nothing is told twice", async () => {
    const now = Date.UTC(2026, 9, 26, 17);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    const files = lisbonFiles().map((file) => ({ ...file, tags: [TAG], mail: undefined }) as unknown as FileEntry);
    useStore.setState({ files: new Map(files.map((file) => [file.id, file])), session: { email: "t@example.com" } as never });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(<Probe now={now} />));
    expect(seen[0]).toBeUndefined();
    await act(async () => {
      for (let i = 0; i < 5; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    });
    expect(seen.at(-1)).toHaveLength(1);
    expect(seen.at(-1)![0]!.tag).toBe(TAG);
  });
});
