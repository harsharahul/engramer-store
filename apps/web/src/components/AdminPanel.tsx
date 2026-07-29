import { useCallback, useEffect, useState } from "react";
import { api, type AdminInviteInfo, type AdminUserInfo } from "../api";
import { formatBytes } from "../format";

/**
 * Operator surface: accounts and invites. Everything here is server-visible
 * bookkeeping (emails, usage, status); no vault content is reachable, and
 * there is deliberately no password reset because the server holds no key
 * material; the recovery key is the only way back into an account.
 */
export function AdminPanel(props: { onClose: () => void; onToast: (message: string) => void }) {
  const [tab, setTab] = useState<"users" | "invites">("users");
  const [users, setUsers] = useState<AdminUserInfo[]>([]);
  const [registration, setRegistration] = useState<string>("open");
  const [invites, setInvites] = useState<AdminInviteInfo[]>([]);
  const [confirmDelete, setConfirmDelete] = useState<AdminUserInfo | null>(null);
  const [quotaEdit, setQuotaEdit] = useState<{ id: number; gb: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [userList, inviteList] = await Promise.all([api.adminListUsers(), api.adminListInvites()]);
      setUsers(userList.users);
      setRegistration(userList.registration);
      setInvites(inviteList.invites);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not load");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const act = async (run: () => Promise<unknown>, done?: string) => {
    try {
      await run();
      await refresh();
      if (done) {
        props.onToast(done);
      }
    } catch (err) {
      props.onToast(err instanceof Error ? err.message : "that did not work");
    }
  };

  const mintInvite = () =>
    act(async () => {
      const { token } = await api.adminCreateInvite();
      const url = `${location.origin}/?invite=${token}`;
      await navigator.clipboard.writeText(url).catch(() => {});
      props.onToast("Invite link copied. It works once and expires in 7 days.");
    });

  const pending = invites.filter((invite) => !invite.used);

  return (
    <div className="overlay" onClick={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="modal modal-wide">
        <h2>Server administration</h2>
        <p className="modal-sub">
          Registration is <b>{registration}</b>. Accounts are end-to-end encrypted: you can manage
          access and quotas here, but no one, including you, can read a vault or reset its password.
        </p>
        <div className="tab-row">
          <button className={tab === "users" ? "btn btn-primary" : "btn"} onClick={() => setTab("users")}>
            Accounts ({users.length})
          </button>
          <button
            className={tab === "invites" ? "btn btn-primary" : "btn"}
            onClick={() => setTab("invites")}
          >
            Invites ({pending.length})
          </button>
        </div>
        {error && <div className="error-text">{error}</div>}

        {tab === "users" && (
          <div className="admin-list">
            {users.map((user) => (
              <div key={user.id} className="admin-row">
                <div className="admin-row-main">
                  <b>{user.email}</b>
                  <span className="admin-badges">
                    {user.isAdmin && <span className="badge">admin</span>}
                    {user.totpEnabled && <span className="badge">2FA</span>}
                    {user.disabled && <span className="badge badge-warn">disabled</span>}
                  </span>
                  <div className="admin-row-sub">
                    {formatBytes(user.usedBytes)} of {formatBytes(user.quotaBytes)}
                    {user.quotaOverride ? " (custom quota)" : ""}
                  </div>
                </div>
                {!user.isAdmin && (
                  <div className="admin-row-actions">
                    {quotaEdit?.id === user.id ? (
                      <>
                        <input
                          className="quota-input"
                          inputMode="numeric"
                          value={quotaEdit.gb}
                          onChange={(e) => setQuotaEdit({ id: user.id, gb: e.target.value })}
                          placeholder="GB"
                        />
                        <button
                          className="btn"
                          onClick={() => {
                            const gb = Number(quotaEdit.gb);
                            const bytes = Number.isFinite(gb) && gb > 0 ? Math.round(gb * 1024 ** 3) : null;
                            setQuotaEdit(null);
                            void act(() => api.adminSetQuota(user.id, bytes), "Quota updated.");
                          }}
                        >
                          Set
                        </button>
                      </>
                    ) : (
                      <button className="btn" onClick={() => setQuotaEdit({ id: user.id, gb: "" })}>
                        Quota
                      </button>
                    )}
                    <button
                      className="btn"
                      onClick={() =>
                        void act(
                          () => api.adminSetDisabled(user.id, !user.disabled),
                          user.disabled ? "Account enabled." : "Account disabled.",
                        )
                      }
                    >
                      {user.disabled ? "Enable" : "Disable"}
                    </button>
                    <button className="btn btn-danger" onClick={() => setConfirmDelete(user)}>
                      Delete
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {tab === "invites" && (
          <div className="admin-list">
            <button className="btn btn-primary" onClick={() => void mintInvite()}>
              New invite link
            </button>
            {pending.length === 0 && <p className="modal-sub">No pending invites.</p>}
            {pending.map((invite) => (
              <div key={invite.token} className="admin-row">
                <div className="admin-row-main">
                  <code>{invite.token.slice(0, 8)}…</code>
                  <div className="admin-row-sub">
                    {invite.expiresAt
                      ? `expires ${new Date(invite.expiresAt).toLocaleDateString()}`
                      : "never expires"}
                  </div>
                </div>
                <div className="admin-row-actions">
                  <button
                    className="btn"
                    onClick={() => {
                      void navigator.clipboard.writeText(`${location.origin}/?invite=${invite.token}`);
                      props.onToast("Invite link copied.");
                    }}
                  >
                    Copy link
                  </button>
                  <button
                    className="btn btn-danger"
                    onClick={() => void act(() => api.adminRevokeInvite(invite.token), "Invite revoked.")}
                  >
                    Revoke
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="modal-actions">
          <button className="btn" onClick={props.onClose}>
            Close
          </button>
        </div>
      </div>

      {confirmDelete && (
        <div className="overlay">
          <div className="modal">
            <h2>Delete {confirmDelete.email}?</h2>
            <p className="modal-sub">
              This permanently removes the account and every encrypted file it stores (
              {formatBytes(confirmDelete.usedBytes)}). There is no undo.
            </p>
            <div className="modal-actions">
              <button className="btn" onClick={() => setConfirmDelete(null)}>
                Cancel
              </button>
              <button
                className="btn btn-danger"
                onClick={() => {
                  const target = confirmDelete;
                  setConfirmDelete(null);
                  void act(() => api.adminDeleteUser(target.id), "Account deleted.");
                }}
              >
                Delete forever
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
