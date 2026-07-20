import { useEffect, useState } from "react";
import { Route, Routes } from "react-router-dom";
import { setUnauthorizedHandler } from "./api";
import { restoreSession } from "./session";
import { useStore } from "./store";
import { Auth } from "./components/Auth";
import { Vault } from "./components/Vault";
import { ShareView } from "./components/ShareView";

export function App() {
  const session = useStore((s) => s.session);
  const startSession = useStore((s) => s.startSession);
  const logout = useStore((s) => s.logout);
  const [booting, setBooting] = useState(true);

  useEffect(() => {
    setUnauthorizedHandler(() => logout());
    void restoreSession()
      .then(async (restored) => {
        if (restored) {
          await startSession(restored);
        }
      })
      .finally(() => setBooting(false));
  }, [startSession, logout]);

  return (
    <Routes>
      <Route path="/s/:token" element={<ShareView />} />
      <Route
        path="*"
        element={
          booting ? (
            <div className="auth-shell">
              <div className="spinner" />
            </div>
          ) : session ? (
            <Vault />
          ) : (
            <Auth />
          )
        }
      />
    </Routes>
  );
}
