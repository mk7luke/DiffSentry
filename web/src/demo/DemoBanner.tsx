import { useState, type CSSProperties } from "react";
import { DEMO } from "./mode";

// A removable "You're in demo mode" banner with install / quick-start CTAs.
// Rendered at the top of the app shell; returns null outside demo mode, so the
// Shell can mount it unconditionally.

const INSTALL_URL = "https://github.com/mk7luke/DiffSentry#setup";
const QUICKSTART_URL = "https://github.com/mk7luke/DiffSentry/blob/main/docs/QUICK_START.md";
const DISMISS_KEY = "ds-demo-banner-dismissed";

function wasDismissed(): boolean {
  try {
    return sessionStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

const bar: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  flexWrap: "wrap",
  padding: "10px 16px",
  marginBottom: 16,
  background: "var(--accent-soft)",
  border: "1px solid var(--accent-line)",
  borderRadius: "var(--r-lg)",
  color: "var(--text)",
  fontFamily: "var(--font-sans)",
  fontSize: 14,
};

const ctaPrimary: CSSProperties = {
  padding: "6px 12px",
  borderRadius: "var(--r-md, 8px)",
  background: "var(--accent)",
  color: "var(--accent-contrast)",
  border: "1px solid var(--accent)",
  fontWeight: 600,
  textDecoration: "none",
  whiteSpace: "nowrap",
};

const ctaGhost: CSSProperties = {
  padding: "6px 12px",
  borderRadius: "var(--r-md, 8px)",
  background: "transparent",
  color: "var(--text)",
  border: "1px solid var(--line)",
  fontWeight: 600,
  textDecoration: "none",
  whiteSpace: "nowrap",
};

export function DemoBanner() {
  const [hidden, setHidden] = useState(wasDismissed);
  if (!DEMO || hidden) return null;

  const dismiss = () => {
    try {
      sessionStorage.setItem(DISMISS_KEY, "1");
    } catch {
      // sessionStorage unavailable — dismiss for this view anyway.
    }
    setHidden(true);
  };

  return (
    <div role="region" aria-label="Demo mode notice" style={bar}>
      <span aria-hidden="true" style={{ fontSize: 16 }}>
        🛟
      </span>
      <span style={{ flex: "1 1 280px", minWidth: 0 }}>
        <strong>You're in demo mode.</strong> Exploring DiffSentry with sample data — it's read-only,
        and nothing here is connected to a real repository.
      </span>
      <a href={INSTALL_URL} target="_blank" rel="noreferrer noopener" style={ctaPrimary}>
        Install on your repo
      </a>
      <a href={QUICKSTART_URL} target="_blank" rel="noreferrer noopener" style={ctaGhost}>
        View Quick Start
      </a>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss demo mode banner"
        style={{
          marginLeft: 4,
          width: 28,
          height: 28,
          lineHeight: "1",
          fontSize: 18,
          background: "transparent",
          border: "1px solid var(--line)",
          borderRadius: "var(--r-md, 8px)",
          color: "var(--text-2)",
          cursor: "pointer",
        }}
      >
        ×
      </button>
    </div>
  );
}
