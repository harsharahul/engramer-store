import { create } from "zustand";
import {
  decryptBytes,
  decryptFileMetadata,
  decryptFolderMetadata,
  encryptBytes,
  encryptFileMetadata,
  encryptFolderMetadata,
  encryptJson,
  generateKey,
  openSealed,
  secretBoxOpen,
  secretBoxSeal,
  utf8Encode,
  type FileMetadata,
} from "@engramer/crypto";
import { api, uploadBlob, withRetry, type FileDto, type FolderDto } from "./api";
import { boundedRun, folderPlan, pathKey, type TreeFile } from "./uploader";
import { clearSession, type Session } from "./session";
import { analyzeFile, downloadAndDecrypt, encryptAndUpload } from "./transfer";
import { recognizeImage } from "./intel/ocr";
import { mergeRestoredMeta } from "./versions";

export interface FolderEntry {
  id: string;
  parentId: string | null;
  name: string;
  key: Uint8Array;
  createdAt: number;
  updatedAt: number;
}

export interface FileEntry {
  id: string;
  folderId: string | null;
  name: string;
  mime: string;
  size: number;
  mtime: number;
  width?: number;
  height?: number;
  blur?: string;
  /** In-memory search text (lazily fetched from the index blob). */
  text?: string;
  /** An encrypted search-text blob exists for this file. */
  hasText: boolean;
  /** Legacy row still carrying text inside its metadata. */
  inlineText: boolean;
  category?: string;
  tags: string[];
  favorite: boolean;
  key: Uint8Array;
  hasThumb: boolean;
  trashed: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface UploadItem {
  id: string;
  name: string;
  progress: number;
  status: "encrypting" | "uploading" | "done" | "error";
  error?: string;
}

export interface Usage {
  usedBytes: number;
  quotaBytes: number;
}

export interface RevealItem {
  fileId: string;
  name: string;
  category: string;
  folderId: string | null;
  folderName: string | null;
  tags: string[];
}

export interface Reveal {
  items: RevealItem[];
  at: number;
}

export interface OcrProgress {
  done: number;
  total: number;
  current: string;
}

/** Aggregate progress for a large transfer; per-file rows would drown the UI. */
export interface BatchProgress {
  done: number;
  failed: number;
  total: number;
  current: string;
}

interface StoreState {
  session: Session | null;
  synced: boolean;
  /** Set when the last sync attempt failed; the UI offers a retry. */
  syncError: string | null;
  folders: Map<string, FolderEntry>;
  files: Map<string, FileEntry>;
  usage: Usage | null;
  uploads: UploadItem[];
  reveal: Reveal | null;
  ocrProgress: OcrProgress | null;
  batch: BatchProgress | null;
  /** Search-index warm-up progress; null when idle or complete. */
  indexWarm: { done: number; total: number } | null;

