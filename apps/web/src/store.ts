import { create } from "zustand";
import {
  chunkedEncrypt,
  contentDigest,
  decryptBytes,
  digestMatches,
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
import { ApiError, api, uploadBlob, withRetry, type FileDto, type FolderDto, type SharedFileDto } from "./api";
import { albumTag, isReservedTag } from "./albums";
import { openSharedFileKey, sealFileKeyFor } from "./collab";
import { SaveConflictError, copyName } from "./conflict";
import { uploadLanes, withAnalysisSlot } from "./analysisslot";
import { clearCache, loadCache, storeSyncRows } from "./cache";
import { boundedRun, folderPlan, pathKey, type TreeFile } from "./uploader";
import { clearSession, suspendSession, type Session } from "./session";
import { holdTransferLock, releaseTransferLock } from "./wakelock";
import { analyzeFile, downloadAndDecrypt, downloadThumbnail, encryptAndUpload } from "./transfer";
import { recognizeImage, recognizePdf } from "./intel/ocr";
import { isPdf } from "./intel/extract";
import { embedImage } from "./intel/semantic";
import { asFacts, mergeFacts, reconcileFacts, type Fact, type FactEvidence } from "./intel/facts";
import { factsEnabled, scanForFacts } from "./intel/scan";
import { EXACT_SOURCES, tripTag, type TripSuggestion } from "./intel/trips";
import { decodeIndexPayload, encodeIndexPayload } from "./indexblob";
import { mergeRestoredMeta } from "./versions";
import { blankDocument, DOCX_MIME, XLSX_MIME } from "./office/templates";

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
  /** In-memory semantic embedding (lazily fetched from the index blob). */
  clip?: Float32Array;
  /** All meaning vectors when a video sampled several frames. */
  clips?: Float32Array[];
  /** The index blob carries a semantic embedding for this file. */
  hasClip: boolean;
  /** Legacy row still carrying text inside its metadata. */
  inlineText: boolean;
  category?: string;
  tags: string[];
  /** Facts read out of the contents, summarized. Evidence is in the index blob. */
  facts: Fact[];
  favorite: boolean;
  /** Digest of the contents, recorded on the device that uploaded them. */
  digest?: string;
  /** The photo-library asset this file was backed up from, if any. */
  sourceId?: string;
  /** Set once a read has found the contents disagreeing with that digest. */
  corrupt?: boolean;
  /** Set once a read in this session has matched it. Not remembered across
   * reloads: it describes a check that happened, not a property of the file. */
  verified?: boolean;
  key: Uint8Array;
  hasThumb: boolean;
  trashed: boolean;
  createdAt: number;
  updatedAt: number;
  /** Shared into this vault by another account. */
  shared?: boolean;
  /** This account's rights on a shared file. */
  role?: "viewer" | "editor";
  /** Who shared it; shown wherever the file appears. */
  ownerEmail?: string;
  /** The key generation this entry's key belongs to (rotation counter). */
  keyEpoch?: number;
  /** Which content generation is current; snapshot bookkeeping reads it. */
  generation?: number;
}

/** A claimed invitation whose key the owner has not released yet. */
export interface PendingClaim {
  token: string;
  fileId: string;
  fileName: string;
  claimantEmail: string;
  role: "viewer" | "editor";
}

export interface UploadItem {
  id: string;
  name: string;
  progress: number;
  status: "encrypting" | "uploading" | "finalizing" | "done" | "error";
  /** What the preparing phase is actually doing (analyzing, reading
   * scanned pages, indexing by meaning); shown in place of "encrypting". */
  detail?: string;
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
  isAdmin: boolean;
  uploads: UploadItem[];
  /** Cancels every transfer in flight; a fresh batch gets a fresh scope. */
  uploadAbort: AbortController | null;
  reveal: Reveal | null;
  ocrProgress: OcrProgress | null;
  semanticProgress: OcrProgress | null;
  batch: BatchProgress | null;
  /** Search-index warm-up progress; null when idle or complete. */
  indexWarm: { done: number; total: number } | null;

