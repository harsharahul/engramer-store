/**
 * Every photo this account has ever backed up, remembered on this device.
 *
 * The synced library cannot answer "was this ever uploaded?" on its own:
 * a deleted-forever file leaves no row at all, and a trashed row is one
 * restore away from living again. While "backed up" was derived only from
 * live rows, deleting backed-up photos re-armed them, and bulk-trashing
 * the Camera Roll folder re-uploaded the entire library on the next pass.
 *
 * Once uploaded, a photo stays done. Restoring from Trash brings a
 * trashed copy back without a re-upload; for photos deleted forever, the
 * ledger reset in Profile is the explicit way to make them eligible
 * again.
 */

/** A file row as the ledger sees it; only the backup stamp matters here. */
export interface LedgerSource {
  sourceId?: string;
  trashed?: boolean;
}

function storageKey(account: string): string {
  return `engram-backup-ledger:${account}`;
}

export class BackupLedger {
  private ids: Set<string>;

  constructor(private readonly account: string) {
    this.ids = this.read();
  }

  private read(): Set<string> {
    try {
      const raw = localStorage.getItem(storageKey(this.account));
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      // A corrupt record must cost re-absorbing from the library, never a
      // wedged pass.
      return new Set(
        Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [],
      );
    } catch {
      return new Set();
    }
  }

  private write(): void {
    try {
      localStorage.setItem(storageKey(this.account), JSON.stringify([...this.ids]));
    } catch {
      // Persistence is best-effort; the session's own copy still holds.
    }
  }

  has(id: string): boolean {
    return this.ids.has(id);
  }

  /** Notes one finished upload. */
  add(id: string): void {
    this.ids.add(id);
    this.write();
  }

  /**
   * Learns from the synced library: every stamped row, trashed included,
   * proves an upload happened once. Runs at the start of each pass, so a
   * ledger emptied by a reset only re-learns what still has a row.
   */
  absorb(files: Iterable<LedgerSource>): void {
    let grew = false;
    for (const file of files) {
      if (file.sourceId && !this.ids.has(file.sourceId)) {
        this.ids.add(file.sourceId);
        grew = true;
      }
    }
    if (grew) {
      this.write();
    }
  }
}

/** Forgets the account's upload history, so deleted photos back up again. */
export function resetBackupLedger(account: string): void {
  try {
    localStorage.removeItem(storageKey(account));
  } catch {
    // Best-effort, as above.
  }
}
