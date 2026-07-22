import { useState, type FormEvent } from "react";
import { login, registerAccount, type Session } from "../session";
import { useStore } from "../store";
import { BrandMark, Wordmark } from "./FileArt";

type Mode = "signin" | "signup";

export function Auth() {
  const startSession = useStore((s) => s.startSession);
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingRecovery, setPendingRecovery] = useState<{
    session: Session;
    recoveryKeyHex: string;
  } | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    try {
      if (mode === "signup") {
        if (password.length < 10) {
          setError("Use at least 10 characters; this password protects your keys.");
          return;
        }
        if (password !== confirm) {
          setError("Passwords do not match.");
          return;
        }
        setBusy("Deriving your keys with Argon2id. This is slow on purpose.");
        const result = await registerAccount(email, password);
        setPendingRecovery(result);
      } else {
        setBusy("Deriving your keys with Argon2id. This is slow on purpose.");
        const session = await login(email, password);
        setBusy("Decrypting your library.");
        await startSession(session);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "something went wrong");
    } finally {
      setBusy(null);
    }
  };

  const finishSignup = async () => {
    if (!pendingRecovery) {
      return;
    }
    setBusy("Preparing your vault.");
    await startSession(pendingRecovery.session);
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
          <p>End-to-end encrypted storage. Your keys never leave this device.</p>
        </div>

        <form className="auth-form" onSubmit={submit}>
          <label htmlFor="email">Email</label>
          <input
            id="email"
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
          />
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            required
            autoComplete={mode === "signup" ? "new-password" : "current-password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={mode === "signup" ? "A long, memorable passphrase" : "Your passphrase"}
          />
          {mode === "signup" && (
            <>
              <label htmlFor="confirm">Confirm password</label>
              <input
                id="confirm"
                type="password"
                required
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
            </>
          )}
          {error && <div className="error-text">{error}</div>}
          <button className="btn btn-primary" type="submit" disabled={busy !== null}>
            {busy ? <span className="spinner" /> : null}
            {busy ?? (mode === "signup" ? "Create vault" : "Unlock")}
          </button>
        </form>

        <div className="auth-switch">
          {mode === "signin" ? (
            <>
              New here?{" "}
              <a href="#signup" onClick={(e) => (e.preventDefault(), setMode("signup"))}>
                Create a vault
              </a>
            </>
          ) : (
            <>
              Already have a vault?{" "}
              <a href="#signin" onClick={(e) => (e.preventDefault(), setMode("signin"))}>
                Sign in
              </a>
            </>
          )}
        </div>
        <p className="auth-note">
          Files, names, and folders are encrypted on your device before upload.
          <br />
          The server stores ciphertext it cannot read.
        </p>
      </div>

      {pendingRecovery && (
        <div className="overlay">
          <div className="modal">
            <h2>Your recovery key</h2>
            <p className="modal-sub">
              This is the only way back into your vault if you forget your password. Store it
              somewhere safe and offline. It will not be shown again.
            </p>
            <div className="recovery-key">{pendingRecovery.recoveryKeyHex}</div>
            <div className="modal-actions">
              <button
                className="btn"
                onClick={() => navigator.clipboard.writeText(pendingRecovery.recoveryKeyHex)}
              >
                Copy
              </button>
              <button className="btn btn-primary" onClick={finishSignup} disabled={busy !== null}>
                I saved it, open my vault
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
