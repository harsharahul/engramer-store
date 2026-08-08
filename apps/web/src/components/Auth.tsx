import { useEffect, useState, type FormEvent } from "react";
import { api } from "../api";
import { nativeServerUrlSet, nativeShell } from "../native";
import { login, registerAccount, type LoginResult, type Session } from "../session";
import { useStore } from "../store";
import { BrandMark, Wordmark } from "./FileArt";

type Mode = "signin" | "signup";
type RegistrationMode = "open" | "invite" | "closed";

/** Reads an invite token from the fragment, falling back to the query. */
function readInviteToken(): string {
  const fragment = new URLSearchParams(location.hash.replace(/^#/, ""));
  return fragment.get("invite") ?? new URLSearchParams(location.search).get("invite") ?? "";
}

export function Auth() {
  const startSession = useStore((s) => s.startSession);
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [registration, setRegistration] = useState<RegistrationMode>("open");
  // Invite links carry the token in the URL fragment, which browsers never
  // put on the wire, and it is wiped from the address bar once read so it
  // does not linger in history. A token from the query string is still
  // accepted for links already handed out, and scrubbed the same way.
  const [invite, setInvite] = useState(() => readInviteToken());
  // Shell only: repoint this install at a different vault server.
  const [serverEditing, setServerEditing] = useState(false);
  const [serverDraft, setServerDraft] = useState("");
  const [serverError, setServerError] = useState("");

  useEffect(() => {
    const arrived = invite.length > 0;
    if (arrived) {
      history.replaceState(null, "", location.pathname);
    }
    api
      .registration()
      .then(({ mode: serverMode }) => {
        setRegistration(serverMode);
        // Arriving with an invite link goes straight to the sign-up form.
        if (serverMode === "invite" && arrived) {
          setMode("signup");
        }
      })
      .catch(() => {});
    // Runs once on mount; `invite` is the value read from the URL there.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [twoFactor, setTwoFactor] = useState<Extract<LoginResult, { kind: "two-factor" }> | null>(
    null,
  );
  const [code, setCode] = useState("");
  const [pendingRecovery, setPendingRecovery] = useState<{
    session: Session;
    recoveryKeyHex: string;
  } | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    // Dismiss the keyboard now: key derivation takes seconds, and a mobile
    // viewport still sized for the keyboard when the vault mounts leaves its
    // fixed chrome floating above the real bottom edge.
    (document.activeElement as HTMLElement | null)?.blur?.();
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
        setBusy("Strengthening your password into encryption keys; slow on purpose.");
        const result = await registerAccount(email, password, invite.trim() || undefined);
        setPendingRecovery(result);
      } else {
        setBusy("Strengthening your password into encryption keys; slow on purpose.");
        const result = await login(email, password);
        if (result.kind === "two-factor") {
          setTwoFactor(result);
          return;
        }
        setBusy("Decrypting your library.");
        await startSession(result.session);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "something went wrong");
    } finally {
      setBusy(null);
    }
  };

  const submitCode = async (event: FormEvent) => {
    event.preventDefault();
    if (!twoFactor || !code.trim()) {
      return;
    }
    setError(null);
    setBusy("Checking the code.");
    try {
      const session = await twoFactor.complete(code.trim());
      setBusy("Decrypting your library.");
      await startSession(session);
    } catch (err) {
      setError(err instanceof Error ? err.message : "that code is not valid");
    } finally {
      setBusy(null);
    }
  };

  if (twoFactor) {
    return (
      <div className="auth-shell">
        <div className="auth-card">
          <div className="auth-brand">
            <BrandMark size={64} />
            <h1>Two-factor check</h1>
            <p>Enter the 6-digit code from your authenticator app, or a recovery code.</p>
          </div>
          <form className="auth-form" onSubmit={submitCode}>
            <label htmlFor="totp-code">Code</label>
            <input
              id="totp-code"
              autoFocus
              autoComplete="one-time-code"
              inputMode="numeric"
              placeholder="123456 or a recovery code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
            {error && <div className="error-text">{error}</div>}
            <button className="btn btn-primary" type="submit" disabled={busy !== null || !code.trim()}>
              {busy ? <span className="spinner" /> : null}
              {busy ? "Verifying" : "Verify"}
            </button>
            {busy && <div className="auth-note">{busy}</div>}
          </form>
          <div className="auth-switch">
            <a
              href="#signin"
              onClick={(e) => {
                e.preventDefault();
                setTwoFactor(null);
                setCode("");
                setError(null);
              }}
            >
              Back to sign in
            </a>
          </div>
        </div>
      </div>
    );
  }

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
              {registration === "invite" && (
                <>
                  <label htmlFor="invite">Invite code</label>
                  <input
                    id="invite"
                    value={invite}
                    onChange={(e) => setInvite(e.target.value)}
                    placeholder="From this server's administrator"
                  />
                </>
              )}
              {registration === "closed" && (
                <div className="auth-note">
                  Registration is disabled on this server. Contact the administrator.
                </div>
              )}
            </>
          )}
          {error && <div className="error-text">{error}</div>}
          <button className="btn btn-primary" type="submit" disabled={busy !== null}>
            {busy ? <span className="spinner" /> : null}
            {busy
              ? mode === "signup"
                ? "Creating vault"
                : "Unlocking"
              : mode === "signup"
                ? "Create vault"
                : "Unlock"}
          </button>
          {busy && <div className="auth-note">{busy}</div>}
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
        {nativeShell() && (
          <div className="auth-server">
            {serverEditing ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void nativeServerUrlSet(serverDraft).catch(() =>
                    setServerError("That address did not look like an http(s) server."),
                  );
                  // On success the shell navigates this window away; only a
                  // failure leaves anything to show.
                }}
              >
                <input
                  autoFocus
                  value={serverDraft}
                  placeholder="https://vault.example.com"
                  onChange={(e) => setServerDraft(e.target.value)}
                />
                <button type="submit" className="btn btn-primary">
                  Connect
                </button>
                <button type="button" className="btn btn-ghost" onClick={() => setServerEditing(false)}>
                  Cancel
                </button>
                {serverError && <span className="auth-server-error">{serverError}</span>}
              </form>
            ) : (
              <button className="auth-server-link" onClick={() => setServerEditing(true)}>
                Server: <b>{location.host}</b> · Change
              </button>
            )}
          </div>
        )}
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
