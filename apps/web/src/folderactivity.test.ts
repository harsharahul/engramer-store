import { describe, expect, it } from "vitest";
import { folderActivity, folderActivityLabel, type ActivityInputs } from "./folderactivity";

/**
 * A folder's dot says what is happening inside it: busy while anything in
 * it or below it is uploading or being processed, failed when an upload or
 * a processing pass there failed, and nothing when it is settled.
 */
describe("folder activity", () => {
  // Photos > Trips > Alps, and a separate Documents folder.
  const folders = new Map([
    ["photos", { parentId: null }],
    ["trips", { parentId: "photos" }],
    ["alps", { parentId: "trips" }],
    ["docs", { parentId: null }],
  ]);
  const files = new Map([
    ["f-alps", { folderId: "alps" }],
    ["f-docs", { folderId: "docs" }],
    ["f-root", { folderId: null }],
    ["f-gone", { folderId: "docs", trashed: true }],
  ]);
  const settled: ActivityInputs = { folders, files, uploads: [], working: new Set(), failed: new Set() };

  it("marks nothing when no work is in hand", () => {
    expect(folderActivity(settled).size).toBe(0);
  });

  it("marks a folder and every folder above it busy while an upload lands in it", () => {
    const state = folderActivity({ ...settled, uploads: [{ status: "uploading", folderId: "alps" }] });
    expect(state.get("alps")).toBe("busy");
    expect(state.get("trips")).toBe("busy");
    expect(state.get("photos")).toBe("busy");
    expect(state.has("docs")).toBe(false);
  });

  it("counts every in-flight upload phase as busy and finished uploads as nothing", () => {
    for (const status of ["encrypting", "uploading", "finalizing"] as const) {
      expect(folderActivity({ ...settled, uploads: [{ status, folderId: "docs" }] }).get("docs")).toBe("busy");
    }
    expect(folderActivity({ ...settled, uploads: [{ status: "done", folderId: "docs" }] }).size).toBe(0);
  });

  it("ignores an upload whose destination is not known yet", () => {
    expect(folderActivity({ ...settled, uploads: [{ status: "encrypting" }] }).size).toBe(0);
  });

  it("marks the folder of a file being processed busy", () => {
    const state = folderActivity({ ...settled, working: new Set(["f-alps"]) });
    expect(state.get("alps")).toBe("busy");
    expect(state.get("photos")).toBe("busy");
  });

  it("marks a failed upload or a failed processing pass as failed, up the tree", () => {
    const upload = folderActivity({ ...settled, uploads: [{ status: "error", folderId: "trips" }] });
    expect(upload.get("trips")).toBe("failed");
    expect(upload.get("photos")).toBe("failed");
    expect(upload.has("alps")).toBe(false);
    const processing = folderActivity({ ...settled, failed: new Set(["f-docs"]) });
    expect(processing.get("docs")).toBe("failed");
  });

  it("lets a failure outrank work still in hand, so it is not hidden by a pulse", () => {
    const state = folderActivity({
      ...settled,
      uploads: [{ status: "uploading", folderId: "alps" }],
      failed: new Set(["f-alps"]),
    });
    expect(state.get("alps")).toBe("failed");
    expect(state.get("photos")).toBe("failed");
  });

  it("skips trashed files and files at the root, which have no folder to mark", () => {
    const state = folderActivity({ ...settled, working: new Set(["f-root"]), failed: new Set(["f-gone"]) });
    expect(state.size).toBe(0);
  });

  it("stops at a parent cycle instead of looping", () => {
    const looped = new Map([
      ["a", { parentId: "b" }],
      ["b", { parentId: "a" }],
    ]);
    const state = folderActivity({ ...settled, folders: looped, uploads: [{ status: "uploading", folderId: "a" }] });
    expect(state.get("a")).toBe("busy");
    expect(state.get("b")).toBe("busy");
  });

  it("says what the dot means, in words", () => {
    expect(folderActivityLabel("busy")).toBe("working");
    expect(folderActivityLabel("failed")).toBe("something here failed");
  });
});
