import { useEffect, useState } from "react";

/** Phone-layout breakpoint. Keep in sync with the 760px media queries in styles.css. */
export const MOBILE_QUERY = "(max-width: 760px)";

/** Reactive matchMedia: re-renders when the query flips (rotation, window resize). */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);

  useEffect(() => {
    const list = window.matchMedia(query);
    const onChange = () => setMatches(list.matches);
    onChange();
    list.addEventListener("change", onChange);
    return () => list.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}
