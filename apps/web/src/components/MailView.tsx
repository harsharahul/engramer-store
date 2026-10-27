import { useMemo, useState } from "react";
import type { FileEntry } from "../store";
import type { EmailRecord } from "../mail/record";
import { hasRemoteImages, prepareMailDocument } from "../mail/render";
import { formatBytes } from "../format";
import { Button } from "./ui/button";

/**
 * An email in the preview: who wrote it, to whom, when, the files that came
 * with it (each opens the stored file), and the body in a sandboxed frame.
 * The frame may open links in a new tab and nothing else: no script runs,
 * and remote images stay off until asked for, for this email only.
 */
export function MailView(props: {
  record: EmailRecord;
  file: FileEntry;
  onOpen?: (id: string) => void;
  /** Stores a PDF of this email; absent where nothing can be saved. */
  onSavePdf?: (bytes: Uint8Array, name: string, replacedCharacters: boolean) => Promise<void>;
}) {
  const { record } = props;
  const [allowRemote, setAllowRemote] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pdfError, setPdfError] = useState<string | null>(null);
  const savePdf = async () => {
    setSaving(true);
    setPdfError(null);
    try {
      // Loaded on first use: the PDF writer is not part of opening mail.
      const { emailToPdf } = await import("../mail/pdf");
      const { bytes, replacedCharacters } = await emailToPdf(record);
      const base = props.file.name.replace(/\.email$/i, "") || "Email";
      await props.onSavePdf!(bytes, `${base}.pdf`, replacedCharacters);
    } catch {
      setPdfError("The PDF could not be made.");
    } finally {
      setSaving(false);
    }
  };
  const doc = useMemo(() => prepareMailDocument(record, { allowRemote }), [record, allowRemote]);
  const remote = useMemo(() => hasRemoteImages(record), [record]);
  const ids = props.file.mail?.attachmentIds ?? [];
  const sender =
    record.from.name && record.from.name !== record.from.address
      ? `${record.from.name} <${record.from.address}>`
      : record.from.address || "Unknown sender";

  return (
    <div className="mail-view">
      <header className="mail-head">
        <div className="mail-title-row">
          <h2 className="mail-subject">{record.subject || "(no subject)"}</h2>
          {props.onSavePdf && (
            <Button variant="secondary" size="xs" disabled={saving} onClick={() => void savePdf()}>
              {saving ? "Saving…" : "Save as PDF"}
            </Button>
          )}
        </div>
        {pdfError && <div className="mail-remote">{pdfError}</div>}
        <dl className="mail-fields">
          <dt>From</dt>
          <dd>{sender}</dd>
          {record.to.length > 0 && (
            <>
              <dt>To</dt>
              <dd>{record.to.join(", ")}</dd>
            </>
          )}
          {record.cc.length > 0 && (
            <>
              <dt>Cc</dt>
              <dd>{record.cc.join(", ")}</dd>
            </>
          )}
          <dt>Date</dt>
          <dd>
            {record.date
              ? new Date(record.date).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
              : "Unknown"}
          </dd>
        </dl>
        {record.attachments.length > 0 && (
          <ul className="mail-attachments" aria-label="Attachments">
            {record.attachments.map((attachment, i) => {
              const id = ids[i];
              return (
                <li key={`${i}-${attachment.digest}`}>
                  <button
                    type="button"
                    className="mail-chip"
                    disabled={!id || !props.onOpen}
                    onClick={() => id && props.onOpen?.(id)}
                  >
                    <span className="mail-chip-name">{attachment.name}</span>
                    <span className="mail-chip-size">{formatBytes(attachment.size)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {remote && !allowRemote && (
          <div className="mail-remote">
            <span>Remote images are off, so the sender cannot tell you opened this.</span>
            <Button variant="secondary" size="xs" onClick={() => setAllowRemote(true)}>
              Load remote images
            </Button>
          </div>
        )}
      </header>
      <iframe
        className="mail-frame"
        title={record.subject || "Email"}
        sandbox="allow-popups allow-popups-to-escape-sandbox"
        referrerPolicy="no-referrer"
        srcDoc={doc}
      />
    </div>
  );
}
