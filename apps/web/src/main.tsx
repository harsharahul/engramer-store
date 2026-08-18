import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "./styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { App } from "./App";
import { ocrEnabled } from "./intel/ocr";
import { semanticEnabled } from "./intel/semantic";
import { warmList } from "./runtimeassets";
import { APP_VERSION } from "./version";
import { trackViewportHeight } from "./viewport";

// Named once, on purpose: a console log captured from a browser should say
// which build produced it, and this app can be running an older one than the
// server has, through the service worker or the desktop shell.
console.log(`Engram Store ${APP_VERSION}`);

// Before first paint, so the layout is sized from a measured height rather
// than whatever the browser reported while it was still settling.
trackViewportHeight();

// Ask the service worker to prefetch the ML runtimes the enabled features
// will load, so the first upload of a session starts warm instead of
// waiting on a tens-of-megabytes download. Best-effort by design.
const runtimeWarmups = warmList({ semantic: semanticEnabled(), ocr: ocrEnabled() });
if (runtimeWarmups.length > 0 && "serviceWorker" in navigator) {
  void navigator.serviceWorker.ready
    .then((registration) => {
      registration.active?.postMessage({ type: "warm-runtimes", urls: runtimeWarmups });
    })
    .catch(() => {});
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
