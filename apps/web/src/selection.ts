/**
 * What a click does to the selection.
 *
 * One pure rule table shared by the files grid, the list, and the photos
 * grid, so the three surfaces cannot drift apart. The rules are the Mac's:
 * a click selects one thing, ⌘ toggles, ⇧ extends from the anchor, and
 * once several things are gathered (the bulk bar is up) a plain click
 * toggles too, because that bar is the visible promise that clicks add and
 * remove. The bar's own render condition is `isGathering`, which is the
 * same predicate this reducer reads: what the person sees is what decides.
 */

export interface SelectionState {
  selection: ReadonlySet<string>;
  /** Where a ⇧-range starts: the last item clicked without ⇧. */
  anchor: string | null;
}

export interface ClickModifiers {
  /** ⌘ on a Mac, Ctrl elsewhere. */
  meta: boolean;
  shift: boolean;
  /** The bulk bar is showing, so plain clicks toggle. */
  gathering: boolean;
}

/** The bulk bar shows, and clicks toggle, in explicit select mode or once
 * more than one item is selected by any means. */
export function isGathering(selectMode: boolean, selected: number): boolean {
  return selectMode || selected > 1;
}

export function nextSelection(
  prev: SelectionState,
  id: string,
  order: readonly string[],
  mods: ClickModifiers,
): SelectionState {
  if (mods.meta) {
    return { selection: toggled(prev.selection, id), anchor: id };
  }
  if (mods.shift && prev.anchor !== null) {
    const from = order.indexOf(prev.anchor);
    const to = order.indexOf(id);
    if (from >= 0 && to >= 0) {
      const [lo, hi] = from < to ? [from, to] : [to, from];
      const range = order.slice(lo, hi + 1);
      // Gathering keeps what was already picked; a bare range replaces it.
      const selection = mods.gathering ? new Set([...prev.selection, ...range]) : new Set(range);
      return { selection, anchor: prev.anchor };
    }
  }
  if (mods.gathering) {
    return { selection: toggled(prev.selection, id), anchor: id };
  }
  return { selection: new Set([id]), anchor: id };
}

function toggled(selection: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selection);
  if (next.has(id)) {
    next.delete(id);
  } else {
    next.add(id);
  }
  return next;
}
