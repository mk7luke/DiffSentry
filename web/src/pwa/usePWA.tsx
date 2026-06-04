import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { registerSW } from "virtual:pwa-register";

// ─────────────────────────────────────────────────────────────────────────────
// usePWA — service-worker lifecycle + connectivity state for the whole app.
//
// One <PWAProvider> registers the service worker (registerType: "prompt", so we
// drive the update flow ourselves) and tracks online/offline. Components read:
//   • offline        — navigator is currently offline
//   • needRefresh     — a new SW is waiting; call applyUpdate() to activate+reload
//   • offlineReady    — the app shell is cached and ready to work offline
//   • applyUpdate()   — activate the waiting SW and reload
//   • dismissUpdate() — hide the update prompt without reloading
// ─────────────────────────────────────────────────────────────────────────────

interface PWAState {
  offline: boolean;
  needRefresh: boolean;
  offlineReady: boolean;
  applyUpdate: () => void;
  dismissUpdate: () => void;
  dismissOfflineReady: () => void;
}

const PWAContext = createContext<PWAState | null>(null);

export function PWAProvider({ children }: { children: ReactNode }) {
  const [offline, setOffline] = useState(() => typeof navigator !== "undefined" && !navigator.onLine);
  const [needRefresh, setNeedRefresh] = useState(false);
  const [offlineReady, setOfflineReady] = useState(false);
  // updateSW(true) tells the waiting worker to skipWaiting, then reloads once it
  // takes control. Held in a ref because it's created once at registration.
  const updateSW = useRef<(reload?: boolean) => Promise<void>>(() => Promise.resolve());

  useEffect(() => {
    updateSW.current = registerSW({
      onNeedRefresh() {
        setNeedRefresh(true);
      },
      onOfflineReady() {
        setOfflineReady(true);
      },
    });
  }, []);

  useEffect(() => {
    const goOnline = () => setOffline(false);
    const goOffline = () => setOffline(true);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  const applyUpdate = useCallback(() => {
    setNeedRefresh(false);
    void updateSW.current(true);
  }, []);

  const dismissUpdate = useCallback(() => setNeedRefresh(false), []);
  const dismissOfflineReady = useCallback(() => setOfflineReady(false), []);

  return (
    <PWAContext.Provider
      value={{ offline, needRefresh, offlineReady, applyUpdate, dismissUpdate, dismissOfflineReady }}
    >
      {children}
    </PWAContext.Provider>
  );
}

export function usePWA(): PWAState {
  const ctx = useContext(PWAContext);
  if (!ctx) throw new Error("usePWA must be used within <PWAProvider>");
  return ctx;
}
