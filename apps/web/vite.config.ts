import { cpSync, existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

const require = createRequire(import.meta.url);

/**
 * The release this bundle came from, compiled in so the running client can
 * say which one it is. A version you have to infer from the server is no use
 * when the question is whether the page in front of you is the new one.
 */
const version: string = require("./package.json").version;

/**
 * Serves the OCR runtime (tesseract worker + wasm cores) under /ocr with
 * stable, unhashed names: the wasm.js loaders resolve their .wasm siblings by
 * original filename, so they cannot go through hashed asset imports. The
 * language model lives in public/ocr; everything is same-origin, no CDN.
 */
function ocrAssets(): Plugin {
  const workerDir = dirname(require.resolve("tesseract.js/dist/worker.min.js"));
  const coreDir = dirname(require.resolve("tesseract.js-core/package.json"));
  const cores = [
    "tesseract-core-relaxedsimd-lstm", // preferred by current Chromium
    "tesseract-core-simd-lstm",
    "tesseract-core-lstm", // no-SIMD fallback
  ];
  const files = [
    { from: join(workerDir, "worker.min.js"), name: "worker.min.js" },
    ...cores.flatMap((core) => [
      { from: join(coreDir, `${core}.wasm.js`), name: `${core}.wasm.js` },
      { from: join(coreDir, `${core}.wasm`), name: `${core}.wasm` },
    ]),
  ];
  let outDir = "dist";
  let isBuild = false;
  return {
    name: "engram-ocr-assets",
    configResolved(config) {
      outDir = config.build.outDir;
      // Vitest also loads this config, with a placeholder outDir; only a real
      // build should stage assets.
      isBuild = config.command === "build" && !process.env.VITEST;
    },
    closeBundle() {
      if (!isBuild) {
        return;
      }
      const target = join(outDir, "ocr");
      mkdirSync(target, { recursive: true });
      for (const file of files) {
        if (existsSync(file.from)) {
          cpSync(file.from, join(target, file.name));
        }
      }
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        // Dev-only: Vite tags dynamic imports with ?import, so match the path.
        const path = (req.url ?? "").split("?")[0];
        const hit = files.find((f) => path === `/ocr/${f.name}`);
        if (!hit) {
          return next();
        }
        res.setHeader(
          "content-type",
          hit.name.endsWith(".wasm") ? "application/wasm" : "text/javascript",
        );
        res.end(require("node:fs").readFileSync(hit.from));
      });
    },
  };
}

/**
 * Serves the onnxruntime-web runtime under /ort so the semantic search
 * worker never reaches for a CDN: transformers.js is pointed at this path
 * and the strict CSP would refuse anything else anyway.
 */
function ortAssets(): Plugin {
  // Exports maps hide package.json; resolve entry points and walk from there.
  const transformersEntry = require.resolve("@huggingface/transformers");
  const ortEntry = require.resolve("onnxruntime-web", { paths: [dirname(transformersEntry)] });
  const ortDist = dirname(ortEntry);
  const names = [
    "ort-wasm-simd-threaded.asyncify.mjs",
    "ort-wasm-simd-threaded.asyncify.wasm",
    "ort-wasm-simd-threaded.mjs",
    "ort-wasm-simd-threaded.wasm",
  ];
  const files = names.map((name) => ({ from: join(ortDist, name), name }));
  let outDir = "dist";
  let isBuild = false;
  return {
    name: "engram-ort-assets",
    configResolved(config) {
      outDir = config.build.outDir;
      isBuild = config.command === "build" && !process.env.VITEST;
    },
    closeBundle() {
      if (!isBuild) {
        return;
      }
      const target = join(outDir, "ort");
      mkdirSync(target, { recursive: true });
      for (const file of files) {
        if (existsSync(file.from)) {
          cpSync(file.from, join(target, file.name));
        }
      }
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        // Dev-only: Vite tags dynamic imports with ?import, so match the path.
        const path = (req.url ?? "").split("?")[0];
        const hit = files.find((f) => path === `/ort/${f.name}`);
        if (!hit) {
          return next();
        }
        res.setHeader(
          "content-type",
          hit.name.endsWith(".wasm") ? "application/wasm" : "text/javascript",
        );
        res.end(require("node:fs").readFileSync(hit.from));
      });
    },
  };
}

