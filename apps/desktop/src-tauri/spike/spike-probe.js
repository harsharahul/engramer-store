// Local-first spike probe. Served by the loopback listener next to the
// copied web client and injected into that copy's index.html; never part of
// the shipped client. Posts what only the page can observe to
// /api/spike/report, which the listener logs.
(function () {
  var violations = [];
  document.addEventListener("securitypolicyviolation", function (e) {
    violations.push(e.violatedDirective + " " + e.blockedURI);
  });
  async function report(phase) {
    var invoke = "no-bridge";
    if (window.__TAURI__ && window.__TAURI__.core) {
      try {
        invoke = JSON.stringify(await window.__TAURI__.core.invoke("network_status"));
      } catch (e) {
        invoke = "refused: " + String(e);
      }
    }
    var body = {
      phase: phase,
      origin: location.origin,
      tauri: typeof window.__TAURI__,
      invoke: invoke,
      controller: !!(navigator.serviceWorker && navigator.serviceWorker.controller),
      theme: document.documentElement.getAttribute("data-theme"),
      classes: document.documentElement.className,
      violations: violations
    };
    try {
      await fetch("/api/spike/report", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
    } catch (e) {}
  }
  window.addEventListener("load", function () { report("load"); });
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") { report("foreground"); }
  });
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.ready.then(function () {
      report("sw-ready");
      // The first visit is never controlled; one reload proves control.
      if (!navigator.serviceWorker.controller && !sessionStorage.getItem("spike-reloaded")) {
        sessionStorage.setItem("spike-reloaded", "1");
        setTimeout(function () { location.reload(); }, 1500);
      }
    });
  }
})();
