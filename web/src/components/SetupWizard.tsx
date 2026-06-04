import { useState } from "react";
import { Link } from "react-router-dom";
import { useDiagnostics } from "../api/hooks";
import { CheckRow } from "./diagnostics";
import { AlertIcon } from "./icons";

// ─────────────────────────────────────────────────────────────────────────────
// <SetupWizard> — first-run guidance banner.
//
// Shown app-wide whenever diagnostics report an incomplete setup (any failing
// check). It pinpoints exactly what's missing, with a concrete fix hint per
// item, and links to the full Diagnostics screen for the live probes + tests.
// Dismissible for the session; reappears next load if setup is still broken.
// ─────────────────────────────────────────────────────────────────────────────

const DISMISS_KEY = "ds_setup_wizard_dismissed";

function wasDismissed(): boolean {
  try {
    return sessionStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

export function SetupWizard() {
  const query = useDiagnostics();
  const [dismissed, setDismissed] = useState(wasDismissed);

  // Stay invisible until we know setup is incomplete — never flash on load.
  if (dismissed) return null;
  if (query.isPending || query.isError) return null;
  if (!query.data.incomplete) return null;

  const blocking = query.data.checks.filter((c) => c.status === "fail");
  const advisories = query.data.checks.filter((c) => c.status === "warn");

  function dismiss() {
    try {
      sessionStorage.setItem(DISMISS_KEY, "1");
    } catch {
      // sessionStorage may be unavailable (private mode); dismiss in-memory only.
    }
    setDismissed(true);
  }

  return (
    <section className="wizard" role="region" aria-label="Setup required">
      <div className="wizard-head">
        <span className="wizard-icon" aria-hidden="true">
          <AlertIcon style={{ width: 20, height: 20 }} />
        </span>
        <div className="wizard-title-block">
          <h2>Finish setting up DiffSentry</h2>
          <p>
            {blocking.length} {blocking.length === 1 ? "thing needs" : "things need"} attention before reviews can run.
            Each item below tells you exactly what to set.
          </p>
        </div>
        <button type="button" className="wizard-dismiss" onClick={dismiss} aria-label="Dismiss setup guide">
          ✕
        </button>
      </div>

      <div className="wizard-steps">
        {blocking.map((c, i) => (
          <div className="wizard-step" key={c.id}>
            <span className="wizard-step-num">{i + 1}</span>
            <div className="wizard-step-body">
              <CheckRow check={c} />
            </div>
          </div>
        ))}
      </div>

      {advisories.length > 0 ? (
        <div className="wizard-advisories">
          <span className="muted" style={{ fontSize: 12 }}>
            Also worth a look: {advisories.map((a) => a.label).join(", ")}.
          </span>
        </div>
      ) : null}

      <div className="wizard-foot">
        <Link to="/settings/diagnostics" className="btn btn-primary btn-sm" onClick={dismiss}>
          Open Diagnostics
        </Link>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => query.refetch()}>
          Re-check
        </button>
      </div>
    </section>
  );
}
