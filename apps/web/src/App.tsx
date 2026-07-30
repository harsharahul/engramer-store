import { useEffect, useState } from "react";
import { Route, Routes } from "react-router";
import { setUnauthorizedHandler } from "./api";
import { restoreSession } from "./session";
import { hasDeviceUnlock } from "./unlock";
import { useStore } from "./store";
import { Auth } from "./components/Auth";
import { UnlockGate } from "./components/UnlockGate";
import { Vault } from "./components/Vault";
import { ShareView } from "./components/ShareView";
import { RequestView } from "./components/RequestView";

export function App() {
  const session = useStore((s) => s.session);
  const startSession = useStore((s) => s.startSession);
  const logout = useStore((s) => s.logout);
  const [booting, setBooting] = useState(true);
  const [locked, setLocked] = useState(false);

  useEffect(() => {
    setUnauthorizedHandler(() => logout());
    void restoreSession()
      .then(async (restored) => {
        if (restored) {
          await startSession(restored);
        } else {
          // No live tab session, but this device may hold a passkey-wrapped
          // one: offer Touch ID before falling back to the password form.
          setLocked(hasDeviceUnlock());
        }
      })
      .finally(() => setBooting(false));

    // Back/forward-cache restores resume the page with whatever fetches the
    // freeze killed; a clean reload puts the state machine back on rails.
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) {
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
      <Route
        path="*"
        element={
          booting ? (
            <div className="auth-shell">
              <div className="spinner" />
            </div>
          ) : session ? (
            <Vault />
          ) : locked && hasDeviceUnlock() ? (
            // Re-checked each render: signing out purges the record, and the
            // gate must fall away with it.
            <UnlockGate onUsePassword={() => setLocked(false)} />
          ) : (
            <Auth />
          )
        }
      />
    </Routes>
  );
}
