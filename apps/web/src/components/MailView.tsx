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
}) {
  const { record } = props;
  const [allowRemote, setAllowRemote] = useState(false);
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
        <h2 className="mail-subject">{record.subject || "(no subject)"}</h2>
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
