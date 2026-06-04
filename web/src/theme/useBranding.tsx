import { createContext, useCallback, useContext, useEffect, useMemo, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { BRANDING_QUERY_KEY, useBranding as useBrandingQuery } from "../api/hooks";
import { useEventStream, type SettingsUpdatedPayload, type StreamEnvelope } from "../realtime/useEventStream";
import {
  ACCENT_KEY,
  applyAccent,
  DEFAULT_ACCENT,
  DEFAULT_INSTANCE_NAME,
  INSTANCE_KEY,
  readStored,
  writeStored,
} from "./theme";

// ─────────────────────────────────────────────────────────────────────────────
// Branding context — fetches the resolved instance branding (/settings/branding)
// and applies it app-wide: the accent color becomes inline --accent* overrides
// on <html> (a custom color wins over the per-theme accent tuning), and the
// instance name drives the sidebar wordmark + document title.
//
// The fetched values are cached to localStorage so the no-flash inline script in
// index.html can apply the brand on the very next load before React mounts.
//
// A 'settings.updated' SSE event (an admin changed branding) invalidates the
// query, so every open dashboard re-brands live without a refresh.
// ─────────────────────────────────────────────────────────────────────────────

interface BrandingContextValue {
  instanceName: string;
  accentColor: string;
  /** True while the first fetch is in flight (values fall back to cache/default). */
  isLoading: boolean;
}

const BrandingContext = createContext<BrandingContextValue | null>(null);

export function BrandingProvider({ children }: { children: ReactNode }) {
  const query = useBrandingQuery();
  const qc = useQueryClient();

  // Fall back to the cached values (then built-ins) until the fetch resolves, so
  // the wordmark/title never flash "DiffSentry" → custom on a branded instance.
  const instanceName = query.data?.instanceName ?? readStored(INSTANCE_KEY) ?? DEFAULT_INSTANCE_NAME;
  const accentColor = query.data?.accentColor ?? readStored(ACCENT_KEY) ?? DEFAULT_ACCENT;

  // Apply accent + title + refresh the no-flash cache whenever branding changes.
  useEffect(() => {
    applyAccent(accentColor);
    if (typeof document !== "undefined") document.title = instanceName;
    writeStored(ACCENT_KEY, accentColor);
    writeStored(INSTANCE_KEY, instanceName);
  }, [accentColor, instanceName]);

  // Live re-brand: an admin's change publishes settings.updated on the bus.
  const onEvent = useCallback(
    (env: StreamEnvelope) => {
      if (env.topic !== "settings.updated") return;
      const p = env.payload as SettingsUpdatedPayload;
      qc.setQueryData(BRANDING_QUERY_KEY, { instanceName: p.instanceName, accentColor: p.accentColor });
    },
    [qc],
  );
  useEventStream(onEvent);

  const value = useMemo<BrandingContextValue>(
    () => ({ instanceName, accentColor, isLoading: query.isPending }),
    [instanceName, accentColor, query.isPending],
  );

  return <BrandingContext.Provider value={value}>{children}</BrandingContext.Provider>;
}

export function useInstanceBranding(): BrandingContextValue {
  const ctx = useContext(BrandingContext);
  if (!ctx) throw new Error("useInstanceBranding must be used within <BrandingProvider>");
  return ctx;
}
