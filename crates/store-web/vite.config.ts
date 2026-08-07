import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";

// The build output is embedded into `store-server` (see crates/store-server/
// src/web.rs), so the whole product ships as one binary on one port. The door
// terminal is configured with a single server address; asking a shop to open a
// second one is a support call waiting to happen.
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    // The service worker is how a new build reaches every phone and tablet:
    // no signing key to lose, no store review, nobody walking the shop floor
    // with a USB stick. `prompt` rather than `autoUpdate` because reloading
    // under an operator halfway through an issue would lose their typing.
    VitePWA({
      registerType: "prompt",
      injectRegister: null,
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,ico,webmanifest}"],
        // The API is never cached. A stale on-hand figure is worse than no
        // figure — §7's whole point is that the ledger is the truth.
        navigateFallbackDenylist: [/^\/api\//, /^\/iclock\//, /^\/health/],
        cleanupOutdatedCaches: true,
      },
      manifest: {
        name: "ElectronIx Tool Store",
        short_name: "Tool Store",
        description: "Tool-crib issue and receipt terminal",
        theme_color: "#0f172a",
        background_color: "#020617",
        display: "standalone",
        orientation: "any",
        start_url: "/",
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
          {
            src: "/icon-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
    }),
  ],
  build: {
    outDir: "dist",
    // Hashed filenames are what make the service worker's cache safe to keep
    // forever: a new build is a new URL, so a phone can never serve stale JS
    // against a new API.
    assetsInlineLimit: 0,
    sourcemap: true,
  },
  server: {
    port: 5173,
    // `npm run dev` talks to a store-server on the same machine.
    proxy: {
      "/api": { target: "http://127.0.0.1:8080", changeOrigin: true },
      "/health": { target: "http://127.0.0.1:8080", changeOrigin: true },
    },
  },
});
