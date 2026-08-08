import { useEffect } from "react";

/**
 * The on-screen keyboard, as a CSS variable. WKWebView resizes the visual
 * viewport but not the layout viewport when the keyboard rises, so a
 * bottom-anchored sheet keeps sitting under the keys. This publishes the
 * overlap as `--kb-inset` on the root element; the stylesheet decides who
 * moves.
 */
export function useKeyboardInset(): void {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) {
      return;
    }
    const apply = () => {
      const inset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      document.documentElement.style.setProperty("--kb-inset", `${Math.round(inset)}px`);
    };
    apply();
    vv.addEventListener("resize", apply);
    vv.addEventListener("scroll", apply);
    return () => {
      vv.removeEventListener("resize", apply);
      vv.removeEventListener("scroll", apply);
      document.documentElement.style.removeProperty("--kb-inset");
    };
  }, []);
}
