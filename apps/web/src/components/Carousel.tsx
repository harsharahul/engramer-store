/**
 * The hero's cards: a column on the Mac, a row that swipes card by card on
 * the phone, with a dot for each card that is actually there. A card that
 * has nothing to say renders nothing, so the dots count what is on screen,
 * not what was asked for.
 */

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function Carousel(props: { label: string; children: ReactNode }) {
  const strip = useRef<HTMLDivElement>(null);
  const [count, setCount] = useState(0);
  const [active, setActive] = useState(0);

  useLayoutEffect(() => {
    const el = strip.current;
    if (!el) {
      return;
    }
    const recount = () => setCount(el.children.length);
    recount();
    const watch = typeof MutationObserver === "undefined" ? null : new MutationObserver(recount);
    watch?.observe(el, { childList: true });
    return () => watch?.disconnect();
  }, []);

  const cardAt = (index: number) => strip.current?.children[index] as HTMLElement | undefined;

  const onScroll = () => {
    const el = strip.current;
    const first = cardAt(0);
    const second = cardAt(1);
    if (!el || !first) {
      return;
    }
    const step = second ? second.offsetLeft - first.offsetLeft : first.offsetWidth;
    setActive(step > 0 ? Math.round(el.scrollLeft / step) : 0);
  };

  const go = (index: number) => {
    const el = strip.current;
    const card = cardAt(index);
    if (!el || !card) {
      return;
    }
    // Centred, as the cards snap.
    el.scrollTo({ left: card.offsetLeft - (el.clientWidth - card.offsetWidth) / 2, behavior: prefersReducedMotion() ? "auto" : "smooth" });
    setActive(index);
  };

  return (
    <>
      <div ref={strip} className="tln-cards" role="region" aria-label={props.label} onScroll={onScroll}>
        {props.children}
      </div>
      {/* The dots show on a phone only; above it the cards are a column. */}
      {count > 1 && (
        <div className="tln-dots">
          {Array.from({ length: count }, (_, index) => (
            <button
              key={index}
              type="button"
              className={`tln-cdot${index === active ? " tln-on" : ""}`}
              aria-label={`Card ${index + 1} of ${count}`}
              {...(index === active ? { "aria-current": "true" as const } : {})}
              onClick={() => go(index)}
            />
          ))}
        </div>
      )}
    </>
  );
}
