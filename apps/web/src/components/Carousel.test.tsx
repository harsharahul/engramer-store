// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MOBILE_QUERY } from "../media";
import { Carousel } from "./Carousel";

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // A phone, with motion allowed.
  window.matchMedia = ((query: string) => ({
    matches: query === MOBILE_QUERY,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  })) as never;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const Card = (props: { name: string }) => <section className="tln-card">{props.name}</section>;
const Nothing = () => null;

function mount(children: React.ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<Carousel label="Today's cards">{children}</Carousel>));
}

const dots = () => [...container.querySelectorAll(".tln-dots button")];

describe("the hero's carousel", () => {
  it("one card shows no dots", () => {
    mount(<Card name="Today" />);
    expect(dots()).toHaveLength(0);
  });

  it("dots follow the cards that render", () => {
    mount(
      <>
        <Card name="Today" />
        <Nothing />
        <Card name="This week" />
      </>,
    );
    expect(dots().map((dot) => dot.getAttribute("aria-label"))).toEqual(["Card 1 of 2", "Card 2 of 2"]);
  });

  it("a dot brings its card into view", () => {
    mount(
      <>
        <Card name="Today" />
        <Card name="This week" />
      </>,
    );
    const region = container.querySelector<HTMLElement>(".tln-cards")!;
    const scrollTo = vi.fn();
    region.scrollTo = scrollTo as never;
    Object.defineProperty(region.children[1]!, "offsetLeft", { value: 342 });
    act(() => dots()[1]!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(scrollTo).toHaveBeenCalledWith({ left: 342, behavior: "smooth" });
  });
});
