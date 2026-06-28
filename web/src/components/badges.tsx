// Severity / risk / approval badges — React ports of the badge helpers in
// src/dashboard/layout.ts.

import { useId } from "react";
import type { TriageColumns, TriageState } from "../api/types";
import type { HealthScore } from "../lib/health";

/**
 * Derive the effective triage state from a finding's triage columns. An active
 * snooze (deadline in the future) wins over accept/dismiss; an elapsed snooze
 * falls back to the accept/dismiss decision (or undecided).
 */
export function triageStateOf(row: Partial<TriageColumns>, now: number = Date.now()): TriageState | null {
  if (row.snoozed_until && Date.parse(row.snoozed_until) > now) return "snoozed";
  if (row.accepted === 1) return "accepted";
  if (row.accepted === 0) return "dismissed";
  return null;
}

const TRIAGE_CHIP: Record<TriageState, { cls: string; label: string }> = {
  accepted: { cls: "good", label: "accepted" },
  dismissed: { cls: "muted", label: "dismissed" },
  snoozed: { cls: "warn", label: "snoozed" },
};

/**
 * Chip reflecting a finding's triage state. Renders nothing for untriaged
 * findings (callers can show their own placeholder). The snooze deadline and
 * triager are surfaced via the title attribute.
 */
export function TriageBadge({ row }: { row: Partial<TriageColumns> }) {
  const state = triageStateOf(row);
  if (!state) return null;
  const { cls, label } = TRIAGE_CHIP[state];
  const bits: string[] = [];
  if (row.triaged_by) bits.push(`by @${row.triaged_by}`);
  if (state === "snoozed" && row.snoozed_until) bits.push(`until ${row.snoozed_until.slice(0, 10)}`);
  if (row.triage_note) bits.push(`— ${row.triage_note}`);
  const title = bits.join(" ") || undefined;
  return (
    <span className={`chip ${cls} uppercase`} title={title}>
      {label}
      {state === "snoozed" && row.snoozed_until ? ` · ${row.snoozed_until.slice(0, 10)}` : ""}
    </span>
  );
}

const SEVERITY_CHIP: Record<string, string> = {
  critical: "sev-crit",
  major: "sev-major",
  minor: "sev-minor",
  nit: "sev-nit",
};

export function SeverityBadge({ severity }: { severity: string | null | undefined }) {
  const k = (severity ?? "").toLowerCase();
  const cls = SEVERITY_CHIP[k] ?? "muted";
  const label = k || "—";
  return (
    <span className={`chip ${cls} uppercase`}>
      <span className="dot" />
      {label}
    </span>
  );
}

const RISK_TONE: Record<string, string> = {
  low: "good",
  moderate: "warn",
  elevated: "warn",
  high: "danger",
  critical: "danger",
};

export function RiskBadge({ level, score }: { level: string | null | undefined; score?: number | null }) {
  const k = (level ?? "").toLowerCase();
  const tone = RISK_TONE[k] ?? "muted";
  const s = typeof score === "number" ? Math.max(0, Math.min(100, score)) : null;
  const pct = s ?? 0;
  const levelDisplay = k || "—";
  return (
    <span className="risk-meter">
      <span className="bar">
        <span className="fill" style={{ width: `${pct}%` }} />
      </span>
      <span className="num">{s == null ? "—" : s}</span>
      <span className={`lvl ${tone}`}>{levelDisplay}</span>
    </span>
  );
}

const APPROVAL_CLASS: Record<string, string> = {
  approve: "good",
  approved: "good",
  request_changes: "danger",
  comment: "neutral",
  commented: "neutral",
};
const APPROVAL_LABEL: Record<string, string> = {
  approve: "approved",
  approved: "approved",
  request_changes: "changes requested",
  comment: "commented",
  commented: "commented",
};

export function ApprovalBadge({ approval }: { approval: string | null | undefined }) {
  const k = (approval ?? "").toLowerCase();
  const cls = APPROVAL_CLASS[k] ?? "muted";
  const label = APPROVAL_LABEL[k] ?? k ?? "—";
  return <span className={`chip ${cls} uppercase`}>{label || "—"}</span>;
}

export function RoleBadge({ role }: { role: string | null | undefined }) {
  const k = (role ?? "").toLowerCase();
  const label = k || "—";
  return <span className={`rolechip role-${k || "none"}`}>{label}</span>;
}

/**
 * Prominent, color-coded repo-health grade. Shows the letter at a glance; on
 * hover it expands a card with the score and the approved / changes-requested /
 * pending split. Used on the overview cards and the RepoDetail header — both
 * pass a `HealthScore` from the shared `computeHealth` helper so the verdict is
 * identical everywhere.
 */
export function GradeBadge({ health, size = "md" }: { health: HealthScore; size?: "sm" | "md" | "lg" }) {
  const { grade, tone, score, label, hasData, breakdown } = health;
  const aria = hasData ? `Health grade ${grade}, ${score} percent clean — ${label}` : "Health grade not available — no reviews yet";
  // useId() gives a collision-free id even when several badges share a grade
  // (e.g. multiple "A" repos on the overview grid). tabIndex makes the root
  // focusable so the existing :focus-within CSS reveals the breakdown for
  // keyboard users; aria-describedby points AT to the popover content.
  const tooltipId = useId();
  return (
    <span
      className={`grade-badge grade-${tone} grade-${size}`}
      tabIndex={0}
      aria-label={aria}
      aria-describedby={tooltipId}
    >
      <span className="grade-letter">{grade}</span>
      <span className="grade-pop" id={tooltipId} role="tooltip">
        <span className="gp-head">
          <span className={`gp-grade grade-${tone}`}>{grade}</span>
          <span className="gp-meta">
            <span className="gp-score">{hasData ? `${score}% clean` : "No reviews yet"}</span>
            <span className="gp-label">{label}</span>
          </span>
        </span>
        {breakdown.total > 0 ? (
          <span className="gp-split">
            <span className="gp-row good">
              <span className="k">Approved</span>
              <span className="v">{breakdown.approved}</span>
            </span>
            <span className="gp-row danger">
              <span className="k">Changes requested</span>
              <span className="v">{breakdown.changesRequested}</span>
            </span>
            <span className="gp-row muted">
              <span className="k">Pending</span>
              <span className="v">{breakdown.pending}</span>
            </span>
          </span>
        ) : (
          <span className="gp-empty">No review outcomes recorded yet.</span>
        )}
      </span>
    </span>
  );
}
