import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "react-router-dom";
import { router } from "./router";
import { AuthProvider } from "./auth/useAuth";
import { EventStreamProvider } from "./realtime/useEventStream";
import { ToastProvider } from "./realtime/toast";
import { PWAProvider } from "./pwa/usePWA";
import { PWAPrompts } from "./pwa/PWAPrompts";
import { initPersistence } from "./lib/persist";
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

// Prime the persisted query cache before first paint. When offline at boot it
// hydrates last-viewed data immediately; when online it defers hydration until
// /me verifies the cache owner (see lib/persist.ts), so one user's cached data
// is never shown to another on a shared device.
async function bootstrap() {
  await initPersistence(queryClient);

  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <PWAProvider>
          <AuthProvider>
            <EventStreamProvider>
              <ToastProvider>
                <RouterProvider router={router} />
                <PWAPrompts />
              </ToastProvider>
            </EventStreamProvider>
          </AuthProvider>
        </PWAProvider>
      </QueryClientProvider>
    </StrictMode>,
  );
}

void bootstrap();
