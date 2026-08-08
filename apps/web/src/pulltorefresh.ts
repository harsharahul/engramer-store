import { useRef, useState } from "react";

/** How far a finger pulls past the top before release means "refresh". */
export const PULL_THRESHOLD = 70;

/**
 * Pull-to-refresh on a scroll container. Sync here is client-driven pull,
 * so the gesture is honest: it runs the same refresh the app performs at
 * session start. The native rubber-band supplies the stretch; this hook
 * only decides when a release becomes a refresh and reports state for an
 * indicator.
 */
export function usePullToRefresh(refresh: () => Promise<unknown>): {
  containerProps: {
    onTouchStart: (event: React.TouchEvent<HTMLElement>) => void;
    onTouchMove: (event: React.TouchEvent<HTMLElement>) => void;
    onTouchEnd: () => void;
    onTouchCancel: () => void;
  };
  pulling: boolean;
  refreshing: boolean;
} {
  const start = useRef<number | null>(null);
  const pulled = useRef(0);
  const [pulling, setPulling] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const reset = () => {
    start.current = null;
    pulled.current = 0;
    setPulling(false);
  };

  return {
    containerProps: {
      onTouchStart: (event) => {
        const touch = event.touches[0];
        if (event.touches.length !== 1 || !touch || refreshing) {
          return;
        }
        if (event.currentTarget.scrollTop > 0) {
          return;
        }
        start.current = touch.clientY;
        pulled.current = 0;
      },
      onTouchMove: (event) => {
        const touch = event.touches[0];
        if (start.current === null || !touch) {
          return;
        }
        // A scroll that has since left the top is scrolling, not pulling.
        if (event.currentTarget.scrollTop > 0) {
          reset();
          return;
        }
        pulled.current = touch.clientY - start.current;
        setPulling(pulled.current > PULL_THRESHOLD);
      },
      onTouchEnd: () => {
        const shouldRefresh = start.current !== null && pulled.current > PULL_THRESHOLD;
        reset();
        if (shouldRefresh) {
          setRefreshing(true);
          void refresh()
            .catch(() => {})
            .finally(() => setRefreshing(false));
        }
      },
      onTouchCancel: reset,
    },
    pulling,
    refreshing,
  };
}
