/**
 * Shows a recovery key once, with a copy button. The same panel serves
 * signup (first display), and the profile's view and rotate actions, so
 * the key is always presented the same way.
 */
export function RecoveryKeyModal(props: {
  recoveryKeyHex: string;
  title: string;
  sub: string;
  confirmLabel: string;
  onClose: () => void;
  busy?: boolean;
}) {
  return (
    <div className="overlay">
      <div className="modal">
        <h2>{props.title}</h2>
        <p className="modal-sub">{props.sub}</p>
        <div className="recovery-key">{props.recoveryKeyHex}</div>
        <div className="modal-actions">
          <button
            className="btn"
            onClick={() => void navigator.clipboard.writeText(props.recoveryKeyHex)}
          >
            Copy
          </button>
          <button className="btn btn-primary" onClick={props.onClose} disabled={props.busy}>
            {props.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
