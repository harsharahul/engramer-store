import { useCallback, useEffect, useState } from "react";
import { settingsEvents, SETTINGS_APPLIED_EVENT } from "./settingsync";

/**
 * A synced preference held as view state. It is read again when another
 * device's choice arrives through the synced settings, and when the caller
 * says it wrote one, so an open view never shows a stale choice.
 */
export function useSyncedSetting<T>(read: () => T): [T, () => void] {
  const [value, setValue] = useState(read);
  const refresh = useCallback(() => setValue(read()), [read]);
  useEffect(() => {
    settingsEvents.addEventListener(SETTINGS_APPLIED_EVENT, refresh);
    return () => settingsEvents.removeEventListener(SETTINGS_APPLIED_EVENT, refresh);
  }, [refresh]);
  return [value, refresh];
}