  startSession: (session: Session) => Promise<void>;
  logout: () => void;
  /** Locks the vault but keeps device-unlock enrolled; Touch ID reopens it. */
  lockVault: () => void;
  refresh: () => Promise<void>;
  resyncLibrary: () => Promise<void>;
  refreshUsage: () => Promise<void>;
  createFolder: (name: string, parentId: string | null) => Promise<void>;
  renameFolder: (id: string, name: string) => Promise<void>;
  deleteFolder: (id: string) => Promise<void>;
  uploadFiles: (files: File[], folderId: string | null) => Promise<void>;
  uploadTree: (items: TreeFile[], baseFolderId: string | null) => Promise<void>;
  saveFileContent: (id: string, text: string) => Promise<void>;
  saveFileBinary: (
    id: string,
    bytes: Uint8Array,
    searchText?: string,
    opts?: { collabSnapshot?: boolean; collabUpTo?: number },
  ) => Promise<void>;
  createNote: (name: string, folderId: string | null) => Promise<string>;
  createOfficeDocument: (
    name: string,
    kind: "docx" | "xlsx",
    folderId: string | null,
  ) => Promise<string>;
  /** A conflicting save kept as this account's own new file. */
  saveFileCopy: (sourceId: string, bytes: Uint8Array, searchText?: string) => Promise<string>;
  /** Owner only: re-encrypts everything under a fresh key and re-seals it
   * for every remaining member. Revocation's second half. */
  rotateFileKey: (id: string) => Promise<void>;
  renameFile: (id: string, name: string) => Promise<void>;
  setTags: (id: string, tags: string[]) => Promise<void>;
  /** The set of photo-library asset ids already in the vault, read from
   * the synced metadata; a backup pass skips these. */
  backedUpSourceIds: () => Set<string>;
  /** Backs one exported original up into the Camera Roll folder, stamped
   * with its library id so a reinstall recognizes it. Returns the file id. */
  backupAsset: (file: File, sourceId: string) => Promise<string>;
  /** Adds every file to the album, one metadata write at a time. */
  addToAlbum: (ids: string[], tag: string) => Promise<void>;
  removeFromAlbum: (ids: string[], tag: string) => Promise<void>;
  /** Retags every member; returns the tag the album now lives under. */
  renameAlbum: (oldTag: string, name: string) => Promise<string>;
  /** Removes the tag from every member; the files themselves stay. */
  deleteAlbum: (tag: string) => Promise<void>;
  /**
   * Pins a fact the owner accepted. Pass `value` when they corrected an
   * ambiguous reading; nothing acts on a fact until this has been called.
   */
  confirmFact: (id: string, factId: string, value?: string) => Promise<void>;
  /** Puts a fact away. It is not offered again by a later scan. */
  dismissFact: (id: string, factId: string) => Promise<void>;
  /** Answers several of one file's facts in a single metadata write. */
  resolveFacts: (
    id: string,
    decisions: { confirm?: string[]; dismiss?: string[] },
  ) => Promise<void>;
  /**
   * Accepts a suggested trip: the trip's tag lands on every member, one
   * metadata write per file, and the Library's tag machinery does the rest.
   */
  confirmTrip: (suggestion: TripSuggestion) => Promise<void>;
  /**
   * The evidence behind a file's facts: the complete reference numbers and
   * the passages they came from. Fetched on request rather than held, which
   * is the entire reason metadata carries only the last four characters.
   */
  factEvidence: (id: string) => Promise<FactEvidence[]>;
  /**
   * Records a checksum for a file that has none, from bytes just read.
   * A baseline for future checks, not a verification of the past: nothing
   * can know what a digest-less file held before today, which is why this
   * only ever fills an absence and never overwrites a recorded digest.
   */
  recordDigest: (id: string, bytes: Uint8Array) => Promise<void>;
  /** Records that a read found this file disagreeing with its digest. */
  markCorrupt: (id: string) => void;
  /** Records that a read matched the digest recorded for this file. */
  markVerified: (id: string) => void;
  toggleFavorite: (id: string) => Promise<void>;
  moveFile: (id: string, folderId: string | null) => Promise<void>;
  trashFile: (id: string) => Promise<void>;
  restoreFile: (id: string) => Promise<void>;
  deleteForever: (id: string) => Promise<void>;
  clearFinishedUploads: () => void;
  cancelUploads: () => void;
  dismissReveal: () => void;
  createFileRequest: (label: string, folderId: string | null, expiresAt: number | null) => Promise<string>;
  ingestRequestUploads: () => Promise<number>;
  /** Invitations someone has claimed, waiting for this owner to approve. */
  pendingClaims: PendingClaim[];
  refreshPendingClaims: () => Promise<void>;
  /** Releases the file key to the account that claimed this invitation. */
  approveClaim: (token: string) => Promise<void>;
  recognizeFile: (id: string) => Promise<boolean>;
  recognizeAllImages: () => Promise<number>;
  /** Reads dates out of documents stored before this feature existed. */
  scanLibraryForFacts: () => Promise<number>;
  embedFile: (id: string) => Promise<boolean>;
  embedAllImages: () => Promise<number>;
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
    hasClip: meta.hasClip === true,
    inlineText: meta.text !== undefined,
    category: meta.category,
    tags: meta.tags ?? [],
    facts: asFacts(meta.facts),
    digest: meta.digest,
    sourceId: meta.sourceId,
    favorite: meta.favorite ?? false,
    key,
    hasThumb: dto.thumbSize > 0,
    trashed: dto.trashed,
    createdAt: dto.createdAt,
    updatedAt: dto.updatedAt,
    keyEpoch: dto.keyEpoch ?? 0,
    generation: dto.generation ?? 0,
  };
}

/**
 * The entry a server reply describes, given what this account already
 * holds. A shared file's reply carries the OWNER's wrapped key, which this
 * account's master key cannot open and has no need to: the key arrived
 * with the share and is already in hand. Getting this wrong made every
 * collaborator's save land its bytes and then report failure.
 */
export function entryFromUpdate(
  prior: FileEntry | undefined,
  dto: FileDto,
  masterKey: Uint8Array,
): FileEntry {
  if (!prior?.shared) {
    return decryptFile(dto, masterKey);
  }
  const meta = decryptFileMetadata(dto.encryptedMeta, prior.key);
  return {
    ...prior,
    name: meta.name,
    mime: meta.mime,
    size: meta.size,
    mtime: meta.mtime,
    width: meta.width,
    height: meta.height,
    blur: meta.blur,
    text: meta.text,
    hasText: meta.hasText === true || meta.text !== undefined,
    hasClip: meta.hasClip === true,
    inlineText: meta.text !== undefined,
    category: meta.category,
    tags: meta.tags ?? [],
    facts: asFacts(meta.facts),
    digest: meta.digest,
    sourceId: meta.sourceId,
    favorite: meta.favorite ?? false,
    hasThumb: dto.thumbSize > 0,
    // The owner's tree and wrapping stay the owner's business.
    folderId: null,
    updatedAt: dto.updatedAt,
    generation: dto.generation ?? prior.generation,
  };
}

/**
 * A file shared in by another account. The key arrives sealed to this
 * account's public key rather than wrapped under the master key; once open,
 * everything downstream is identical because metadata is encrypted under
 * the FILE key. Exported for its tests.
 */
export function decryptSharedFile(dto: SharedFileDto, session: Session): FileEntry {
  const key = openSharedFileKey(dto.sealedKey, session);
  const meta = decryptFileMetadata(dto.encryptedMeta, key);
  return {
    id: dto.id,
    folderId: null,
    name: meta.name,
    mime: meta.mime,
    size: meta.size,
    mtime: meta.mtime,
    width: meta.width,
    height: meta.height,
    blur: meta.blur,
    text: meta.text,
    hasText: meta.hasText === true || meta.text !== undefined,
    hasClip: meta.hasClip === true,
    inlineText: meta.text !== undefined,
    category: meta.category,
    tags: meta.tags ?? [],
    facts: asFacts(meta.facts),
    digest: meta.digest,
    sourceId: meta.sourceId,
    favorite: meta.favorite ?? false,
    key,
    hasThumb: dto.thumbSize > 0,
    trashed: false,
    createdAt: dto.createdAt,
    updatedAt: dto.updatedAt,
    shared: true,
    role: dto.role,
    ownerEmail: dto.ownerEmail,
    keyEpoch: dto.keyEpoch,
    generation: dto.generation ?? 0,
  };
}

