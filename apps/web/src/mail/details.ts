/**
 * What the details pane says about mail: for an email, who sent it, to
 * whom, when, and the files that came with it; for a file that came with
 * an email, which email that was. Both ways open the other file.
 */

import type { FileEntry } from "../store";

export interface MailRow {
  label: string;
  value: string;
  /** The file this row opens, when it names one that is still here. */
  openId?: string;
}

function sentAt(date: number): string {
  return date
    ? new Date(date).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
    : "Unknown";
}

export function mailRows(file: FileEntry, files: ReadonlyMap<string, FileEntry>): MailRow[] {
  const mail = file.mail;
  if (mail) {
    const rows: MailRow[] = [
      {
        label: "From",
        value: mail.from && mail.from !== mail.fromAddress ? `${mail.from} <${mail.fromAddress}>` : mail.fromAddress,
      },
    ];
    if (mail.to.length > 0) {
      rows.push({ label: "To", value: mail.to.join(", ") });
    }
    rows.push({ label: "Sent", value: sentAt(mail.date) });
    for (const id of mail.attachmentIds) {
      const attachment = files.get(id);
      if (attachment && !attachment.trashed) {
        rows.push({ label: "Attachment", value: attachment.name, openId: id });
      }
    }
    return rows;
  }
  if (file.mailParent) {
    const parent = files.get(file.mailParent);
    if (!parent?.mail) {
      return [{ label: "Came with", value: "an email no longer in the vault" }];
    }
    const sender = parent.mail.from || parent.mail.fromAddress;
    return [
      {
        label: "Came with",
        value: `${parent.mail.subject || "(no subject)"}, from ${sender}, ${sentAt(parent.mail.date)}`,
        openId: parent.id,
      },
    ];
  }
  return [];
}
