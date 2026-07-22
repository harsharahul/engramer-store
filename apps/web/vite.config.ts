import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
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
      workbox: {
        // App shell only. Encrypted blobs and API responses are never cached:
        // ciphertext belongs on the server, plaintext belongs in memory.
        globPatterns: ["**/*.{js,css,html,woff2,svg,png}"],
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [],
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
