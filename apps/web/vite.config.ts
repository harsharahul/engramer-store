import { cpSync, existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

const require = createRequire(import.meta.url);

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
        const hit = files.find((f) => req.url === `/ocr/${f.name}`);
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

export default defineConfig({
  plugins: [
    react(),
    ocrAssets(),
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
        globIgnores: ["ocr/**"],
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
