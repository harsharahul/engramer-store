// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { isEmptySpace } from "./marquee";

/**
 * A press on an item must reach the item. Anything the marquee counts as
 * empty space starts a selection band instead and the click never lands:
 * search rows lost their clicks that way, and folder rows in the list
 * layout did too until they were named here.
 */
describe("isEmptySpace", () => {
  const within = (html: string, selector: string) => {
    document.body.innerHTML = `<div class="content">${html}</div>`;
    return document.querySelector(selector);
  };

  it("treats a folder row, and anything inside it, as an item", () => {
    expect(isEmptySpace(within('<div class="row folder-row"><span class="name">Notes</span></div>', ".folder-row"))).toBe(false);
    expect(isEmptySpace(within('<div class="row folder-row"><span class="name">Notes</span></div>', ".name"))).toBe(false);
  });

  it("treats the content's own background as empty", () => {
    expect(isEmptySpace(within('<div class="rows list-view"></div>', ".list-view"))).toBe(true);
  });
});
