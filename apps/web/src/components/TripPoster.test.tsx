// @vitest-environment jsdom
process.env.TZ = "America/Los_Angeles";

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { lisbonFiles, lisbonTrip } from "../intel/__fixtures__/lisbon";
import { everydayOf } from "../intel/everyday";
import { instantOf } from "../intel/instants";
import { momentOf, posterOf } from "../intel/moments";
import type { TripView } from "../intel/tripview";
import { useStore } from "../store";
import { TimelineHero } from "./TimelineHero";
import { TripPoster } from "./TripPoster";

const LA = "America/Los_Angeles";
const LIS = "Europe/Lisbon";
let container: HTMLDivElement;
let root: Root;
let lisbon: TripView;
let alone: TripView;

beforeAll(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  lisbon = (await lisbonTrip()).view;
  alone = (await lisbonTrip(lisbonFiles().filter((file) => file.id !== "hotel"))).view;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

function mount(node: React.ReactNode, now: number) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(node));
}

const text = (selector: string) => container.querySelector(selector)?.textContent ?? "";

describe("the trip poster", () => {
  it("the poster shows the words of each moment", () => {
    const cases: [string, string, string, string[]][] = [
      ["2026-10-26", "10:00", LA, ["Next trip", "17 days", "until you fly"]],
      ["2026-11-11", "09:30", LA, ["Next trip", "Tomorrow", "TP 236 in 1 d 8 h"]],
      ["2026-11-12", "13:30", LA, ["Travel day", "Today", "TP 236 departs 18:10"]],
      ["2026-11-13", "06:00", LIS, ["TP 236 · SFO to LIS", "In the air", "lands 14:05 Lisbon time"]],
      ["2026-11-14", "15:42", LIS, ["You are here", "Day 3 of 5", "Night 2 of 3 at Casa do Rio"]],
      ["2026-11-16", "08:30", LIS, ["You are here", "Last day", "flight home at 13:20"]],
      ["2026-11-18", "19:00", LA, ["Your last trip", "Welcome back", "5 days in Lisbon"]],
    ];
    for (const [day, time, zone, [top, big, cap]] of cases) {
      const now = instantOf(day, time, zone);
      mount(<TripPoster poster={posterOf(momentOf([lisbon], now), now, LA)!} />, now);
      expect([text(".tln-ptop"), text(".tln-big"), text(".tln-cap")], `${day} ${time}`).toEqual([top, big, cap]);
      expect(text(".tln-city")).toBe("Lisbon");
      expect(text(".tln-wm")).toBe("LIS");
      act(() => root.unmount());
      container.remove();
      vi.useRealTimers();
    }
    mount(<div />, Date.now());
  });

  it("the meta line keeps the destination's clock", () => {
    const now = instantOf("2026-11-14", "15:42", LIS);
    mount(<TripPoster poster={posterOf(momentOf([lisbon], now), now, LA)!} />, now);
    expect(text(".tln-pmeta")).toBe("Portugal · Sat 14 Nov · 15:42 in Lisbon");
    expect(container.querySelector(".tln-sky")!.classList.contains("tln-sky-day")).toBe(true);
  });

  it("a trip with no stay says how many nights in the city", () => {
    const now = instantOf("2026-11-14", "15:42", LIS);
    mount(<TripPoster poster={posterOf(momentOf([alone], now), now, LA)!} />, now);
    expect(text(".tln-cap")).toBe("3 nights in Lisbon");
  });
});

describe("the hero follows the moment", () => {
  const hero = (now: number, views: TripView[]) => (
    <TimelineHero
      everyday={everydayOf([], [], now)}
      moment={momentOf(views, now)}
      rows={[]}
      homeCity="San Francisco"
      now={now}
      factsOn
      onInspect={() => {}}
      onOpen={() => {}}
      onToast={() => {}}
      onTurnOnDates={() => {}}
    />
  );

  it("the hero shows the trip's poster while a trip is near", () => {
    useStore.setState({ resolveFacts: vi.fn(async () => {}) });
    const now = instantOf("2026-11-14", "15:42", LIS);
    mount(hero(now, [lisbon]), now);
    expect(text(".tln-ptop")).toBe("You are here");
    expect(text(".tln-big")).toBe("Day 3 of 5");
  });

  it("the hero stays the ordinary day with no trip near", () => {
    useStore.setState({ resolveFacts: vi.fn(async () => {}) });
    const now = instantOf("2026-12-01", "08:40", LA);
    mount(hero(now, [lisbon]), now);
    expect(text(".tln-ptop")).toBe("Today");
    expect(text(".tln-big")).toBe("Tuesday");
  });
});
