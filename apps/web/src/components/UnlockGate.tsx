import { useState } from "react";
import { useStore } from "../store";
import { restoreDeviceSession } from "../session";
import { loadUnlockRecord } from "../unlock";
import { BrandMark, Wordmark } from "./FileArt";
import { KeyGlyph } from "./Icon";

/**
 * Shown instead of the login form when this device holds a passkey-wrapped
 * session: one tap of Touch ID (or the platform's screen-lock passkey)
 * restores the vault; the password form stays one click away.
 */
export function UnlockGate(props: { onUsePassword: () => void }) {
  const startSession = useStore((s) => s.startSession);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const email = loadUnlockRecord()?.email;

  const unlock = async () => {
    setBusy(true);
    setError(null);
    try {
      const session = await restoreDeviceSession();
      if (session) {
        await startSession(session);
      } else {
        setError("Unlock did not complete. Try again, or use your password.");
      }
    } catch {
      setError("Could not unlock on this device. Use your password.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <div className="auth-brand">
          <BrandMark size={64} />
          <h1>
            <Wordmark />
          </h1>
          <p className="tagline">
            Private <b>·</b> Encrypted <b>·</b> Yours
          </p>
          {email && <p>{email}</p>}
        </div>
        <div className="auth-form">
          {error && <div className="error-text">{error}</div>}
          <button className="btn btn-primary" onClick={() => void unlock()} disabled={busy}>
            {busy ? <span className="spinner" /> : <KeyGlyph size={15} />}
            {busy ? "Unlocking" : "Unlock this vault"}
          </button>
          <button className="btn btn-ghost" onClick={props.onUsePassword} disabled={busy}>
            Use password instead
          </button>
        </div>
      </div>
    </div>
  );
}
