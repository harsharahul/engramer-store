import { useMemo, useState } from "react";
import { useStore, type BulkResult } from "../store";
import { FolderGlyph } from "./Icon";
import { Button } from "./ui/button";

/** Pick a destination folder for one or more files. */
export function MoveDialog(props: {
  fileIds: string[];
  onMoved: (result: BulkResult, destination: string | null) => void;
  onClose: () => void;
}) {
  const folders = useStore((s) => s.folders);
  const files = useStore((s) => s.files);
  const moveFiles = useStore((s) => s.moveFiles);
  const [moving, setMoving] = useState(false);

  const tree = useMemo(() => {
    const list: Array<{ id: string | null; name: string; depth: number }> = [
      { id: null, name: "All files", depth: 0 },
    ];
    const walk = (parentId: string | null, depth: number) => {
      [...folders.values()]
        .filter((f) => f.parentId === parentId)
        .sort((a, b) => a.name.localeCompare(b.name))
        .forEach((folder) => {
          list.push({ id: folder.id, name: folder.name, depth });
          walk(folder.id, depth + 1);
        });
    };
    walk(null, 1);
    return list;
  }, [folders]);

  const currentFolders = new Set(props.fileIds.map((id) => files.get(id)?.folderId ?? null));

  const move = async (destination: string | null) => {
    if (moving) {
      return;
    }
    setMoving(true);
    try {
      const result = await moveFiles(props.fileIds, destination);
      props.onMoved(result, destination);
    } finally {
      setMoving(false);
    }
    props.onClose();
  };

  return (
    <div className="overlay" onClick={props.onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>
          Move {props.fileIds.length} item{props.fileIds.length === 1 ? "" : "s"}
        </h2>
        <p className="modal-sub">Choose a destination. Encrypted names never leave this device.</p>
        <div className="move-tree">
          {tree.map((node) => (
            <button
              key={node.id ?? "root"}
              className="move-node"
              style={{ paddingLeft: 12 + node.depth * 18 }}
              disabled={moving || (currentFolders.size === 1 && currentFolders.has(node.id))}
              onClick={() => void move(node.id)}
            >
              <FolderGlyph size={14} /> {node.name}
            </button>
          ))}
        </div>
        <div className="modal-actions">
          <Button variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}
