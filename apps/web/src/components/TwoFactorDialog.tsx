import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { api } from "../api";
import { CopyGlyph, XGlyph } from "./Icon";

type Stage =
  | { kind: "loading" }
  | { kind: "off" }
  | { kind: "enrolling"; secret: string; qrDataUrl: string }
  | { kind: "recovery"; codes: string[] }
  | { kind: "on"; recoveryCodesLeft: number };

/**
 * Two-factor management. TOTP gates the server's willingness to serve
 * ciphertext and accept writes; the encryption itself remains derived from
 * the password, which a second factor can neither weaken nor replace.
 */
export function TwoFactorDialog(props: { onToast: (message: string) => void; onClose: () => void }) {
  const [stage, setStage] = useState<Stage>({ kind: "loading" });
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api
      .user()
      .then((user) =>
        setStage(
          user.totpEnabled
            ? { kind: "on", recoveryCodesLeft: user.recoveryCodesLeft }
            : { kind: "off" },
        ),
      )
      .catch(() => setError("could not load account state"));
  }, []);

  const begin = async () => {
    setBusy(true);
    setError(null);
    try {
      const { secret, otpauthUri } = await api.totpSetup();
      const qrDataUrl = await QRCode.toDataURL(otpauthUri, { margin: 1, width: 208 });
      setStage({ kind: "enrolling", secret, qrDataUrl });
      setCode("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not start setup");
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      const { recoveryCodes } = await api.totpConfirm(code.trim());
      setStage({ kind: "recovery", codes: recoveryCodes });
      setCode("");
    } catch {
      setError("That code is not valid. Check your authenticator and try again.");
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.totpDisable(code.trim());
      props.onToast("Two-factor is off.");
      props.onClose();
    } catch {
      setError("That code is not valid.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="overlay" onClick={props.onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "start" }}>
          <h2>Two-factor authentication</h2>
          <button className="icon-btn" onClick={props.onClose}>
            <XGlyph />
          </button>
        </div>

        {stage.kind === "loading" && !error && <div className="spinner" style={{ margin: "18px auto" }} />}

        {stage.kind === "off" && (
          <>
            <p className="modal-sub">
              Require a code from your authenticator app at every sign-in. This gates access to
              your encrypted data through the server; the encryption itself stays derived from
              your password.
            </p>
            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={props.onClose}>
                Cancel
              </button>
              <button className="btn btn-primary" onClick={() => void begin()} disabled={busy}>
                {busy ? "Preparing…" : "Turn on"}
              </button>
            </div>
          </>
        )}

        {stage.kind === "enrolling" && (
          <>
            <p className="modal-sub">
              Scan with any authenticator app (1Password, Aegis, Google Authenticator…), then
              enter the code it shows.
            </p>
            <div className="totp-enroll">
              <img className="totp-qr" src={stage.qrDataUrl} alt="TOTP enrollment QR code" />
              <div className="totp-secret mono" title="Manual entry key">
                {stage.secret.replace(/(.{4})/g, "$1 ").trim()}
              </div>
            </div>
            <input
              autoFocus
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="6-digit code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void confirm()}
            />
            {error && <div className="error-text">{error}</div>}
            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={props.onClose}>
                Cancel
              </button>
              <button
                className="btn btn-primary"
                onClick={() => void confirm()}
                disabled={busy || code.trim().length < 6}
              >
                {busy ? "Checking…" : "Verify and enable"}
              </button>
            </div>
          </>
        )}

        {stage.kind === "recovery" && (
          <>
            <p className="modal-sub">
              Two-factor is on. These one-time recovery codes are the only way in if you lose the
              authenticator; they will not be shown again.
            </p>
            <div className="recovery-key totp-recovery-list">
              {stage.codes.join("\n")}
            </div>
            <div className="modal-actions">
              <button
                className="btn"
                onClick={() => {
                  void navigator.clipboard.writeText(stage.codes.join("\n"));
                  props.onToast("Recovery codes copied.");
                }}
              >
                <CopyGlyph size={14} /> Copy all
              </button>
              <button
                className="btn btn-primary"
                onClick={() => {
                  props.onToast("Two-factor is on.");
                  props.onClose();
                }}
              >
                I saved them
              </button>
            </div>
          </>
        )}

        {stage.kind === "on" && (
          <>
            <p className="modal-sub">
              Two-factor is on. {stage.recoveryCodesLeft} recovery code
              {stage.recoveryCodesLeft === 1 ? "" : "s"} remaining. To turn it off, enter a
              current code from your authenticator or a recovery code.
            </p>
            <input
              autoFocus
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="Code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void disable()}
            />
            {error && <div className="error-text">{error}</div>}
            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={props.onClose}>
                Close
              </button>
              <button
                className="btn btn-danger"
                onClick={() => void disable()}
                disabled={busy || !code.trim()}
              >
                {busy ? "Checking…" : "Turn off"}
              </button>
            </div>
          </>
        )}

        {error && (stage.kind === "loading" || stage.kind === "off") && (
          <div className="error-text">{error}</div>
        )}
      </div>
    </div>
  );
}