/**
 * Writes the version the deployment is serving, for a running client to
 * compare itself against. Small and uncached on purpose: it is the one file
 * that must never be answered from a cache, or a client will believe it is
 * current forever. Served in development too, so the check is exercised
 * there rather than only in production.
 */
function versionFile(): Plugin {
  const body = `${JSON.stringify({ version }, null, 2)}\n`;
  let outDir = "dist";
  let isBuild = false;
  return {
    name: "engram-version-file",
    configResolved(config) {
      outDir = config.build.outDir;
      isBuild = config.command === "build" && !process.env.VITEST;
    },
    closeBundle() {
      if (isBuild) {
        require("node:fs").writeFileSync(join(outDir, "version.json"), body);
      }
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if ((req.url ?? "").split("?")[0] !== "/version.json") {
          return next();
        }
        res.setHeader("content-type", "application/json");
        res.setHeader("cache-control", "no-store");
        res.end(body);
      });
    },
  };
}

/**
 * Development mirror of the headers the server sends for the office editor.
 * That editor is framed with an opaque origin, so its own assets are
 * cross-origin to it and its fetches carry a null origin; without these,
 * the editor loads and then fails on its first locale fetch.
 *
 * The content policy is mirrored too, because it is the one header whose
 * absence in development has repeatedly hidden a failure until production:
 * every source below has to name the host explicitly, since 'self' resolves
 * through the frame's own origin and an opaque origin matches nothing.
 * Production sends the same policy, scoped to the same prefix, and
 * apps/server/src/app.ts is its source of truth; these two must agree.
 */
function officeDevHeaders(): Plugin {
  const officeCsp = (host: string): string => {
    const self = `https://${host} http://${host}`;
    return [
      `default-src ${self}`,
      `script-src ${self} 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'`,
      `worker-src ${self} blob:`,
      `connect-src ${self} blob:`,
      `img-src ${self} blob: data:`,
      `media-src ${self} blob:`,
      `font-src ${self} data:`,
      `style-src ${self} 'unsafe-inline'`,
      `frame-src ${self} blob:`,
      "object-src 'none'",
      `base-uri ${self}`,
      "form-action 'none'",
      "frame-ancestors 'self'",
    ].join("; ");
  };
  return {
    name: "engram-office-dev-headers",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if ((req.url ?? "").startsWith("/office/")) {
          res.setHeader("access-control-allow-origin", "*");
          res.setHeader("cross-origin-resource-policy", "cross-origin");
          res.setHeader("content-security-policy", officeCsp(req.headers.host ?? "localhost:5173"));
        }
        next();
      });
    },
  };
}

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(version) },
  plugins: [
    react(),
    officeDevHeaders(),
    versionFile(),
    ocrAssets(),
    ortAssets(),
    VitePWA({
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      registerType: "autoUpdate",
      includeAssets: ["icon.svg", "apple-touch-icon.png"],
      manifest: {
        name: "Engram Store",
        short_name: "Engram",
        description: "Private, encrypted, yours. End-to-end encrypted cloud storage.",
        theme_color: "#0a0e1a",
        background_color: "#0a0e1a",
        display: "standalone",
        orientation: "any",
        start_url: "/",
        scope: "/",
        categories: ["productivity", "utilities"],
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      injectManifest: {
        // The worker registers as a classic script; the bundle must be too.
        rollupFormat: "iife",
        // App shell only. Encrypted blobs and API responses are never cached:
        // ciphertext belongs on the server, plaintext belongs in memory.
        // Navigation fallback and the media bridge live in src/sw.ts.
        globPatterns: ["**/*.{js,css,html,woff2,svg,png}"],
        // The OCR runtime and language model are megabytes and fetched only
        // when OCR actually runs; they never belong in the app-shell cache.
        // The office editors are hundreds of megabytes fetched only when a
        // document is opened; they belong to the HTTP cache, never the
        // app-shell precache.
        globIgnores: ["ocr/**", "models/**", "ort/**", "office/**", "version.json"],
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
      },
    }),
  ],
  optimizeDeps: {
    include: ["libsodium-wrappers-sumo"],
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:3080",
    },
  },
});
