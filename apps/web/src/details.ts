/**
 * Which file the details panel is about.
 *
 * The panel has two homes: a pane beside the grid on a wide screen, and a
 * sheet over it on a phone. Both used to read the file out of the current
 * selection, which is the wrong source. A selection is cleared by ordinary
 * things — a tap on empty space, a menu opening, the grid rebuilding under
 * a re-render — and each of those emptied a panel that had just been
 * deliberately opened.
 *
 * So opening details PINS a file, and the pin is what the panel reads. The
 * wide layout still follows the selection as you click around, because that
 * is what makes a pane useful; it falls back to the pin only when the
 * selection is empty, which is exactly the case that used to blank it.
 */

export interface DetailsSubject {
  /** The file explicitly pinned by opening details, if any. */
  pinnedId: string | null;
  /** The single selected file, when exactly one is selected. */
  selectedId: string | null;
  /** Phone layout: a sheet, which never follows the selection. */
  sheet: boolean;
}

/**
 * The file id the panel should show, or null for nothing.
 *
 * An id rather than a file, so this is decidable without a store and the
 * caller resolves it: a pin can outlive the file it names.
 */
export function detailsSubjectId(subject: DetailsSubject): string | null {
  if (subject.sheet) {
    // A sheet is opened on one file, and is about that file until it closes.
    return subject.pinnedId;
  }
  return subject.selectedId ?? subject.pinnedId;
}
