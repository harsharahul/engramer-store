import { useEffect, useMemo, useState } from "react";
import { extractArchive, listArchive, totalSize, type ArchiveEntry, type ExtractedEntry } from "../archive";
import { formatBytes } from "../format";
import { Button } from "./ui/button";

/**
 * An archive shown as what is inside it, with one action: extract the
 * entries into the vault, each through the ordinary upload path.
 */
export function ArchiveBody(props: {
  bytes: Uint8Array;
  name: string;
  onExtract?: (entries: ExtractedEntry[]) => Promise<void>;
}) {
  const [entries, setEntries] = useState<ArchiveEntry[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    try {
      setEntries(listArchive(props.bytes, props.name));
    } catch (err) {
      setFailed(err instanceof Error ? err.message : "could not read this archive");
    }
  }, [props.bytes, props.name]);

  const files = useMemo(() => entries?.filter((e) => !e.directory) ?? [], [entries]);

  if (failed) {
    return <div className="preview-fallback">{failed}</div>;
  }
  if (!entries) {
    return <div className="spinner" style={{ margin: "40px auto" }} />;
  }
  return (
    <div className="archive-body">
      <div className="archive-head">
        <span>
          {files.length} {files.length === 1 ? "file" : "files"}, {formatBytes(totalSize(files))} unpacked
        </span>
        {props.onExtract && files.length > 0 && (
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void props
                .onExtract!(extractArchive(props.bytes, props.name))
                .catch(() => {})
                .finally(() => setBusy(false));
            }}
          >
            {busy ? "Extracting…" : "Extract here"}
          </Button>
        )}
      </div>
      <ul className="archive-list">
        {entries.map((entry) => (
          <li key={entry.path} className={entry.directory ? "dir" : "file"} style={{ paddingLeft: 12 + entry.path.split("/").length * 14 }}>
            <span className="archive-name">{entry.path.split("/").pop()}</span>
            {!entry.directory && <span className="archive-size">{formatBytes(entry.size)}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}
