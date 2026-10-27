/**
 * Which of the files someone adds are mail. A saved message or a mailbox
 * export is imported as email records; everything else uploads as a file.
 */

import type { UploadSource } from "../transfer";
import type { TreeFile } from "../uploader";

const MAIL_TYPES = new Set(["message/rfc822", "application/mbox"]);

export function isMailSource(file: Pick<UploadSource, "name" | "type">): boolean {
  return MAIL_TYPES.has(file.type) || /\.(?:eml|mbox)$/i.test(file.name);
}

export function routeDrop(files: UploadSource[]): { mail: UploadSource[]; files: UploadSource[] } {
  return {
    mail: files.filter(isMailSource),
    files: files.filter((file) => !isMailSource(file)),
  };
}

/** The same source under another name; the bytes are read from the original. */
function renamed(file: UploadSource, name: string): UploadSource {
  return {
    name,
    type: file.type,
    size: file.size,
    lastModified: file.lastModified,
    slice: (start, end) => file.slice(start, end),
    arrayBuffer: () => file.arrayBuffer(),
    text: () => file.text(),
  };
}

/**
 * A dropped folder, routed. Apple Mail exports each mailbox as a folder
 * named "<mailbox>.mbox" holding the messages in a file called "mbox" and
 * an index of its own; the messages are imported under the mailbox's name,
 * and the index, which is not mail, is left out.
 */
export function routeTree(items: TreeFile[]): { mail: UploadSource[]; files: TreeFile[] } {
  const mail: UploadSource[] = [];
  const files: TreeFile[] = [];
  for (const item of items) {
    const bundle = item.path.at(-1);
    if (bundle && /\.mbox$/i.test(bundle)) {
      if (item.file.name === "mbox") {
        mail.push(renamed(item.file, bundle));
      }
      continue;
    }
    if (isMailSource(item.file)) {
      mail.push(item.file);
    } else {
      files.push(item);
    }
  }
  return { mail, files };
}
