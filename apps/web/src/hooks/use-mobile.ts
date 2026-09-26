import { MOBILE_QUERY, useMediaQuery } from "@/media"

/**
 * shadcn's hook, pointed at the app's own phone breakpoint so the sidebar
 * and the rest of the layout change form factor on the same pixel.
 */
export function useIsMobile() {
  return useMediaQuery(MOBILE_QUERY)
}
