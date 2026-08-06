import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { restoreDeviceSession } from "../session";
import { loadUnlockRecord } from "../unlock";
import { nativeShell } from "../native";
import { BrandMark, Wordmark } from "./FileArt";
import { KeyGlyph } from "./Icon";

/**
 * Shown instead of the login form when this device holds a passkey-wrapped
 * session: one authentication (Face ID on a phone, Touch ID or a passkey
 * elsewhere) restores the vault; the password form stays one click away.
 *
 * In the native shell the prompt comes up on its own the moment the app
 * opens, because that is the platform's pattern: a vault app asks for its
 * owner immediately. In a browser the same eagerness would throw a passkey
 * sheet at someone who merely opened a tab, so there the button waits.
 */
export function UnlockGate(props: { onUsePassword: () => void }) {
  const startSession = useStore((s) => s.startSession);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const email = loadUnlockRecord()?.email;
  const attempted = useRef(false);

  const unlock = async (auto = false) => {
    setBusy(true);
    setError(null);
    try {
      const session = await restoreDeviceSession();
      if (session) {
        await startSession(session);
      } else if (!auto) {
        setError("Unlock did not complete. Try again, or use your password.");
      }
    } catch {
      // A cancelled automatic prompt is not an error; the person simply
      // wants the button or the password, both of which are right here.
      if (!auto) {
        setError("Could not unlock on this device. Use your password.");
      }
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (nativeShell() && !attempted.current) {
      attempted.current = true;
      void unlock(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
