import type {
  BudgetExceededPayload,
  FindingSurfacedPayload,
  ReviewLifecyclePayload,
} from "../realtime/bus.js";
import type { WeeklyDigest } from "../dashboard/queries.js";
import type { ChannelMessage, MessageSeverity } from "./channels.js";

// ─────────────────────────────────────────────────────────────────────────────
// Render bus events + the weekly digest into the provider-agnostic
// ChannelMessage the adapters know how to deliver.
// ─────────────────────────────────────────────────────────────────────────────

const SEVERITY_RANK: Record<string, number> = { critical: 4, major: 3, minor: 2, nit: 1 };

/** Numeric rank for a severity string (0 for unknown/none). Higher = worse. */
export function severityRank(sev: string | null | undefined): number {
  return SEVERITY_RANK[(sev ?? "").toLowerCase()] ?? 0;
}

function prUrl(owner: string, repo: string, number: number): string {
  return `https://github.com/${owner}/${repo}/pull/${number}`;
}

function asMessageSeverity(sev: string | null | undefined): MessageSeverity {
  const k = (sev ?? "").toLowerCase();
  if (k === "critical" || k === "major" || k === "minor" || k === "nit") return k;
  return "info";
}

export function renderFindingMessage(p: FindingSurfacedPayload): ChannelMessage {
  const worst = p.worst ?? "info";
  const parts: string[] = [];
  if (p.critical) parts.push(`${p.critical} critical`);
  if (p.major) parts.push(`${p.major} major`);
  if (p.minor) parts.push(`${p.minor} minor`);
  if (p.nit) parts.push(`${p.nit} nit`);
  const breakdown = parts.length > 0 ? parts.join(", ") : `${p.total} finding(s)`;
  return {
    title: `DiffSentry: ${worst} finding in ${p.owner}/${p.repo} #${p.number}`,
    text: p.sample
      ? `Review of ${p.owner}/${p.repo} #${p.number} surfaced ${breakdown}.\nTop: ${p.sample}`
      : `Review of ${p.owner}/${p.repo} #${p.number} surfaced ${breakdown}.`,
    severity: asMessageSeverity(p.worst),
    url: prUrl(p.owner, p.repo, p.number),
    fields: [
      { label: "Repo", value: `${p.owner}/${p.repo}` },
      { label: "PR", value: `#${p.number}` },
      { label: "Findings", value: breakdown },
    ],
  };
}

export function renderReviewFailedMessage(p: ReviewLifecyclePayload): ChannelMessage {
  return {
    title: `DiffSentry: review failed on ${p.owner}/${p.repo} #${p.number}`,
    text: p.error
      ? `The ${p.mode ?? ""} review failed: ${p.error}`.trim()
      : `The review failed.`,
    severity: "critical",
    url: prUrl(p.owner, p.repo, p.number),
    fields: [
      { label: "Repo", value: `${p.owner}/${p.repo}` },
      { label: "PR", value: `#${p.number}` },
      ...(p.mode ? [{ label: "Mode", value: p.mode }] : []),
    ],
  };
}

export function renderBudgetMessage(p: BudgetExceededPayload): ChannelMessage {
  return {
    title: `DiffSentry: AI budget exceeded (${p.scope})`,
    text: `Spend over ${p.window} reached $${p.spentUsd.toFixed(2)} of the $${p.limitUsd.toFixed(2)} budget for ${p.scope}.`,
    severity: "major",
    fields: [
      { label: "Scope", value: p.scope },
      { label: "Window", value: p.window },
      { label: "Spent", value: `$${p.spentUsd.toFixed(2)}` },
      { label: "Budget", value: `$${p.limitUsd.toFixed(2)}` },
    ],
  };
}

export function renderDigestMessage(digest: WeeklyDigest, dashboardOrigin?: string): ChannelMessage {
  const t = digest.totals;
  const top = digest.perRepo.slice(0, 5).map((r) => {
    const bits = [`${r.reviews} reviews`, `${r.findings} findings`];
    if (r.critical) bits.push(`${r.critical} critical`);
    return `• ${r.owner}/${r.repo} — ${bits.join(", ")}`;
  });
  const lines = [
    `Last 7 days across ${t.repos} repo(s):`,
    `${t.reviews} reviews · ${t.prs} PRs · ${t.findings} findings`,
    `${t.critical} critical · ${t.major} major · ${t.minor} minor · ${t.nit} nit`,
  ];
  if (top.length > 0) {
    lines.push("", "Top repos by impact:", ...top);
  }
  return {
    title: "DiffSentry weekly digest",
    text: lines.join("\n"),
    severity: t.critical > 0 ? "major" : "info",
    url: dashboardOrigin,
    fields: [
      { label: "Reviews", value: String(t.reviews) },
      { label: "Findings", value: String(t.findings) },
      { label: "Critical", value: String(t.critical) },
    ],
  };
}
