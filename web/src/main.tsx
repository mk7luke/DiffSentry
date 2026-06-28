import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "react-router-dom";
import { router } from "./router";
import { DEMO, DEMO_BASENAME, demoPathActive } from "./demo/mode";
import { AuthProvider } from "./auth/useAuth";
import { EventStreamProvider } from "./realtime/useEventStream";
import { ToastProvider } from "./realtime/toast";
import { PWAProvider } from "./pwa/usePWA";
import { PWAPrompts } from "./pwa/PWAPrompts";
import { initPersistence } from "./lib/persist";
import { ThemeProvider } from "./theme/useTheme";
import { BrandingProvider } from "./theme/useBranding";
import "./styles/tokens.css";
import "./styles/base.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
      refetchOnWindowFocus: false,
      // Offline: keep cached data usable for a day so a cold PWA launch can
      // paint last-viewed data (see lib/persist.ts) before the network returns.
      gcTime: 1000 * 60 * 60 * 24,
    },
  },
});

// Prime the persisted query cache before first paint. Restore is deferred:
// the cached data is only hydrated once /me verifies the owner (see
// lib/persist.ts), so one user's cached data is never shown to another — and
// authed data is never rendered offline without a verified session.
async function bootstrap() {
  // Demo via ?demo=true on some other path → bounce to the canonical /demo
  // route so React Router's basename stays consistent. Preserve the current
  // route (path + non-demo query + hash) under /demo so a deep link like
  // /repos/acme/checkout-api/pr/142?demo=true lands on the analogous demo page
  // rather than the demo root. Abort this render; the redirect reloads under /demo.
  if (DEMO && !demoPathActive()) {
    const query = new URLSearchParams(window.location.search);
    query.delete("demo");
    const qs = query.toString();
    const suffix = `${window.location.pathname}${qs ? `?${qs}` : ""}${window.location.hash}`;
    // "/" carries no useful route, so drop it (avoids a redundant "/demo/").
    window.location.replace(`${DEMO_BASENAME}${suffix === "/" ? "" : suffix}`);
    return;
  }

  // The offline persisted cache is owner-scoped, real-session data — never
  // hydrate or write it in demo mode, where the only data is fixtures.
  if (!DEMO) await initPersistence(queryClient);

  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <PWAProvider>
            <AuthProvider>
              <EventStreamProvider>
                <BrandingProvider>
                  <ToastProvider>
                    <RouterProvider router={router} />
                    <PWAPrompts />
                  </ToastProvider>
                </BrandingProvider>
              </EventStreamProvider>
            </AuthProvider>
          </PWAProvider>
        </QueryClientProvider>
      </ThemeProvider>
    </StrictMode>,
  );
}

void bootstrap();
