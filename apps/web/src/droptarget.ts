import { useEffect, useRef, useState } from "react";

/** The drag type the app's own file drags carry; OS file drops never do. */
export const FILE_DRAG_TYPE = "application/x-engramer-files";

/** Hovering a folder with a drag this long opens it, Finder's spring. */
export const SPRING_LOAD_MS = 800;

/**
 * One drop target for the app's own file drags: folder cards, breadcrumbs,
 * the sidebar root. Highlights while a drag hovers, hands the drop to the
 * caller, and, where asked, springs the folder open when the drag lingers,
 * so a drag can travel down into subfolders without letting go.
 *
 * OS file drops (uploads) are not this hook's business: they carry no
 * FILE_DRAG_TYPE and fall through to the frame's own handler.
 */
export function useDropTarget(
  onDrop: (event: React.DragEvent) => void,
  options: { springLoad?: () => void } = {},
) {
  const [dropping, setDropping] = useState(false);
  const spring = useRef<number | null>(null);
  const latest = useRef({ onDrop, springLoad: options.springLoad });
  latest.current = { onDrop, springLoad: options.springLoad };

  const cancelSpring = () => {
    if (spring.current !== null) {
      window.clearTimeout(spring.current);
      spring.current = null;
    }
  };

  useEffect(() => cancelSpring, []);

  const carries = (event: React.DragEvent) => event.dataTransfer.types.includes(FILE_DRAG_TYPE);

  return {
    dropping,
    props: {
      onDragEnter: (event: React.DragEvent) => {
        if (!carries(event)) {
          return;
        }
        event.preventDefault();
        if (latest.current.springLoad && spring.current === null) {
          spring.current = window.setTimeout(() => {
            spring.current = null;
            setDropping(false);
            latest.current.springLoad?.();
          }, SPRING_LOAD_MS);
        }
      },
      onDragOver: (event: React.DragEvent) => {
        if (!carries(event)) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = "move";
        setDropping(true);
      },
      onDragLeave: (event: React.DragEvent) => {
        // Leaving for a child element is not leaving the target.
        const next = event.relatedTarget as Node | null;
        if (next && event.currentTarget.contains(next)) {
          return;
        }
        cancelSpring();
        setDropping(false);
      },
      onDrop: (event: React.DragEvent) => {
        if (!carries(event)) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        cancelSpring();
        setDropping(false);
        latest.current.onDrop(event);
      },
    },
  };
}
