import { useState } from "react";
import { useNavigate, useParams } from "react-router";
import { ApiError, api } from "../api";
import { useStore } from "../store";
import { Auth } from "./Auth";
import { BrandMark } from "./FileArt";

/**
 * The claim side of an account-to-account share. The link conveys identity
 * only, never a key: claiming records this account as the recipient, and
 * the owner's client releases the file key on its next sync. Claiming needs
 * a signed-in account, so a visitor sees the ordinary sign-in first and the
 * invitation right after.
 */
export function CollabInviteView() {
  const { token } = useParams<{ token: string }>();
  const session = useStore((s) => s.session);
  const navigate = useNavigate();
  const [state, setState] = useState<
    | { phase: "offered" }
    | { phase: "claiming" }
    | { phase: "claimed"; ownerEmail: string; role: "viewer" | "editor" }
    | { phase: "gone" }
  >({ phase: "offered" });

  if (!session) {
    return <Auth />;
  }

  const claim = async () => {
    if (!token) {
      setState({ phase: "gone" });
      return;
    }
    setState({ phase: "claiming" });
    try {
      const result = await api.claimCollabInvite(token);
      setState({ phase: "claimed", ownerEmail: result.ownerEmail, role: result.role });
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        setState({ phase: "offered" });
        return;
      }
      setState({ phase: "gone" });
    }
  };

  return (
    <div className="share-shell">
      <div className="share-card">
        <BrandMark size={40} />
        {state.phase === "gone" ? (
          <>
            <h1>Nothing here</h1>
            <p className="sub">This invitation is no longer available.</p>
          </>
        ) : state.phase === "claimed" ? (
          <>
            <h1>Invitation accepted</h1>
            <p className="sub">
              {state.ownerEmail} is sharing a document with you
              {state.role === "editor" ? " to edit" : " to view"}. It appears in{" "}
              <strong>Shared with me</strong> as soon as they release the key, which their
              vault does automatically the next time it is open.
            </p>
            <button className="btn btn-primary" onClick={() => navigate("/")}>
              Open your vault
            </button>
          </>
        ) : (
          <>
            <h1>You are invited</h1>
            <p className="sub">
              Someone is sharing a document with this account. Accepting tells them who you
              are ({session.email}); the document itself stays sealed until they release
              its key to you.
            </p>
            <button
              className="btn btn-primary"
              disabled={state.phase === "claiming"}
              onClick={() => void claim()}
            >
              {state.phase === "claiming" ? "Accepting…" : "Accept the invitation"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
