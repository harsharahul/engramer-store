/**
 * Coalesces a stream of values into at most one send per interval.
 *
 * The first value goes out immediately, so the far side reacts without
 * delay; values arriving inside the window replace one another and only
 * the latest is sent, on the trailing edge. Built for cursor positions,
 * which are last-write-wins: an intermediate position nobody saw was
 * never information, but every one of them was a websocket frame.
 */
export function trailingThrottle<T>(
  intervalMs: number,
  send: (value: T) => void,
): { push(value: T): void; flush(): void; cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: { value: T } | null = null;

  const fire = () => {
    timer = null;
    if (pending) {
      const { value } = pending;
      pending = null;
      timer = setTimeout(fire, intervalMs);
      send(value);
    }
  };

  return {
    push(value: T): void {
      if (timer) {
        pending = { value };
        return;
      }
      timer = setTimeout(fire, intervalMs);
      send(value);
    },
    flush(): void {
      if (timer) {
        clearTimeout(timer);
        fire();
      }
    },
    cancel(): void {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      pending = null;
    },
  };
}
