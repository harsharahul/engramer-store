import { useEffect, useRef } from "react";

export interface MenuItem {
  id: string;
  label: string;
  icon?: React.ReactNode;
  danger?: boolean;
  divider?: boolean;
  run: () => void;
}

/** Right-click menu. Closes on click-away, Escape, scroll, or item run. */
export function ContextMenu(props: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);

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
    window.addEventListener("scroll", props.onClose, true);
    return () => {
      window.removeEventListener("mousedown", away);
      window.removeEventListener("keydown", key);
      window.removeEventListener("scroll", props.onClose, true);
    };
  }, [props]);

  // Keep the menu inside the viewport.
  const width = 208;
  const itemHeight = 34;
  const height = props.items.length * itemHeight + 12;
  const x = Math.min(props.x, window.innerWidth - width - 8);
  const y = Math.min(props.y, window.innerHeight - height - 8);

  return (
    <div ref={ref} className="ctx-menu" style={{ left: x, top: y, width }} role="menu">
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
}
