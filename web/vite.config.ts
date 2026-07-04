import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import path from "node:path";

// The SPA is served by the same Express process in production (static files
// out of web/dist). In dev we run Vite on its own port and proxy /api to the
// backend on 3005 so the single-origin cookie/session model still works.
export default defineConfig(() => {
  const forceDemo = process.env.VITE_FORCE_DEMO === "true";
  return {
    define: {
      "import.meta.env.VITE_FORCE_DEMO": JSON.stringify(process.env.VITE_FORCE_DEMO ?? ""),
    },
    plugins: [
      react(),
      // PWA: installable + offline app shell. The service worker precaches the
      // built shell (JS/CSS/HTML/icons) and the Google Fonts it depends on, and
      // falls back to the cached index.html for offline navigations.
      //
      // SECURITY: we deliberately register NO runtime-caching rule for /api, so
      // authenticated JSON responses are never written to the Cache Storage that
      // persists across sessions/users on a shared device. Offline "last-viewed
      // data" is instead handled in-app by a user-scoped, logout-purged
      // TanStack Query persister (see src/lib/persist.ts) — not the SW.
      VitePWA({
        disable: forceDemo, // no service worker in the public demo build
        // Surface an explicit "update available" prompt instead of silently
        // reloading — this is a command center where a reload could interrupt a
        // privileged action mid-flight. We register the SW ourselves so we can
        // drive that prompt (see src/pwa/registerSW.ts).
        registerType: "prompt",
        injectRegister: null,
        includeAssets: ["favicon.svg", "apple-touch-icon.png"],
        manifest: {
          name: "DiffSentry Command Center",
          short_name: "DiffSentry",
          description: "Self-hosted AI PR review — review ops dashboard.",
          id: "/",
          start_url: "/",
          scope: "/",
          display: "standalone",
          orientation: "any",
          background_color: "#0a0c13",
          theme_color: "#0a0c13",
          categories: ["developer", "productivity"],
          icons: [
            { src: "icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
            { src: "icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
            { src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
            { src: "maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
          ],
        },
        workbox: {
          globPatterns: ["**/*.{js,css,html,svg,png,ico,woff,woff2}"],
          cleanupOutdatedCaches: true,
          clientsClaim: true,
          // Offline navigations serve the cached app shell. Never hand the SPA
          // shell to the API, the webhook, the legacy dashboard, the SSE stream,
          // or the health check — those must always hit the network.
          navigateFallback: "/index.html",
          navigateFallbackDenylist: [/^\/api/, /^\/webhook/, /^\/dashboard/, /^\/health/, /^\/stream/],
          runtimeCaching: [
            {
              urlPattern: ({ url }) => url.origin === "https://fonts.googleapis.com",
              handler: "StaleWhileRevalidate",
              options: { cacheName: "google-fonts-stylesheets" },
            },
            {
              urlPattern: ({ url }) => url.origin === "https://fonts.gstatic.com",
              handler: "CacheFirst",
              options: {
                cacheName: "google-fonts-webfonts",
                expiration: { maxEntries: 16, maxAgeSeconds: 60 * 60 * 24 * 365 },
                cacheableResponse: { statuses: [0, 200] },
              },
            },
          ],
        },
        // Keep the SW out of `vite dev` so local development isn't fighting a
        // cache; it builds and runs only in production (`npm run build`).
        devOptions: { enabled: false },
      }),
    ],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },
    server: {
      port: 5174,
      proxy: {
        "/api": {
          target: "http://localhost:3005",
          changeOrigin: true,
        },
      },
    },
    build: {
      outDir: "dist",
      sourcemap: false,
    },
  };
});
