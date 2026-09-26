/**
 * What a folder's dot says: "busy" while anything in the folder or below
 * it is uploading or being processed, "failed" when an upload or a
 * processing pass there failed, and nothing when it is settled. A failure
 * outranks work in hand, so a pulse never hides something that needs a
 * look.
 */

export type FolderActivity = "busy" | "failed";

type UploadPhase = "encrypting" | "uploading" | "finalizing" | "done" | "error";

export interface ActivityInputs {
  folders: ReadonlyMap<string, { parentId: string | null }>;
  files: ReadonlyMap<string, { folderId: string | null; trashed?: boolean }>;
  /** Uploads in the tray; the folder is known once the destination is. */
  uploads: readonly { status: UploadPhase; folderId?: string | null }[];
  /** Files being processed right now. */
  working: ReadonlySet<string>;
  /** Files whose last processing pass failed. */
  failed: ReadonlySet<string>;
}

export function folderActivity(inputs: ActivityInputs): Map<string, FolderActivity> {
  const state = new Map<string, FolderActivity>();
  const mark = (folderId: string | null | undefined, activity: FolderActivity) => {
    const seen = new Set<string>();
    for (let id = folderId; id && !seen.has(id); id = inputs.folders.get(id)?.parentId) {
      seen.add(id);
      if (state.get(id) !== "failed") {
        state.set(id, activity);
      }
    }
  };
  const folderOf = (fileId: string) => {
    const file = inputs.files.get(fileId);
    return file && !file.trashed ? file.folderId : null;
  };

  for (const upload of inputs.uploads) {
    if (upload.status === "error") {
      mark(upload.folderId, "failed");
    } else if (upload.status !== "done") {
      mark(upload.folderId, "busy");
    }
  }
  for (const id of inputs.working) {
    mark(folderOf(id), "busy");
  }
  for (const id of inputs.failed) {
    mark(folderOf(id), "failed");
  }
  return state;
}

/** The dot's meaning in words, for assistive tech beside the folder's name. */
export function folderActivityLabel(activity: FolderActivity): string {
  return activity === "busy" ? "working" : "something here failed";
}
