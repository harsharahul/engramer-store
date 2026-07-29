import { useEffect, useRef } from "react";
import { MOBILE_QUERY, useMediaQuery } from "../media";

export interface MenuItem {
  id: string;
  label: string;
  icon?: React.ReactNode;
  danger?: boolean;
  divider?: boolean;
  run: () => void;
}

/**
 * Right-click menu. Closes on click-away, Escape, scroll, or item run.
 * On phone-width viewports it renders as a bottom action sheet instead of an
 * anchored menu; x/y are ignored there and a backdrop dims the page.
 */
export function ContextMenu(props: {
  x: number;
  y: number;
  items: MenuItem[];
  title?: string;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const sheet = useMediaQuery(MOBILE_QUERY);

  useEffect(() => {
    const away = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) {
        props.onClose();
      }
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        props.onClose();
      }
    };
    window.addEventListener("mousedown", away);
    window.addEventListener("keydown", key);
    // A sheet animating in (or a finger scrolling its list) must not
    // self-dismiss, so the scroll-away close stays anchored-menu only.
    if (!sheet) {
      window.addEventListener("scroll", props.onClose, true);
    }
    return () => {
      window.removeEventListener("mousedown", away);
      window.removeEventListener("keydown", key);
      if (!sheet) {
        window.removeEventListener("scroll", props.onClose, true);
      }
    };
  }, [props, sheet]);

  // Keep the anchored menu inside the viewport.
  const width = 208;
  const itemHeight = 34;
  const height = props.items.length * itemHeight + 12;
  const x = Math.min(props.x, window.innerWidth - width - 8);
  const y = Math.min(props.y, window.innerHeight - height - 8);

  const menu = (
    <div
      ref={ref}
      className={`ctx-menu${sheet ? " sheet" : ""}`}
      style={sheet ? undefined : { left: x, top: y, width }}
      role="menu"
    >
      {sheet && <div className="sheet-grip" aria-hidden="true" />}
      {sheet && props.title && <div className="sheet-title">{props.title}</div>}
      {props.items.map((item) =>
        item.divider ? (
          <div key={item.id} className="ctx-divider" />
        ) : (
          <button
            key={item.id}
            role="menuitem"
            className={`ctx-item${item.danger ? " danger" : ""}`}
            onClick={() => {
              props.onClose();
              item.run();
            }}
          >
            {item.icon}
            {item.label}
          </button>
        ),
      )}
    </div>
  );

  if (!sheet) {
    return menu;
  }
  return (
    <>
      <div className="sheet-backdrop" onClick={props.onClose} />
      {menu}
    </>
  );
}
