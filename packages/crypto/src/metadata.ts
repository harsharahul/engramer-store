import { decryptJson, encryptJson, type SecretBox } from "./box.js";

/**
 * A fact read out of a file's contents on the device that stored it: an
 * expiry, an amount due, a reference number.
 *
 * The schema is deliberately loose where the meaning is not this package's
 * business, the same way `category` is a plain string here while the analyzer
 * that writes it works in a union. It keeps the vocabulary in one place, and
 * it means a client meeting a kind it has never heard of stores the value back
 * unchanged rather than deleting something a newer version wrote.
 *
 * Summaries only. A reference number is carried as its last four characters;
 * the full value lives in the file's encrypted index blob and is fetched when
 * the owner asks to see it, so the string worth stealing is not in the
 * structure every device decrypts on every sync.
 */
export interface StoredFact {
  id: string;
  kind: string;
  document: string;
  /** ISO date for date-shaped facts, a decimal string for amounts. */
  value: string;
  /** Local time of day as "HH:MM", where the document gave one. */
  time?: string;
  /** IANA zone the time belongs to, on the rare occasion it is known. */
  zone?: string;
  unit?: string;
  /** Last four characters of a reference number, never the whole of one. */
  masked?: string;
  source: string;
  confidence: number;
  ambiguous?: boolean;
  confirmed?: boolean;
  dismissed?: boolean;
  /** The contents this was read from, so a change to them can be noticed. */
  digest?: string;
  stale?: boolean;
}

/**
 * Per-file metadata. Encrypted with the file key before upload; the server
 * only ever sees the resulting SecretBox.
 */
export interface FileMetadata {
  name: string;
  mime: string;
  size: number;
  /** Modification time, milliseconds since epoch. */
  mtime: number;
  width?: number;
  height?: number;
  /** ThumbHash placeholder (base64, ~25 bytes) for instant grid paint. */
  blur?: string;
  /** Extracted text content for client-side full-text search (legacy: new
   * writes keep text in a separate encrypted index blob and set hasText). */
  text?: string;
  /** Marks that an encrypted search-text blob exists for this file. */
  hasText?: boolean;
  /** Marks that the index blob carries a semantic image embedding. */
  hasClip?: boolean;
  /** Auto-assigned category (client-side analysis; opaque to the server). */
  category?: string;
  /** Tags, auto-assigned and user-edited alike. */
  tags?: string[];
  favorite?: boolean;
  /**
   * BLAKE2b-256 of the file's contents, taken on the device that uploaded
   * it, before any encryption.
   *
   * Authenticated encryption already proves the server returned what it was
   * given. It cannot prove what it was given is what the file contained: a
   * bug on the way in encrypts the wrong bytes faithfully, which is exactly
   * what happened to every file a watched folder uploaded. This digest is
   * taken at the source and checked after decryption, so the whole path is
   * covered rather than the storage half of it.
   *
   * Optional because files stored before it existed do not carry one; their
   * contents are returned unverified rather than refused.
   */
  digest?: string;
  /**
   * Facts read out of the contents, summarized. Kept here rather than in the
   * index blob because metadata is already synced and decrypted, so listing
   * what is about to expire costs no extra request; the evidence behind each
   * one is fetched only when a fact is opened.
   */
  facts?: StoredFact[];
}

export interface FolderMetadata {
  name: string;
}

export function encryptFileMetadata(meta: FileMetadata, fileKey: Uint8Array): SecretBox {
  return encryptJson(meta, fileKey);
}

export function decryptFileMetadata(box: SecretBox, fileKey: Uint8Array): FileMetadata {
  return decryptJson<FileMetadata>(box, fileKey);
}

export function encryptFolderMetadata(meta: FolderMetadata, folderKey: Uint8Array): SecretBox {
  return encryptJson(meta, folderKey);
}

export function decryptFolderMetadata(box: SecretBox, folderKey: Uint8Array): FolderMetadata {
  return decryptJson<FolderMetadata>(box, folderKey);
}
