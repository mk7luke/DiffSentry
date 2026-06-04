import { useEffect } from "react";
import { usePWA } from "./usePWA";

// Bottom-left prompts driven by the service-worker lifecycle:
//   • "update available" — persistent until the user reloads or dismisses.
//   • "ready to work offline" — transient confirmation, auto-dismisses.
// Sits opposite the action toasts (bottom-right) so the two never overlap.
export function PWAPrompts() {
  const { needRefresh, offlineReady, applyUpdate, dismissUpdate, dismissOfflineReady } = usePWA();

  useEffect(() => {
    if (!offlineReady) return;
    const t = setTimeout(dismissOfflineReady, 5000);
    return () => clearTimeout(t);
  }, [offlineReady, dismissOfflineReady]);

  if (!needRefresh && !offlineReady) return null;

  return (
    <div className="pwa-prompt-viewport">
      {needRefresh ? (
        <div className="pwa-prompt" role="alert">
          <div className="pwa-prompt-text">
            <div className="pwa-prompt-title">Update available</div>
            <div className="pwa-prompt-body">A new version of the command center is ready.</div>
          </div>
          <div className="pwa-prompt-actions">
            <button className="btn btn-link" onClick={dismissUpdate}>
              Later
            </button>
            <button className="btn btn-primary" onClick={applyUpdate}>
              Reload
            </button>
          </div>
        </div>
      ) : offlineReady ? (
        <div className="pwa-prompt" role="status">
          <div className="pwa-prompt-text">
            <div className="pwa-prompt-title">Ready to work offline</div>
            <div className="pwa-prompt-body">The app shell is cached on this device.</div>
          </div>
          <button className="toast-close" aria-label="Dismiss" onClick={dismissOfflineReady}>
            ×
          </button>
        </div>
      ) : null}
    </div>
  );
}
