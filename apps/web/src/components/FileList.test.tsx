// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { FileEntry } from "../store";
import { FileList, sortFolders, type FolderRowData } from "./FileList";

/**
 * The grid/list switch is one choice about the whole place. Folders used to
 * stay as a strip of cards above the list, so switching to list changed the
 * files and left the folders looking like the grid. In list layout they are
 * rows too, on top, the way Finder and Drive keep folders first.
 */

const file = {
  id: "f1",
  folderId: "root",
  name: "lease.pdf",
  mime: "application/pdf",
  size: 1024,
  mtime: 1_700_000_000_000,
} as unknown as FileEntry;

const folders: FolderRowData[] = [
  { id: "d1", name: "Documents", count: 10 },
  { id: "d2", name: "Camera Roll", count: 1 },
];

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.matchMedia = (() => ({ matches: false })) as unknown as typeof window.matchMedia;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(onOpenFolder = vi.fn()) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root.render(
      <FileList
        files={[file]}
        folders={folders}
        selection={new Set()}
        sort={{ key: "name", dir: 1 }}
        onSort={vi.fn()}
        onSelect={vi.fn()}
        onOpen={vi.fn()}
        onMenu={vi.fn()}
        onOpenFolder={onOpenFolder}
        onFolderMenu={vi.fn()}
      />,
    ),
  );
  return onOpenFolder;
}

describe("list layout", () => {
  it("shows folders as rows above the files", () => {
    render();
    const rows = [...container.querySelectorAll(".row:not(.list-head)")];
    expect(rows.map((r) => r.querySelector(".name")?.textContent)).toEqual(["Documents", "Camera Roll", "lease.pdf"]);
    expect(rows[0]!.classList.contains("folder-row")).toBe(true);
    expect(rows[0]!.textContent).toContain("10 items");
    expect(container.querySelector(".folders-strip")).toBeNull();
  });

  it("opens a folder row on click and on Enter, like the folder card", () => {
    const onOpenFolder = render();
    const row = container.querySelector(".folder-row") as HTMLElement;
    act(() => row.click());
    act(() => row.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(onOpenFolder).toHaveBeenCalledTimes(2);
    expect(onOpenFolder).toHaveBeenCalledWith("d1");
  });
});

describe("sortFolders", () => {
  const list: FolderRowData[] = [
    { id: "a", name: "beta", count: 1 },
    { id: "b", name: "Alpha", count: 5 },
    { id: "c", name: "gamma", count: 3 },
  ];

  it("follows the name direction", () => {
    expect(sortFolders(list, { key: "name", dir: 1 }).map((f) => f.name)).toEqual(["Alpha", "beta", "gamma"]);
    expect(sortFolders(list, { key: "name", dir: -1 }).map((f) => f.name)).toEqual(["gamma", "beta", "Alpha"]);
  });

  it("orders by item count when sorting by size", () => {
    expect(sortFolders(list, { key: "size", dir: -1 }).map((f) => f.id)).toEqual(["b", "c", "a"]);
  });

  it("keeps folders by name when sorting by date, which folders do not carry", () => {
    expect(sortFolders(list, { key: "mtime", dir: -1 }).map((f) => f.name)).toEqual(["Alpha", "beta", "gamma"]);
  });
});
