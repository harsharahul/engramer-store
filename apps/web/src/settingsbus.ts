/**
 * A one-line meeting point between the preference setters and the sync
 * that pushes them to the account. The setters cannot import the sync
 * (it reaches the api and would drag half the app into their modules);
 * they announce here, and whoever installed the sync hears it.
 */

type Listener = () => void;

const listeners = new Set<Listener>();

/** Called by every preference setter after it wrote its value. */
export function settingChanged(): void {
  listeners.forEach((listener) => listener());
}

/** Subscribes to preference changes; returns the unsubscribe. */
export function onSettingChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
