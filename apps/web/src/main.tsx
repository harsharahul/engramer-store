import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "./styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { App } from "./App";
import { APP_VERSION } from "./version";
import { trackViewportHeight } from "./viewport";

// Named once, on purpose: a console log captured from a browser should say
// which build produced it, and this app can be running an older one than the
// server has, through the service worker or the desktop shell.
console.log(`Engram Store ${APP_VERSION}`);

// Before first paint, so the layout is sized from a measured height rather
// than whatever the browser reported while it was still settling.
trackViewportHeight();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
