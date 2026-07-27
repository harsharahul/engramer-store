import { decryptJson, encryptJson, type SecretBox } from "./box.js";

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
  /** Auto-assigned category (client-side analysis; opaque to the server). */
  category?: string;
  /** Tags, auto-assigned and user-edited alike. */
  tags?: string[];
  favorite?: boolean;
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