/**
 * The entry, back in the shape it is stored in.
 *
 * Every patch rebuilds metadata from here and sends the result, so a field
 * this function forgets is destroyed the next time the file is renamed,
 * tagged or favorited. That failure is silent, which is why it has its own
 * tests: nothing errors, the file still opens, and the loss only surfaces
 * later when something that needed the field cannot run.
 */
export function metadataOf(file: FileEntry): FileMetadata {
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
    ...(file.hasClip ? { hasClip: true } : {}),
    category: file.category,
    tags: file.tags,
    ...(file.facts.length > 0 ? { facts: file.facts } : {}),
    favorite: file.favorite,
    // Without this a rename erased the digest, and with it the only record of
    // what the file held when it was stored. Nothing failed at the time; the
    // file simply became unverifiable, and "Verify my vault" would report it
    // as never checked forever after.
    digest: file.digest,
    // Same hazard for the backup link: dropping it would make a later
    // pass re-upload every already-backed-up photo.
    ...(file.sourceId ? { sourceId: file.sourceId } : {}),
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

  /** The last sync sequence applied in this tab; 0 forces a full sync. */
  let syncCursor = 0;

  /** Decrypts a complete row set into fresh maps, skipping tombstones and
   * pending uploads, and carrying warmed search text over from the current
   * entries. One corrupt row must never take the whole library down. */
  const buildLibrary = (
    folderDtos: FolderDto[],
    fileDtos: FileDto[],
    sharedDtos: SharedFileDto[] = [],
  ) => {
    const key = masterKey();
    const prior = get().files;
    const folders = new Map<string, FolderEntry>();
    const files = new Map<string, FileEntry>();
    let undecryptable = 0;
    for (const dto of folderDtos) {
      if (!dto.deleted) {
        try {
          folders.set(dto.id, decryptFolder(dto, key));
        } catch {
          undecryptable++;
        }
      }
    }
    for (const dto of fileDtos) {
      if (!dto.deleted && dto.uploaded) {
        try {
          const entry = decryptFile(dto, key);
          const before = prior.get(dto.id);
          if (entry.text === undefined && entry.hasText && before?.text !== undefined) {
            entry.text = before.text;
          }
          if (entry.clip === undefined && entry.hasClip && before?.clip !== undefined) {
            entry.clip = before.clip;
            entry.clips = before.clips;
          }
          files.set(dto.id, entry);
        } catch {
          undecryptable++;
        }
      }
    }
    const session = get().session;
    for (const dto of sharedDtos) {
      if (dto.revoked || !dto.uploaded || !session) {
        continue;
      }
      try {
        const entry = decryptSharedFile(dto, session);
        const before = prior.get(dto.id);
        if (entry.text === undefined && entry.hasText && before?.text !== undefined) {
          entry.text = before.text;
        }
        files.set(dto.id, entry);
      } catch {
        undecryptable++;
      }
    }
    if (undecryptable > 0) {
      console.warn(`${undecryptable} item(s) could not be decrypted and were skipped`);
    }
    return { folders, files };
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
      const entry = entryFromUpdate(files.get(dto.id), dto, masterKey());
      // Keep already-warmed search text across metadata updates.
      const prior = files.get(dto.id);
      if (entry.text === undefined && entry.hasText && prior?.text !== undefined) {
        entry.text = prior.text;
      }
      if (entry.clip === undefined && entry.hasClip && prior?.clip !== undefined) {
        entry.clip = prior.clip;
        entry.clips = prior.clips;
      }
      files.set(dto.id, entry);
    }
    set({ files });
  };


  /** One cancel scope shared by every transfer in flight; a scope that has
   * been cancelled is spent, so the next batch opens a fresh one. */
  const transferScope = (): AbortController => {
    const existing = get().uploadAbort;
    if (existing && !existing.signal.aborted) {
      return existing;
    }
    const fresh = new AbortController();
    set({ uploadAbort: fresh });
    return fresh;
  };

  /** Replaces one entry's in-memory search text. */
  const setEntryClip = (id: string, clip: Float32Array, clips?: Float32Array[]) => {
    const entry = get().files.get(id);
    if (!entry) {
      return;
    }
    const files = new Map(get().files);
    files.set(id, { ...entry, clip, ...(clips ? { clips } : {}), hasClip: true });
    set({ files });
  };

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

  const normalizeTags = (tags: readonly string[]): string[] => [
    ...new Set(tags.map((t) => t.trim().toLowerCase()).filter(Boolean)),
  ];

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

  /**
   * Facts for contents that have just been replaced.
   *
   * A fact describes contents, so a save has to make every one of them answer
   * for itself. Returns what should be stored, and the evidence to write
   * beside it. Cheap when the preference is off, in which case the facts a
   * file already carries are left exactly as they are rather than discarded:
   * turning the setting off should stop new reading, not erase old answers.
   */
  const rescanFacts = async (
    file: FileEntry,
    text: string | undefined,
    digest: string,
  ): Promise<{ facts: Fact[]; evidence: FactEvidence[] } | null> => {
    // Whether or not the file carried facts before: an edit can introduce
    // the first labelled date a document has ever had, and skipping the
    // scan then would mean saves never discover anything, only lose it.
    if (!factsEnabled()) {
      return null;
    }
    const found = await scanForFacts({ name: file.name, mime: file.mime, text }).catch(
      () => null,
    );
    if (!found) {
      return null;
    }
    return { facts: reconcileFacts(file.facts, found.facts, digest), evidence: found.evidence };
  };

  /** Applies a change to one fact and stores the whole set back. */
  const updateFact = async (id: string, factId: string, change: (fact: Fact) => Fact) => {
    const file = get().files.get(id);
    if (!file) {
      return;
    }
    const facts = file.facts.map((fact) => (fact.id === factId ? change(fact) : fact));
    await patchFileMeta(id, { facts });
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
    pendingClaims: [],
    synced: false,
    syncError: null,
    folders: new Map(),
    files: new Map(),
    usage: null,
    isAdmin: false,
    uploads: [],
    uploadAbort: null,
    reveal: null,
    ocrProgress: null,
    semanticProgress: null,
    batch: null,
    indexWarm: null,

    // A failed first sync must never strand the user on a spinner: the
    // session (and its keys) are kept, the error is surfaced, and the UI
    // offers a retry.
    startSession: async (session) => {
      syncCursor = 0;
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
      const account = get().session?.email;
      if (account) {
        void clearCache(account);
      }
      syncCursor = 0;
      clearSession(account);
      try {
        // Recent searches are plaintext fragments of the library; they
        // must not outlive the session on a shared device.
        localStorage.removeItem("engram-recent-searches");
      } catch {
        // Storage may be unavailable; nothing else to do.
      }
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

    lockVault: () => {
      syncCursor = 0;
      suspendSession();
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
      const account = get().session?.email;
      if (!account) {
        throw new Error("not signed in");
      }
      // Warm boot: the rows cached on this device (ciphertext, exactly as the
      // server sent them) put the library on screen before the network answers.
      if (!get().synced && syncCursor === 0) {
        const cached = await loadCache(account);
        if (cached) {
          const { folders, files } = buildLibrary(cached.folders, cached.files, cached.shared);
          syncCursor = cached.seq;
          set({ folders, files, synced: true, syncError: null });
        }
      }
      let response;
      try {
        response = await api.sync(syncCursor);
      } catch (err) {
        set({ syncError: err instanceof Error ? err.message : "could not reach the server" });
        throw err;
      }
      if (syncCursor === 0) {
        const { folders, files } = buildLibrary(response.folders, response.files, response.shared);
        set({ folders, files, synced: true, syncError: null });
      } else if (
        response.folders.length > 0 ||
        response.files.length > 0 ||
        (response.shared?.length ?? 0) > 0
      ) {
        // Delta on top of what is already showing: tombstones prune, live
        // rows replace. A row that fails to decrypt keeps its prior entry.
        const key = masterKey();
        const folders = new Map(get().folders);
        const files = new Map(get().files);
        for (const dto of response.folders) {
          if (dto.deleted) {
            folders.delete(dto.id);
            continue;
          }
          try {
            folders.set(dto.id, decryptFolder(dto, key));
          } catch {
            // keep the prior entry
          }
        }
        for (const dto of response.files) {
          if (dto.deleted) {
            files.delete(dto.id);
            continue;
          }
          if (!dto.uploaded) {
            continue; // created but not yet uploaded; nothing to show
          }
          try {
            const entry = decryptFile(dto, key);
            const before = files.get(dto.id);
            if (entry.text === undefined && entry.hasText && before?.text !== undefined) {
              entry.text = before.text;
            }
            files.set(dto.id, entry);
          } catch {
            // keep the prior entry
          }
        }
        const session = get().session;
        for (const dto of response.shared ?? []) {
          // A revoked membership, or a share whose file left the living
          // set, is the tombstone.
          if (dto.revoked || !dto.uploaded) {
            files.delete(dto.id);
            continue;
          }
          if (!session) {
            continue;
          }
          try {
            const entry = decryptSharedFile(dto, session);
            const before = files.get(dto.id);
            if (entry.text === undefined && entry.hasText && before?.text !== undefined) {
              entry.text = before.text;
            }
            files.set(dto.id, entry);
          } catch {
            // keep the prior entry
          }
        }
        set({ folders, files, synced: true, syncError: null });
      } else {
        set({ synced: true, syncError: null });
      }
      syncCursor = response.seq;
      void storeSyncRows(account, response);
      // Anything that arrived through a file request gets filed
      // automatically. Share invitations do NOT self-complete: releasing a
      // file key is a decision, and it waits for the owner to look at who
      // actually claimed it.
      await get().ingestRequestUploads().catch(() => 0);
      await get().refreshPendingClaims().catch(() => {});
    },

    /** Escape hatch: full sync from the server and an exact cache rebuild,
     * for when this device's copy is suspected stale or corrupt. */
    resyncLibrary: async () => {
      const account = get().session?.email;
      if (!account) {
        throw new Error("not signed in");
      }
      const response = await api.sync(0);
      const { folders, files } = buildLibrary(response.folders, response.files, response.shared);
      syncCursor = response.seq;
      set({ folders, files, synced: true, syncError: null });
      await storeSyncRows(account, response, true);
      await get().refreshUsage();
    },

    refreshUsage: async () => {
      const user = await api.user();
      set({
        usage: { usedBytes: user.usedBytes, quotaBytes: user.quotaBytes },
        isAdmin: user.isAdmin === true,
      });
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
      const cancel = transferScope();
      holdTransferLock();
      // Transfers overlap; READING the files does not, beyond what the
      // device can hold. Analysing four photos at once exhausted an
      // iPhone's memory and iOS killed the app mid-upload.
      await boundedRun(fileList, uploadLanes(), async (file) => {
        if (cancel.signal.aborted) {
          return;
        }
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
          const prepared = await withAnalysisSlot(() =>
            analyzeFile(file, cancel.signal, (phase) => update({ detail: phase })),
          );
          update({ detail: "encrypting" });
          // Root uploads are auto-filed into a category folder; uploads into a
          // folder the user picked stay where the user put them.
          const destination =
            folderId ?? (await ensureCategoryFolder(prepared.analysis.category));
          // The bar never walks backwards (a retried part restarts its own
          // count), and a full bar that is still working reads "finalizing"
          // while the server stitches parts together.
          let peak = 0;
          const result = await encryptAndUpload(
            file,
            destination,
            key,
            prepared,
            (fraction) => {
              peak = Math.max(peak, fraction);
              update({ status: peak >= 1 ? "finalizing" : "uploading", progress: peak });
            },
            cancel.signal,
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
          update({
            status: "error",
            error: cancel.signal.aborted
              ? "cancelled"
              : err instanceof Error
                ? err.message
                : "upload failed",
          });
        }
      });
      releaseTransferLock();
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
      const cancel = transferScope();
      holdTransferLock();
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
      await boundedRun(items, uploadLanes(), async (item) => {
        if (cancel.signal.aborted) {
          const skipped = get().batch;
          set({ batch: skipped ? { ...skipped, failed: skipped.failed + 1 } : null });
          return;
        }
        const current = get().batch;
        set({ batch: current ? { ...current, current: item.file.name } : null });
        try {
          const analyzed = await withAnalysisSlot(() => analyzeFile(item.file, cancel.signal));
          // Caller-supplied tags join the analysis rather than replace it, so
          // a watched file keeps its category and gains its origin.
          const prepared = item.tags?.length
            ? {
                ...analyzed,
                analysis: {
                  ...analyzed.analysis,
                  tags: [...new Set([...analyzed.analysis.tags, ...item.tags])],
                },
              }
            : analyzed;
          const destination =
            item.path.length > 0
              ? (folderIds.get(pathKey(item.path)) ?? baseFolderId)
              : (baseFolderId ?? (await ensureCategoryFolder(prepared.analysis.category)));
          const result = await withRetry(() =>
            encryptAndUpload(item.file, destination, key, prepared, () => {}, cancel.signal),
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

      releaseTransferLock();
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
      try {
        await uploadBlob(id, "data", encryptBytes(bytes, file.key));
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          throw new SaveConflictError(id);
        }
        throw err;
      }
      const digest = contentDigest(bytes);
      const searchText = text.slice(0, 100_000);
      const rescanned = await rescanFacts(file, searchText, digest);
      await uploadBlob(
        id,
        "index",
        encryptBytes(
          encodeIndexPayload({
            text: searchText,
            clip: file.clip,
            clips: file.clips,
            evidence: rescanned?.evidence,
          }),
          file.key,
        ),
      );
      await patchFileMeta(id, {
        size: bytes.length,
        mtime: Date.now(),
        hasText: true,
        text: undefined,
        digest,
        ...(rescanned ? { facts: rescanned.facts } : {}),
      });
      setEntryText(id, searchText, false);
      await get().refreshUsage();
    },

    // Binary flavor of the same flow, for document formats where the editor
    // exports bytes (e.g. .docx). searchText, when the editor can provide it,
    // keeps the file findable through client-side search.
    saveFileBinary: async (id, bytes, searchText, opts) => {
      const file = get().files.get(id);
      if (!file) {
        throw new Error("file not found");
      }
      // Before storing: what we are about to write must read back as what
      // we were given. A save that cannot be read back is not stored at all,
      // and the previous version stays the current one.
      const sealed = encryptBytes(bytes, file.key);
      const readBack = decryptBytes(sealed, file.key);
      if (!digestMatches(readBack, contentDigest(bytes))) {
        throw new Error("this save could not be verified and was not stored");
      }
      try {
        await uploadBlob(id, "data", sealed, undefined, undefined, {
          collabSnapshot: opts?.collabSnapshot,
          collabUpTo: opts?.collabUpTo,
        });
      } catch (err) {
        // Someone else's save landed first. Typed, so the editor can offer
        // the two honest ways out instead of a generic failure.
        if (err instanceof ApiError && err.status === 409) {
          throw new SaveConflictError(id);
        }
        throw err;
      }
      const digest = contentDigest(bytes);
      const rescanned = await rescanFacts(file, searchText, digest);
      if (searchText !== undefined || rescanned) {
        await uploadBlob(
          id,
          "index",
          encryptBytes(
            encodeIndexPayload({
              text: searchText?.slice(0, 100_000),
              clip: file.clip,
              clips: file.clips,
              evidence: rescanned?.evidence,
            }),
            file.key,
          ),
        );
      }
      await patchFileMeta(id, {
        size: bytes.length,
        mtime: Date.now(),
        // The digest describes the bytes just written. It was computed here
        // and then dropped, which was survivable only while metadata forgot
        // the digest entirely; now that a patch preserves it, omitting it
        // would leave the previous version's digest attached to new content
        // and a verification pass would call a healthy file damaged.
        digest,
        ...(searchText !== undefined ? { hasText: true, text: undefined } : {}),
        ...(rescanned ? { facts: rescanned.facts } : {}),
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

    /** A new Word document or spreadsheet, created empty and encrypted here. */
    createOfficeDocument: async (name, kind, folderId) => {
      const extension = `.${kind}`;
      const fileName = name.toLowerCase().endsWith(extension) ? name : `${name}${extension}`;
      const bytes = blankDocument(kind);
      const fileKey = generateKey();
      const meta: FileMetadata = {
        name: fileName,
        mime: kind === "docx" ? DOCX_MIME : XLSX_MIME,
        size: bytes.length,
        mtime: Date.now(),
        category: kind === "docx" ? "Documents" : "Spreadsheets",
        tags: [kind, String(new Date().getFullYear())],
      };
      const dto = await api.createFile(
        folderId,
        secretBoxSeal(fileKey, masterKey()),
        encryptFileMetadata(meta, fileKey),
      );
      await uploadBlob(dto.id, "data", encryptBytes(bytes, fileKey));
      applyFile({ ...dto, uploaded: true, size: bytes.length });
      return dto.id;
    },

    /**
     * Rotates a file's key after a collaborator loses access. Everything the
     * file has — content, thumbnail, search index — is re-encrypted under a
     * fresh key, the row flips its wrapped key (which advances the epoch),
     * and every REMAINING member gets the new key sealed to them. Order is
     * fail-closed: new blobs first, the flip second, the re-seals last, so a
     * failure part-way can lock members out until retried but never leaves
     * the revoked key valid for new content.
     */
    rotateFileKey: async (id) => {
      const file = get().files.get(id);
      if (!file || file.shared) {
        throw new Error("only the owner can rotate a file's key");
      }
      const plaintext = await downloadAndDecrypt(id, file.key, file.digest);
      const newKey = generateKey();
      const isMedia = file.mime.startsWith("video/") || file.mime.startsWith("audio/");
      await uploadBlob(
        id,
        "data",
        isMedia ? chunkedEncrypt(plaintext, newKey) : encryptBytes(plaintext, newKey),
      );
      if (file.hasThumb) {
        const thumb = decryptBytes(await api.downloadBlob(id, "thumbnail"), file.key);
        await uploadBlob(id, "thumbnail", encryptBytes(thumb, newKey));
      }
      if (file.hasText || file.hasClip) {
        const index = decryptBytes(await api.downloadBlob(id, "index"), file.key);
        await uploadBlob(id, "index", encryptBytes(index, newKey));
      }
      const meta = { ...metadataOf(file), digest: contentDigest(plaintext) };
      const dto = await api.patchFile(id, {
        encryptedKey: secretBoxSeal(newKey, masterKey()),
        encryptedMeta: encryptFileMetadata(meta, newKey),
      });
      applyFile(dto);
      const { collaborators } = await api.listCollaborators(id);
      if (collaborators.length > 0) {
        await api.rekeyShared(
          id,
          (file.keyEpoch ?? 0) + 1,
          collaborators.map((member) => ({
            userId: member.userId,
            sealedKey: sealFileKeyFor(newKey, member.publicKey),
          })),
        );
      }
    },

    /**
     * The way out of a save conflict that keeps the loser's work: their
     * exported bytes land in a NEW file of their own, owned by this account
     * whoever owns the original, and the contested document stays exactly
     * as its winner saved it.
     */
    saveFileCopy: async (sourceId, bytes, searchText) => {
      const source = get().files.get(sourceId);
      if (!source) {
        throw new Error("file not found");
      }
      const fileKey = generateKey();
      const meta: FileMetadata = {
        name: copyName(source.name),
        mime: source.mime,
        size: bytes.length,
        mtime: Date.now(),
        category: source.category,
        tags: source.tags,
        digest: contentDigest(bytes),
        ...(searchText !== undefined ? { hasText: true } : {}),
      };
      const dto = await api.createFile(
        source.shared ? null : source.folderId,
        secretBoxSeal(fileKey, masterKey()),
        encryptFileMetadata(meta, fileKey),
      );
      await uploadBlob(dto.id, "data", encryptBytes(bytes, fileKey));
      if (searchText !== undefined) {
        await uploadBlob(
          dto.id,
          "index",
          encryptBytes(encodeIndexPayload({ text: searchText.slice(0, 100_000) }), fileKey),
        );
      }
      applyFile({ ...dto, uploaded: true, size: bytes.length });
      return dto.id;
    },

    renameFile: async (id, name) => patchFileMeta(id, { name }),

    markVerified: (id) => {
      const file = get().files.get(id);
      if (!file || file.verified || !file.digest) {
        return;
      }
      const files = new Map(get().files);
      files.set(id, { ...file, verified: true, corrupt: false });
      set({ files });
    },

    recordDigest: async (id, bytes) => {
      const file = get().files.get(id);
      if (!file || file.digest) {
        // Never overwrite: an existing digest is a record of the past, and
        // replacing it with the present would erase exactly the disagreement
        // a check exists to find.
        return;
      }
      await patchFileMeta(id, { digest: contentDigest(bytes) });
    },

    markCorrupt: (id) => {
      const file = get().files.get(id);
      if (!file || file.corrupt) {
        return;
      }
      const files = new Map(get().files);
      files.set(id, { ...file, corrupt: true });
      set({ files });
    },

    setTags: async (id, tags) => {
      const file = get().files.get(id);
      if (!file) {
        return;
      }
      // The free-tag editor cannot mint or drop reserved tags: a hand-typed
      // "album:x" is discarded, and membership the file already has survives
      // an ordinary tag edit untouched. Albums and trips change only through
      // their own flows below.
      const existingReserved = file.tags.filter((t) => isReservedTag(t));
      const edited = normalizeTags(tags).filter(
        (t) => !isReservedTag(t) || existingReserved.includes(t),
      );
      const kept = existingReserved.filter((t) => !edited.includes(t));
      await patchFileMeta(id, { tags: [...edited, ...kept] });
    },

    backedUpSourceIds: () => {
      const ids = new Set<string>();
      for (const file of get().files.values()) {
        if (file.sourceId) {
          ids.add(file.sourceId);
        }
      }
      return ids;
    },

    backupAsset: async (file, sourceId) => {
      const key = masterKey();
      const prepared = await withAnalysisSlot(() => analyzeFile(file));
      // The library id rides inside the encrypted metadata, so a
      // reinstall rebuilds its ledger from the synced library alone.
      prepared.meta.sourceId = sourceId;
      const destination = await ensureCategoryFolder("Camera Roll");
      const result = await encryptAndUpload(file, destination, key, prepared, () => {});
      applyFile(result.dto);
      return result.dto.id;
    },

    addToAlbum: async (ids, tag) => {
      // Sequential on purpose: patchFileMeta rewrites the whole metadata
      // object, so two in-flight writes to one vault race last-write-wins.
      for (const id of ids) {
        const file = get().files.get(id);
        if (!file || file.tags.includes(tag)) {
          continue;
        }
        await patchFileMeta(id, { tags: normalizeTags([...file.tags, tag]) });
      }
    },

    removeFromAlbum: async (ids, tag) => {
      for (const id of ids) {
        const file = get().files.get(id);
        if (!file || !file.tags.includes(tag)) {
          continue;
        }
        await patchFileMeta(id, { tags: file.tags.filter((t) => t !== tag) });
      }
    },

    renameAlbum: async (oldTag, name) => {
      const newTag = albumTag(name);
      if (!newTag || newTag === oldTag) {
        return oldTag;
      }
      const members = [...get().files.values()].filter((f) => f.tags.includes(oldTag));
      for (const file of members) {
        await patchFileMeta(file.id, {
          tags: normalizeTags(file.tags.map((t) => (t === oldTag ? newTag : t))),
        });
      }
      return newTag;
    },

    deleteAlbum: async (tag) => {
      const members = [...get().files.values()].filter((f) => f.tags.includes(tag));
      for (const file of members) {
        await patchFileMeta(file.id, { tags: file.tags.filter((t) => t !== tag) });
      }
    },

    confirmFact: async (id, factId, value) =>
      updateFact(id, factId, (fact) => {
        const confirmed: Fact = { ...fact, confirmed: true };
        // The identity stays as it was even when the value is corrected.
        // An id is derived from the reading a scan produced, so keeping it
        // is what lets a later rescan recognize this fact and be suppressed
        // by it. Re-deriving the id would let the original wrong suggestion
        // come back and sit beside the corrected one.
        if (value !== undefined) {
          if (value !== fact.value) {
            // A corrected value is the owner's statement, not the scan's,
            // and the panel should say so instead of claiming a label read
            // something the document may not even contain.
            confirmed.source = "user";
            confirmed.confidence = 1;
          }
          confirmed.value = value;
        }
        delete confirmed.ambiguous;
        return confirmed;
      }),

    dismissFact: async (id, factId) =>
      updateFact(id, factId, (fact) => ({ ...fact, dismissed: true })),

    resolveFacts: async (id, decisions) => {
      const file = get().files.get(id);
      if (!file) {
        return;
      }
      // One patch for the whole file, however many facts were answered. A
      // bulk decision over a thousand-file upload must cost one write per
      // file, not one per click.
      const confirm = new Set(decisions.confirm ?? []);
      const dismiss = new Set(decisions.dismiss ?? []);
      const facts = file.facts.map((fact) => {
        if (confirm.has(fact.id)) {
          const done: Fact = { ...fact, confirmed: true };
          delete done.ambiguous;
          return done;
        }
        return dismiss.has(fact.id) ? { ...fact, dismissed: true } : fact;
      });
      await patchFileMeta(id, { facts });
    },

    confirmTrip: async (suggestion) => {
      const tag = tripTag(suggestion);
      for (const fileId of suggestion.fileIds) {
        const file = get().files.get(fileId);
        if (!file || file.tags.includes(tag)) {
          continue;
        }
        // Accepting the group is ratification: the exact events that formed
        // it become confirmed in the same write, so the rules that speak
        // only on confirmed facts may now speak about this trip. Soft
        // unconfirmed facts never took part in the grouping and stay
        // unconfirmed; nobody has looked at them yet.
        const facts = file.facts.map((fact) =>
          fact.kind === "event" &&
          !fact.dismissed &&
          !fact.confirmed &&
          fact.confidence === 1 &&
          EXACT_SOURCES.has(fact.source)
            ? { ...fact, confirmed: true }
            : fact,
        );
        await patchFileMeta(fileId, { tags: normalizeTags([...file.tags, tag]), facts });
      }
    },

    factEvidence: async (id) => {
      const file = get().files.get(id);
      if (!file) {
        return [];
      }
      try {
        const bytes = await api.downloadBlob(file.id, "index");
        return decodeIndexPayload(decryptBytes(bytes, file.key)).evidence ?? [];
      } catch {
        // A file stored before facts existed has no index blob to read.
        return [];
      }
    },

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

    cancelUploads: () => {
      get().uploadAbort?.abort();
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

    /**
     * Who is waiting on a key. An invitation names nobody until it is
     * claimed; once it is, the owner learns which account took it and
     * decides. Nothing is released by simply being asked.
     */
    refreshPendingClaims: async () => {
      if (!get().session) {
        return;
      }
      const { invites } = await api.listCollabInvites();
      const claims: PendingClaim[] = [];
      for (const invite of invites) {
        if (!invite.claimed || invite.granted || invite.revoked || !invite.claimantEmail) {
          continue;
        }
        claims.push({
          token: invite.token,
          fileId: invite.fileId,
          fileName: get().files.get(invite.fileId)?.name ?? "a document",
          claimantEmail: invite.claimantEmail,
          role: invite.role,
        });
      }
      set({ pendingClaims: claims });
    },

    approveClaim: async (token) => {
      const { invites } = await api.listCollabInvites();
      const invite = invites.find((i) => i.token === token);
      const file = invite ? get().files.get(invite.fileId) : undefined;
      if (!invite?.claimantPublicKey || !file) {
        throw new Error("this invitation is no longer available");
      }
      await api.grantCollabInvite(token, sealFileKeyFor(file.key, invite.claimantPublicKey));
      await get().refreshPendingClaims();
    },

    /** Runs OCR over one already-stored image or scanned PDF and files the
     * text into its encrypted metadata. Returns whether any text was found. */
    recognizeFile: async (id) => {
      const file = get().files.get(id);
      const scannable =
        file && (file.mime.startsWith("image/") || isPdf(file.name, file.mime));
      if (!file || !scannable) {
        return false;
      }
      const bytes = await downloadAndDecrypt(file.id, file.key, file.digest);
      const blob = new Blob([bytes.slice().buffer as ArrayBuffer], { type: file.mime });
      const text = file.mime.startsWith("image/")
        ? await recognizeImage(blob)
        : await recognizePdf(blob);
      if (!text) {
        return false;
      }
      await uploadBlob(
        id,
        "index",
        encryptBytes(encodeIndexPayload({ text, clip: file.clip, clips: file.clips }), file.key),
      );
      await patchFileMeta(id, { hasText: true, text: undefined });
      setEntryText(id, text, false);
      return true;
    },

    /**
     * Makes the whole library of images and scanned PDFs searchable: every
     * candidate without text goes through OCR, one at a time so the tab
     * stays responsive.
     */
    recognizeAllImages: async () => {
      const candidates = [...get().files.values()].filter(
        (f) =>
          !f.trashed && !f.hasText && (f.mime.startsWith("image/") || isPdf(f.name, f.mime)),
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
     * Reads dates out of a library that was stored before this existed.
     *
     * Facts come from text the vault already holds, so nothing is downloaded
     * for anything indexed earlier: the sweep is arithmetic over decrypted
     * metadata and the per-file index blob. Without it the feature appears
     * broken on an existing library, because only new uploads would ever be
     * read, which is the whole reason it is not optional.
     */
    scanLibraryForFacts: async () => {
      const candidates = [...get().files.values()].filter(
        (file) =>
          !file.trashed &&
          // Untouched by a human: nothing confirmed, nothing dismissed. A
          // file whose facts are all unanswered is fair game for a rescan,
          // which is what lets a reader improvement reach documents that
          // were read badly the first time.
          file.facts.every((fact) => !fact.confirmed && !fact.dismissed) &&
          (file.hasText || file.text !== undefined),
      );
      let found = 0;
      for (let i = 0; i < candidates.length; i++) {
        const file = candidates[i]!;
        set({ ocrProgress: { done: i, total: candidates.length, current: file.name } });
        try {
          // Whatever is already in memory, else the file's own index blob.
          let text = get().files.get(file.id)?.text;
          if (text === undefined) {
            const bytes = await api.downloadBlob(file.id, "index");
            text = decodeIndexPayload(decryptBytes(bytes, file.key)).text;
          }
          if (!text) {
            continue;
          }
          const scanned = await scanForFacts({ name: file.name, mime: file.mime, text });
          if (scanned.facts.length === 0) {
            continue;
          }
          const current = get().files.get(file.id);
          if (!current) {
            continue;
          }
          await uploadBlob(
            file.id,
            "index",
            encryptBytes(
              encodeIndexPayload({
                text,
                clip: current.clip,
                clips: current.clips,
                evidence: scanned.evidence,
              }),
              current.key,
            ),
          );
          // Merged rather than replaced: the sweep now revisits files whose
          // facts are all unanswered, and a rescan folding into what exists
          // is what lets a better reader supersede a worse reading without
          // duplicating what it merely re-found.
          await patchFileMeta(file.id, {
            facts: mergeFacts(
              current.facts,
              scanned.facts.map((fact) => ({ ...fact, digest: current.digest })),
            ),
          });
          found++;
        } catch {
          // One unreadable file never stops the sweep.
        }
      }
      set({ ocrProgress: null });
      return found;
    },

    /** Computes this file's semantic embedding on-device and files it into
     * the encrypted index blob alongside any search text already there.
     * Images embed from their full content; videos embed from their stored
     * poster frame, so the sweep never downloads a whole video. */
    embedFile: async (id) => {
      const file = get().files.get(id);
      if (!file) {
        return false;
      }
      const isImage = file.mime.startsWith("image/");
      const isVideo = file.mime.startsWith("video/") && file.hasThumb;
      if (!isImage && !isVideo) {
        return false;
      }
      const bytes = isImage
        ? await downloadAndDecrypt(file.id, file.key, file.digest)
        : await downloadThumbnail(file.id, file.key);
      const clip = await embedImage(
        new Blob([bytes.slice().buffer as ArrayBuffer], {
          type: isImage ? file.mime : "image/jpeg",
        }),
      );
      if (!clip) {
        return false;
      }
      // Merge with whatever the index blob already holds so text survives.
      let text = file.text;
      if (text === undefined && file.hasText && !file.inlineText) {
        try {
          const indexBytes = await api.downloadBlob(file.id, "index");
          text = decodeIndexPayload(decryptBytes(indexBytes, file.key)).text;
        } catch {
          // The embedding still lands; text warms on demand later.
        }
      }
      await uploadBlob(
        id,
        "index",
        encryptBytes(encodeIndexPayload({ text, clip }), file.key),
      );
      await patchFileMeta(id, {
        hasClip: true,
        ...(file.inlineText && text !== undefined ? { hasText: true, text: undefined } : {}),
      });
      if (file.inlineText && text !== undefined) {
        setEntryText(id, text, false);
      }
      setEntryClip(id, clip);
      return true;
    },

    /** Makes photos and videos searchable by meaning, one file at a time. */
    embedAllImages: async () => {
      const candidates = [...get().files.values()].filter(
        (f) =>
          !f.trashed &&
          !f.hasClip &&
          (f.mime.startsWith("image/") || (f.mime.startsWith("video/") && f.hasThumb)),
      );
      let indexed = 0;
      for (let i = 0; i < candidates.length; i++) {
        const file = candidates[i]!;
        set({ semanticProgress: { done: i, total: candidates.length, current: file.name } });
        try {
          if (await get().embedFile(file.id)) {
            indexed++;
          }
        } catch {
          // One unreadable image never stops the sweep.
        }
      }
      set({ semanticProgress: null });
      return indexed;
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
        (f) =>
          !f.trashed &&
          ((f.hasText && !f.inlineText && f.text === undefined) ||
            (f.hasClip && f.clip === undefined)),
      );
      if (candidates.length > 0) {
        set({ indexWarm: { done: 0, total: candidates.length } });
        await boundedRun(candidates, 3, async (file) => {
          try {
            const bytes = await api.downloadBlob(file.id, "index");
            const payload = decodeIndexPayload(decryptBytes(bytes, file.key));
            if (payload.text !== undefined) {
              setEntryText(file.id, payload.text);
            }
            if (payload.clip) {
              setEntryClip(file.id, payload.clip, payload.clips);
            }
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
          await uploadBlob(
            file.id,
            "index",
            encryptBytes(
              encodeIndexPayload({ text: file.text!, clip: file.clip, clips: file.clips }),
              file.key,
            ),
          );
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
