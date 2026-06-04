import type { CheckStatus, DiagnosticCheck } from "../api/types";

// Shared presentation for diagnostic checks — used by both the permanent
// Diagnostics screen and the first-run setup wizard so a check looks identical
// wherever it surfaces.

const STATUS_LABEL: Record<CheckStatus, string> = {
  ok: "OK",
  warn: "Heads up",
  fail: "Action needed",
};

export function StatusBadge({ status }: { status: CheckStatus }) {
  return <span className={`diag-badge ${status}`}>{STATUS_LABEL[status]}</span>;
}

export function CheckRow({ check }: { check: DiagnosticCheck }) {
  return (
    <div className={`diag-check ${check.status}`}>
      <span className="diag-dot" aria-hidden="true" />
      <div className="diag-body">
        <div className="diag-head">
          <span className="diag-label">{check.label}</span>
          <StatusBadge status={check.status} />
        </div>
        <div className="diag-detail">{check.detail}</div>
        {check.fixHint ? (
          <div className="diag-fix">
            <span className="diag-fix-tag">Fix</span>
            <span>{check.fixHint}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

const CATEGORY_LABEL: Record<DiagnosticCheck["category"], string> = {
  github: "GitHub App",
  ai: "AI provider",
  auth: "Dashboard access",
  persistence: "Persistence",
};

/** Render the full check list, grouped by category in a stable order. */
export function CheckList({ checks }: { checks: DiagnosticCheck[] }) {
  const order: DiagnosticCheck["category"][] = ["github", "ai", "auth", "persistence"];
  const groups = order
    .map((cat) => ({ cat, items: checks.filter((c) => c.category === cat) }))
    .filter((g) => g.items.length > 0);
  return (
    <div className="diag-groups">
      {groups.map((g) => (
        <div key={g.cat} className="diag-group">
          <div className="diag-group-title">{CATEGORY_LABEL[g.cat]}</div>
          <div className="diag-list">
            {g.items.map((c) => (
              <CheckRow key={c.id} check={c} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
