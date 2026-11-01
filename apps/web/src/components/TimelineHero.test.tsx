// @vitest-environment jsdom
process.env.TZ = "America/Los_Angeles";

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgendaRow } from "../intel/agendarows";
import { everydayOf } from "../intel/everyday";
import { useStore } from "../store";
import { TimelineHero } from "./TimelineHero";

const NOW = Date.UTC(2026, 8, 8, 15, 40); // Tue 8 Sep 2026, 08:40 PDT
let container: HTMLDivElement;
let root: Root;
const resolveFacts = vi.fn(async () => {});
const onToast = vi.fn();
const onTurnOnDates = vi.fn();

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  for (const fn of [resolveFacts, onToast, onTurnOnDates]) {
    fn.mockClear();
  }
  useStore.setState({ resolveFacts });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

const row = (id: string, kind: AgendaRow["kind"], day: string, time: string | undefined, extra: Partial<AgendaRow> = {}): AgendaRow => ({
  id,
  kind,
  tag: kind.toUpperCase(),
  day,
  ...(time ? { time } : {}),
  title: id,
  source: "EMAIL",
  fileIds: [`f-${id}`],
  past: false,
  ...extra,
});
const usd = (value: string) => ({ currency: "USD", value });
const september = () =>
  everydayOf(
    [
      row("Rent · September", "bill", "2026-09-01", "09:00", { amount: usd("2400.00"), past: true }),
      row("Groceries", "bill", "2026-09-07", "18:40", { amount: usd("86.40"), past: true }),
      row("Table at Cedar & Salt", "event", "2026-09-08", "19:30"),
      row("Headphones arrive", "parcel", "2026-09-09", "10:00"),
      row("Internet bill due", "due", "2026-09-10", undefined, { amount: usd("65.00") }),
      row("Concert", "event", "2026-09-12", "19:00", { amount: usd("148.00") }),
      row("Car registration renews", "due", "2026-09-30", undefined, { amount: usd("212.00"), ask: true, factIds: ["due:dmv"], sub: "Registration renewal notice" }),
    ],
    [],
    NOW,
  );

function render(factsOn = true, homeCity = "San Francisco") {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root.render(
      <TimelineHero
        everyday={september()}
        homeCity={homeCity}
        now={NOW}
        factsOn={factsOn}
        onInspect={() => {}}
        onOpen={() => {}}
        onToast={onToast}
        onTurnOnDates={onTurnOnDates}
      />,
    ),
  );
}

const text = () => container.textContent ?? "";
async function settle() {
  await act(async () => {
    await import("../intel/tables/airports.json");
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}
const click = (label: RegExp) => {
  const button = [...container.querySelectorAll("button")].find((b) => label.test(b.textContent ?? ""));
  act(() => {
    button!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
};

describe("the Everyday hero", () => {
  it("the poster reads San Francisco on an ordinary Tuesday morning", () => {
    render();
    const poster = container.querySelector(".tln-poster")!;
    expect(poster.textContent).toContain("Today");
    expect(poster.textContent).toContain("Tuesday");
    expect(poster.textContent).toContain("1 later today · 3 this week");
    expect(poster.textContent).toContain("San Francisco");
    expect(poster.textContent).toContain("Tue 8 Sep · 08:40 in San Francisco");
    expect(container.querySelector(".tln-sky")!.classList.contains("tln-sky-day")).toBe(true);
  });

  it("the poster names the country briefly, as the prototype does", async () => {
    render();
    await settle();
    expect(container.querySelector(".tln-pmeta")!.textContent).toBe("USA · Tue 8 Sep · 08:40 in San Francisco");
  });

  it("the poster tells home's own time when the device is elsewhere", async () => {
    // The device is in San Francisco; home is Lisbon, where it is 16:40.
    render(true, "Lisbon");
    await settle();
    expect(container.querySelector(".tln-pmeta")!.textContent).toBe("Portugal · Tue 8 Sep · 16:40 in Lisbon");
    expect(container.querySelector(".tln-sky")!.classList.contains("tln-sky-day")).toBe(true);
  });

  it("the cards read the prototype's September", () => {
    render();
    expect(text()).toContain("Today · Tue 8 Sep");
    expect(text()).toContain("in 10 h 50 m");
    expect(text()).toContain("This week");
    expect(text()).toContain("Headphones arrive");
    expect(text()).toContain("Needs a yes");
    expect(text()).toContain("Car registration renews");
    expect(text()).toContain("Wed 30 Sep · USD 212.00");
    expect(text()).toContain("Registration renewal notice. Nothing is tracked until you say yes.");
    expect(text()).toContain("September so far");
    expect(text()).toContain("2,486.40");
    expect(text()).toContain("Read from 2 receipts and 1 bills · never converted");
    expect(text()).toContain("No trips planned. When a booking lands in your mail, the trip appears here on its own.");
  });

  it("Needs a yes confirms and dismisses", () => {
    render();
    click(/Confirm date/);
    expect(resolveFacts).toHaveBeenCalledWith("f-Car registration renews", { confirm: ["due:dmv"] });
    expect(onToast).toHaveBeenCalledWith("Date confirmed. A notice comes a week before.");
    click(/Not right/);
    expect(resolveFacts).toHaveBeenCalledWith("f-Car registration renews", { dismiss: ["due:dmv"] });
    expect(onToast).toHaveBeenCalledWith("Dismissed. It will not come back.");
  });

  it("with dates off the hero says so once", () => {
    render(false);
    expect(text()).toContain("Dates are not read yet. Turn on Read dates in documents to see your bills, bookings and trips here.");
    expect(text()).not.toContain("Needs a yes");
    click(/Turn on/);
    expect(onTurnOnDates).toHaveBeenCalled();
  });
});
