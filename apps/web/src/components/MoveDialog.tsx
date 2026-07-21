import { useMemo } from "react";
import { useStore } from "../store";
import { FolderGlyph } from "./Icon";

/** Pick a destination folder for one or more files. */
export function MoveDialog(props: {
  fileIds: string[];
  onMoved: () => void;
  onClose: () => void;
}) {
  const folders = useStore((s) => s.folders);
  const files = useStore((s) => s.files);
  const moveFile = useStore((s) => s.moveFile);

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
    for (const id of props.fileIds) {
      await moveFile(id, destination);
    }
    props.onMoved();
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
              disabled={currentFolders.size === 1 && currentFolders.has(node.id)}
              onClick={() => void move(node.id)}
            >
              <FolderGlyph size={14} /> {node.name}
            </button>
          ))}
        </div>
        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={props.onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
