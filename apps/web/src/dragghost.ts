/**
 * The picture under the pointer while files are dragged: the dragged card's
 * own thumbnail, and a count badge when more than one item travels. The
 * browser's default ghost is the single node under the pointer, which says
 * nothing about a 500-item drag; this is the Finder's stack-and-badge.
 *
 * The ghost has to be in the document when setDragImage is called and may
 * leave as soon as the browser has taken its snapshot, which is why it is
 * appended and removed around the call.
 */
export function setFileDragImage(
  transfer: DataTransfer,
  source: { thumb: string | null; label: string; count: number },
): void {
  if (typeof transfer.setDragImage !== "function") {
    return;
  }
  const ghost = document.createElement("div");
  ghost.className = "drag-ghost";
  if (source.thumb) {
    const img = document.createElement("img");
    img.src = source.thumb;
    img.alt = "";
    ghost.appendChild(img);
  } else {
    const blank = document.createElement("span");
    blank.className = "drag-ghost-blank";
    blank.textContent = source.label.slice(0, 2).toUpperCase();
    ghost.appendChild(blank);
  }
  if (source.count > 1) {
    const badge = document.createElement("span");
    badge.className = "drag-ghost-count";
    badge.textContent = String(source.count);
    ghost.appendChild(badge);
  }
  document.body.appendChild(ghost);
  transfer.setDragImage(ghost, 28, 28);
  // The snapshot is taken synchronously; the node can go on the next tick.
  window.setTimeout(() => ghost.remove(), 0);
}
