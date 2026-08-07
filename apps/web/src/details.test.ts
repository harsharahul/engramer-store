import { describe, expect, it } from "vitest";
import { detailsSubjectId } from "./details";

/**
 * Twice now the details panel has opened and immediately emptied on a
 * phone, because it read its file out of the SELECTION and a selection is
 * cleared by ordinary things: a tap on empty space, a menu opening, the
 * grid rebuilding. The panel must hold the file it was opened on.
 */

describe("what the details panel is about", () => {
  it("keeps the file it was opened on when the selection is cleared", () => {
    // The exact failure people reported: open details, selection goes, panel
    // is left with nothing and closes.
    expect(detailsSubjectId({ pinnedId: "file-1", selectedId: null, sheet: true })).toBe("file-1");
    expect(detailsSubjectId({ pinnedId: "file-1", selectedId: null, sheet: false })).toBe("file-1");
  });

  it("follows the selection on a wide screen, where the pane is a companion to clicking around", () => {
    expect(detailsSubjectId({ pinnedId: "file-1", selectedId: "file-2", sheet: false })).toBe("file-2");
  });

  it("ignores the selection on a phone, where the sheet is about one file", () => {
    // A sheet opened on file-1 must not swap to whatever a stray tap selected.
    expect(detailsSubjectId({ pinnedId: "file-1", selectedId: "file-2", sheet: true })).toBe("file-1");
  });

  it("is about nothing when nothing is pinned or selected", () => {
    expect(detailsSubjectId({ pinnedId: null, selectedId: null, sheet: true })).toBeNull();
    expect(detailsSubjectId({ pinnedId: null, selectedId: null, sheet: false })).toBeNull();
  });
});
