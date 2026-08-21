import { useEffect, useState } from "react";
import { Route, Routes } from "react-router";
import { setUnauthorizedHandler } from "./api";
import { restoreSession } from "./session";
import { hasDeviceUnlock } from "./unlock";
import { useStore } from "./store";
import { Auth } from "./components/Auth";
import { diag } from "./diag";
import { UnlockGate } from "./components/UnlockGate";
import { Vault } from "./components/Vault";
import { ShareView } from "./components/ShareView";
import { RequestView } from "./components/RequestView";
import { CollabInviteView } from "./components/CollabInviteView";

export function App() {
  const session = useStore((s) => s.session);
  const startSession = useStore((s) => s.startSession);
  const logout = useStore((s) => s.logout);
  const [booting, setBooting] = useState(true);
  // Chosen on the unlock gate: the password form instead of the passkey.
  // Forgotten once a session starts, so the next lock offers the gate again.
  const [usePassword, setUsePassword] = useState(false);
  useEffect(() => {
    if (session) {
      setUsePassword(false);
    }
  }, [session]);

  useEffect(() => {
    // Why this page is here at all. "It went back to the start" reads the
    // same whether React remounted or the whole web view reloaded under
    // it, and only one of those is a bug in this code.
    const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    diag("app", `page loaded by ${nav?.type ?? "unknown"}`);

    setUnauthorizedHandler(() => logout());
    void restoreSession()
      .then(async (restored) => {
        if (restored) {
          await startSession(restored);
        }
        // Otherwise the render below offers the passkey gate where this
        // device holds a wrapped session, and the password form elsewhere.
      })
      .finally(() => setBooting(false));

    // Back/forward-cache restores resume the page with whatever fetches the
    // freeze killed; a clean reload puts the state machine back on rails.
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) {
        diag("app", "restored from the back/forward cache; reloading");
        location.reload();
      }
    };
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, [startSession, logout]);

  return (
    <Routes>
      <Route path="/s/:token" element={<ShareView />} />
      <Route path="/r/:token" element={<RequestView />} />
      <Route path="/c/:token" element={<CollabInviteView />} />
      <Route
        path="*"
        element={
          booting ? (
            <div className="auth-shell">
              <div className="spinner" />
            </div>
          ) : session ? (
            <Vault />
          ) : hasDeviceUnlock() && !usePassword ? (
            // Re-checked each render: a lock keeps the record and gets the
            // gate, a sign-out purges it and the gate falls away with it.
            <UnlockGate onUsePassword={() => setUsePassword(true)} />
          ) : (
            <Auth />
          )
        }
      />
    </Routes>
  );
}
