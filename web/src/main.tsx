import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "react-router-dom";
import { router } from "./router";
import { AuthProvider } from "./auth/useAuth";
import { EventStreamProvider } from "./realtime/useEventStream";
import { ToastProvider } from "./realtime/toast";
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
    },
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <EventStreamProvider>
            <BrandingProvider>
              <ToastProvider>
                <RouterProvider router={router} />
              </ToastProvider>
            </BrandingProvider>
          </EventStreamProvider>
        </AuthProvider>
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
);