  startSession: (session: Session) => Promise<void>;
  logout: () => void;
  refresh: () => Promise<void>;
  refreshUsage: () => Promise<void>;
  createFolder: (name: string, parentId: string | null) => Promise<void>;
  renameFolder: (id: string, name: string) => Promise<void>;
  deleteFolder: (id: string) => Promise<void>;
  uploadFiles: (files: File[], folderId: string | null) => Promise<void>;
  uploadTree: (items: TreeFile[], baseFolderId: string | null) => Promise<void>;
  saveFileContent: (id: string, text: string) => Promise<void>;
  saveFileBinary: (id: string, bytes: Uint8Array, searchText?: string) => Promise<void>;
  createNote: (name: string, folderId: string | null) => Promise<string>;
  renameFile: (id: string, name: string) => Promise<void>;
  setTags: (id: string, tags: string[]) => Promise<void>;
  toggleFavorite: (id: string) => Promise<void>;
  moveFile: (id: string, folderId: string | null) => Promise<void>;
  trashFile: (id: string) => Promise<void>;
  restoreFile: (id: string) => Promise<void>;
  deleteForever: (id: string) => Promise<void>;
  clearFinishedUploads: () => void;
  dismissReveal: () => void;
  createFileRequest: (label: string, folderId: string | null, expiresAt: number | null) => Promise<string>;
  ingestRequestUploads: () => Promise<number>;
  recognizeFile: (id: string) => Promise<boolean>;
  recognizeAllImages: () => Promise<number>;
  restoreVersion: (id: string, generation: number) => Promise<void>;
  warmSearchIndex: () => Promise<void>;
}

function decryptFolder(dto: FolderDto, masterKey: Uint8Array): FolderEntry {
  const key = secretBoxOpen(dto.encryptedKey, masterKey);
  const meta = decryptFolderMetadata(dto.encryptedMeta, key);
  return {
    id: dto.id,
    parentId: dto.parentId,
    name: meta.name,
    key,
    createdAt: dto.createdAt,
    updatedAt: dto.updatedAt,
  };
}

function decryptFile(dto: FileDto, masterKey: Uint8Array): FileEntry {
  const key = secretBoxOpen(dto.encryptedKey, masterKey);
  const meta = decryptFileMetadata(dto.encryptedMeta, key);
  return {
    id: dto.id,
    folderId: dto.folderId,
    name: meta.name,
    mime: meta.mime,
    size: meta.size,
    mtime: meta.mtime,
    width: meta.width,
    height: meta.height,
    blur: meta.blur,
    text: meta.text,
    hasText: meta.hasText === true || meta.text !== undefined,
    inlineText: meta.text !== undefined,
    category: meta.category,
    tags: meta.tags ?? [],
    favorite: meta.favorite ?? false,
    key,
    hasThumb: dto.thumbSize > 0,
    trashed: dto.trashed,
    createdAt: dto.createdAt,
    updatedAt: dto.updatedAt,
  };
}

function metadataOf(file: FileEntry): FileMetadata {
  return {
    name: file.name,
    mime: file.mime,
    size: file.size,
    mtime: file.mtime,
    width: file.width,
    height: file.height,
    blur: file.blur,
    // Legacy rows keep their inline text until migrated; split rows carry
    // only the marker, with text living in the index blob.
    ...(file.inlineText ? { text: file.text } : file.hasText ? { hasText: true } : {}),
    category: file.category,
    tags: file.tags,
    favorite: file.favorite,
  };
}

export const useStore = create<StoreState>((set, get) => {
  const masterKey = () => {
    const session = get().session;
    if (!session) {
      throw new Error("not signed in");
    }
    return session.masterKey;
  };

  const applyFolder = (dto: FolderDto) => {
    const folders = new Map(get().folders);
    if (dto.deleted) {
      folders.delete(dto.id);
    } else {
      folders.set(dto.id, decryptFolder(dto, masterKey()));
    }
    set({ folders });
  };

  const applyFile = (dto: FileDto) => {
    const files = new Map(get().files);
    if (dto.deleted) {
      files.delete(dto.id);
    } else {
      const entry = decryptFile(dto, masterKey());
      // Keep already-warmed search text across metadata updates.
      const prior = files.get(dto.id);
      if (entry.text === undefined && entry.hasText && prior?.text !== undefined) {
        entry.text = prior.text;
      }
      files.set(dto.id, entry);
    }
    set({ files });
  };


  /** Replaces one entry's in-memory search text. */
  const setEntryText = (id: string, text: string | undefined, inlineText?: boolean) => {
    const files = new Map(get().files);
    const entry = files.get(id);
    if (entry) {
      files.set(id, {
        ...entry,
        text,
        hasText: text !== undefined || entry.hasText,
        inlineText: inlineText ?? entry.inlineText,
      });
      set({ files });
    }
  };

  const patchFileMeta = async (id: string, patch: Partial<FileMetadata>) => {
    const file = get().files.get(id);
    if (!file) {
      return;
    }
    const dto = await api.patchFile(id, {
      encryptedMeta: encryptFileMetadata({ ...metadataOf(file), ...patch }, file.key),
    });
    applyFile(dto);
  };

  /** Find or create a root folder for a category. Deduplicates concurrent creates. */
  const categoryFolderPromises = new Map<string, Promise<string>>();
  const ensureCategoryFolder = (name: string): Promise<string> => {
    for (const folder of get().folders.values()) {
      if (folder.parentId === null && folder.name === name) {
        return Promise.resolve(folder.id);
      }
    }
    let pending = categoryFolderPromises.get(name);
    if (!pending) {
      pending = (async () => {
        const folderKey = generateKey();
        const dto = await api.createFolder(
          null,
          secretBoxSeal(folderKey, masterKey()),
          encryptFolderMetadata({ name }, folderKey),
        );
        applyFolder(dto);
        categoryFolderPromises.delete(name);
        return dto.id;
      })();
      categoryFolderPromises.set(name, pending);
    }
    return pending;
  };

  return {
    session: null,
    synced: false,
    syncError: null,
    folders: new Map(),
    files: new Map(),
    usage: null,
    uploads: [],
    reveal: null,
    ocrProgress: null,
    batch: null,
    indexWarm: null,

    // A failed first sync must never strand the user on a spinner: the
    // session (and its keys) are kept, the error is surfaced, and the UI
    // offers a retry.
    startSession: async (session) => {
      set({
        session,
        synced: false,
        syncError: null,
        folders: new Map(),
        files: new Map(),
        uploads: [],
        reveal: null,
      });
      try {
        await get().refresh();
        await get().refreshUsage();
      } catch {
        // refresh() already recorded syncError; nothing else to do here.
      }
    },

    logout: () => {
      clearSession();
      set({
        session: null,
        synced: false,
        folders: new Map(),
        files: new Map(),
        usage: null,
        uploads: [],
        reveal: null,
      });
    },

    refresh: async () => {
      const key = masterKey();
      let response;
      try {
        response = await api.sync(0);
      } catch (err) {
        set({ syncError: err instanceof Error ? err.message : "could not reach the server" });
        throw err;
      }
      const folders = new Map<string, FolderEntry>();
      const files = new Map<string, FileEntry>();
      let undecryptable = 0;
      // One corrupt row must never take the whole library down with it.
      for (const dto of response.folders) {
        if (!dto.deleted) {
          try {
            folders.set(dto.id, decryptFolder(dto, key));
          } catch {
            undecryptable++;
          }
        }
      }
      for (const dto of response.files) {
        if (!dto.deleted && dto.uploaded) {
          try {
            files.set(dto.id, decryptFile(dto, key));
          } catch {
            undecryptable++;
          }
        }
      }
      if (undecryptable > 0) {
        console.warn(`${undecryptable} item(s) could not be decrypted and were skipped`);
      }
      set({ folders, files, synced: true, syncError: null });
      // Anything that arrived through a file request gets filed automatically.
      await get().ingestRequestUploads().catch(() => 0);
    },

    refreshUsage: async () => {
      const user = await api.user();
      set({ usage: { usedBytes: user.usedBytes, quotaBytes: user.quotaBytes } });
    },

    createFolder: async (name, parentId) => {
      const folderKey = generateKey();
      const dto = await api.createFolder(
        parentId,
        secretBoxSeal(folderKey, masterKey()),
        encryptFolderMetadata({ name }, folderKey),
      );
      applyFolder(dto);
    },

    renameFolder: async (id, name) => {
      const folder = get().folders.get(id);
      if (!folder) {
        return;
      }
      const dto = await api.patchFolder(id, {
        encryptedMeta: encryptFolderMetadata({ name }, folder.key),
      });
      applyFolder(dto);
    },

    deleteFolder: async (id) => {
      await api.deleteFolder(id);
      await get().refresh();
    },

    uploadFiles: async (fileList, folderId) => {
      const key = masterKey();
      const revealItems: RevealItem[] = [];
      for (const file of fileList) {
        const uploadId = crypto.randomUUID();
        set({
          uploads: [
            ...get().uploads,
            { id: uploadId, name: file.name, progress: 0, status: "encrypting" },
          ],
        });
        const update = (patch: Partial<UploadItem>) =>
          set({
            uploads: get().uploads.map((u) => (u.id === uploadId ? { ...u, ...patch } : u)),
          });
        try {
          const prepared = await analyzeFile(file);
          // Root uploads are auto-filed into a category folder; uploads into a
          // folder the user picked stay where the user put them.
          const destination =
            folderId ?? (await ensureCategoryFolder(prepared.analysis.category));
          const result = await encryptAndUpload(file, destination, key, prepared, (fraction) =>
            update({ status: "uploading", progress: fraction }),
          );
          applyFile(result.dto);
          update({ status: "done", progress: 1 });
          revealItems.push({
            fileId: result.dto.id,
            name: file.name,
            category: prepared.analysis.category,
            folderId: destination,
            folderName: destination ? (get().folders.get(destination)?.name ?? null) : null,
            tags: prepared.analysis.tags,
          });
        } catch (err) {
          update({ status: "error", error: err instanceof Error ? err.message : "upload failed" });
        }
      }
      if (revealItems.length > 0) {
        set({ reveal: { items: revealItems, at: Date.now() } });
      }
      await get().refreshUsage();
    },

    /**
     * A whole tree at once: recreate the folder structure (deduplicated,
     * parents first), then push files through a bounded pool. Concurrency
     * defaults follow transfer-tool practice: modest parallelism beats
     * hammering, and throttled requests retry with backoff instead of dying.
     */
    uploadTree: async (items, baseFolderId) => {
      const key = masterKey();
      set({ batch: { done: 0, failed: 0, total: items.length, current: "" } });

      // Folder plan: create every needed path once, parents before children.
      const folderIds = new Map<string, string | null>();
      folderIds.set(pathKey([]), baseFolderId);
      for (const path of folderPlan(items)) {
        const parent = folderIds.get(pathKey(path.slice(0, -1))) ?? baseFolderId;
        const name = path[path.length - 1]!;
        // Reuse an existing subfolder of the same name at the same spot.
        const existing = [...get().folders.values()].find(
          (f) => f.parentId === (parent ?? null) && f.name === name,
        );
        if (existing) {
          folderIds.set(pathKey(path), existing.id);
          continue;
        }
        const folderKey = generateKey();
        const dto = await withRetry(() =>
          api.createFolder(parent, secretBoxSeal(folderKey, key), encryptFolderMetadata({ name }, folderKey)),
        );
        applyFolder(dto);
        folderIds.set(pathKey(path), dto.id);
      }

      const revealItems: RevealItem[] = [];
      await boundedRun(items, 4, async (item) => {
        const current = get().batch;
        set({ batch: current ? { ...current, current: item.file.name } : null });
        try {
          const prepared = await analyzeFile(item.file);
          const destination =
            item.path.length > 0
              ? (folderIds.get(pathKey(item.path)) ?? baseFolderId)
              : (baseFolderId ?? (await ensureCategoryFolder(prepared.analysis.category)));
          const result = await withRetry(() =>
            encryptAndUpload(item.file, destination, key, prepared, () => {}),
          );
          applyFile(result.dto);
          if (revealItems.length < 3) {
            revealItems.push({
              fileId: result.dto.id,
              name: item.file.name,
              category: prepared.analysis.category,
              folderId: destination,
              folderName: destination ? (get().folders.get(destination)?.name ?? null) : null,
              tags: prepared.analysis.tags,
            });
          }
          const after = get().batch;
          if (after) {
            set({ batch: { ...after, done: after.done + 1 } });
          }
        } catch {
          const after = get().batch;
          if (after) {
            set({ batch: { ...after, failed: after.failed + 1 } });
          }
        }
      });

      set({ batch: null });
      if (revealItems.length > 0) {
        set({ reveal: { items: revealItems, at: Date.now() } });
      }
      await get().refreshUsage();
    },

    // In-app editing: re-encrypt with the file's existing key and replace the
    // blob, then refresh the metadata (size, mtime, search text) in one patch.
    saveFileContent: async (id, text) => {
      const file = get().files.get(id);
      if (!file) {
        throw new Error("file not found");
      }
      const bytes = utf8Encode(text);
      await uploadBlob(id, "data", encryptBytes(bytes, file.key));
      const searchText = text.slice(0, 100_000);
      await uploadBlob(id, "index", encryptBytes(utf8Encode(searchText), file.key));
      await patchFileMeta(id, { size: bytes.length, mtime: Date.now(), hasText: true, text: undefined });
      setEntryText(id, searchText, false);
      await get().refreshUsage();
    },

    // Binary flavor of the same flow, for document formats where the editor
    // exports bytes (e.g. .docx). searchText, when the editor can provide it,
    // keeps the file findable through client-side search.
    saveFileBinary: async (id, bytes, searchText) => {
      const file = get().files.get(id);
      if (!file) {
        throw new Error("file not found");
      }
      await uploadBlob(id, "data", encryptBytes(bytes, file.key));
      if (searchText !== undefined) {
        await uploadBlob(id, "index", encryptBytes(utf8Encode(searchText.slice(0, 100_000)), file.key));
      }
      await patchFileMeta(id, {
        size: bytes.length,
        mtime: Date.now(),
        ...(searchText !== undefined ? { hasText: true, text: undefined } : {}),
      });
      if (searchText !== undefined) {
        setEntryText(id, searchText.slice(0, 100_000), false);
      }
      await get().refreshUsage();
    },

    createNote: async (name, folderId) => {
      const fileName = /\.(md|txt)$/i.test(name) ? name : `${name}.md`;
      const fileKey = generateKey();
      const meta: FileMetadata = {
        name: fileName,
        mime: "text/markdown",
        size: 0,
        mtime: Date.now(),
        category: "Notes",
        tags: ["notes", "md", String(new Date().getFullYear())],
      };
      const dto = await api.createFile(
        folderId,
        secretBoxSeal(fileKey, masterKey()),
        encryptFileMetadata(meta, fileKey),
      );
      await uploadBlob(dto.id, "data", encryptBytes(new Uint8Array(0), fileKey));
      applyFile({ ...dto, uploaded: true });
      return dto.id;
    },

    renameFile: async (id, name) => patchFileMeta(id, { name }),

    setTags: async (id, tags) =>
      patchFileMeta(id, { tags: [...new Set(tags.map((t) => t.trim().toLowerCase()).filter(Boolean))] }),

    toggleFavorite: async (id) => {
      const file = get().files.get(id);
      if (!file) {
        return;
      }
      // Optimistic flip so the star answers instantly.
      const files = new Map(get().files);
      files.set(id, { ...file, favorite: !file.favorite });
      set({ files });
      try {
        await patchFileMeta(id, { favorite: !file.favorite });
      } catch {
        const rollback = new Map(get().files);
        rollback.set(id, file);
        set({ files: rollback });
      }
    },

    moveFile: async (id, folderId) => {
      const dto = await api.patchFile(id, { folderId });
      applyFile(dto);
    },

    trashFile: async (id) => {
      await api.trashFile(id);
      const files = new Map(get().files);
      const file = files.get(id);
      if (file) {
        files.set(id, { ...file, trashed: true });
        set({ files });
      }
    },

    restoreFile: async (id) => {
      await api.restoreFile(id);
      await get().refresh();
    },

    deleteForever: async (id) => {
      await api.deleteForever(id);
      const files = new Map(get().files);
      files.delete(id);
      set({ files });
      await get().refreshUsage();
    },

    clearFinishedUploads: () => {
      set({ uploads: get().uploads.filter((u) => u.status !== "done" && u.status !== "error") });
    },

    dismissReveal: () => set({ reveal: null }),

    createFileRequest: async (label, folderId, expiresAt) => {
      const { token } = await api.createFileRequest(
        folderId,
        encryptJson({ label }, masterKey()),
        expiresAt,
      );
      return token;
    },

    /**
     * Files every pending request upload into the vault: unseal the file key
     * with the account key pair, re-wrap it under the master key, accept. The
     * sender's device already computed metadata, thumbnail, and search text.
     */
    ingestRequestUploads: async () => {
      const session = get().session;
      if (!session) {
        return 0;
      }
      const { uploads } = await api.listRequestUploads();
      const revealItems: RevealItem[] = [];
      for (const upload of uploads) {
        try {
          const fileKey = openSealed(upload.sealedKey, session.publicKey, session.privateKey);
          const meta = decryptFileMetadata(upload.encryptedMeta, fileKey);
          const dto = await api.acceptRequestUpload(
            upload.id,
            secretBoxSeal(fileKey, session.masterKey),
            encryptFileMetadata(meta, fileKey),
          );
          applyFile(dto);
          revealItems.push({
            fileId: dto.id,
            name: meta.name,
            category: meta.category ?? "Other",
            folderId: dto.folderId,
            folderName: dto.folderId ? (get().folders.get(dto.folderId)?.name ?? null) : null,
            tags: meta.tags ?? [],
          });
        } catch {
          // Another tab may have filed it first, or the seal does not match;
          // either way this upload stays pending rather than blocking the rest.
        }
      }
      if (revealItems.length > 0) {
        set({ reveal: { items: revealItems, at: Date.now() } });
        await get().refreshUsage();
      }
      return revealItems.length;
    },

    /** Runs OCR over one already-stored image and files the text into its
     * encrypted metadata. Returns whether any text was found. */
    recognizeFile: async (id) => {
      const file = get().files.get(id);
      if (!file || !file.mime.startsWith("image/")) {
        return false;
      }
      const bytes = await downloadAndDecrypt(file.id, file.key);
      const text = await recognizeImage(
        new Blob([bytes.slice().buffer as ArrayBuffer], { type: file.mime }),
      );
      if (!text) {
        return false;
      }
      await uploadBlob(id, "index", encryptBytes(utf8Encode(text), file.key));
      await patchFileMeta(id, { hasText: true, text: undefined });
      setEntryText(id, text, false);
      return true;
    },

    /**
     * Makes the whole image library searchable: every image without text
     * goes through OCR, one at a time so the tab stays responsive.
     */
    recognizeAllImages: async () => {
      const candidates = [...get().files.values()].filter(
        (f) => !f.trashed && f.mime.startsWith("image/") && !f.hasText,
      );
      let found = 0;
      for (let i = 0; i < candidates.length; i++) {
        const file = candidates[i]!;
        set({ ocrProgress: { done: i, total: candidates.length, current: file.name } });
        try {
          if (await get().recognizeFile(file.id)) {
            found++;
          }
        } catch {
          // One unreadable image never stops the sweep.
        }
      }
      set({ ocrProgress: null });
      return found;
    },

    /**
     * Brings a previous version's content back. The server swaps ciphertext
     * pointers; this client merges metadata so the file keeps its current
     * name and tags while size, times, and search text match the restored
     * bytes. The displaced content becomes a version, so this is undoable.
     */
    restoreVersion: async (id, generation) => {
      const file = get().files.get(id);
      if (!file) {
        throw new Error("file not found");
      }
      const { versions } = await api.listVersions(id);
      const target = versions.find((v) => v.generation === generation);
      if (!target) {
        throw new Error("version not found");
      }
      const versionMeta = decryptFileMetadata(target.encryptedMeta, file.key);
      const merged = mergeRestoredMeta(metadataOf(file), versionMeta);
      const dto = await api.restoreVersion(id, generation, encryptFileMetadata(merged, file.key));
      applyFile(dto);
      await get().refreshUsage();
    },

    /**
     * Warms the client-side search index: fetches and decrypts the index
     * blob of every file that advertises one, a few at a time, and then
     * quietly migrates legacy rows (inline text) to the split format so old
     * libraries converge on small sync rows.
     */
    warmSearchIndex: async () => {
      if (get().indexWarm) {
        return;
      }
      const candidates = [...get().files.values()].filter(
        (f) => !f.trashed && f.hasText && !f.inlineText && f.text === undefined,
      );
      if (candidates.length > 0) {
        set({ indexWarm: { done: 0, total: candidates.length } });
        await boundedRun(candidates, 3, async (file) => {
          try {
            const bytes = await api.downloadBlob(file.id, "index");
            const text = new TextDecoder().decode(decryptBytes(bytes, file.key));
            setEntryText(file.id, text);
          } catch {
            // A missing index never blocks the rest; search simply skips it.
          }
          const warm = get().indexWarm;
          if (warm) {
            set({ indexWarm: { ...warm, done: warm.done + 1 } });
          }
        });
        set({ indexWarm: null });
      }

      // Legacy migration trickle, bounded per session.
      const legacy = [...get().files.values()]
        .filter((f) => !f.trashed && f.inlineText && f.text !== undefined)
        .slice(0, 150);
      await boundedRun(legacy, 2, async (file) => {
        try {
          await uploadBlob(file.id, "index", encryptBytes(utf8Encode(file.text!), file.key));
          const meta = { ...metadataOf({ ...file, inlineText: false }), hasText: true };
          const dto = await api.patchFile(file.id, {
            encryptedMeta: encryptFileMetadata(meta, file.key),
          });
          applyFile(dto);
          setEntryText(file.id, file.text, false);
        } catch {
          // Migration is best-effort; the legacy row keeps working as-is.
        }
      });
    },
  };
});
