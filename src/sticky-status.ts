import type { RiskAssessment } from "./insights.js";

export const STICKY_MARKER = "<!-- DiffSentry Sticky Status -->";

/**
 * Single live-updated status comment that captures the bot's current
 * understanding of the PR. Posted/upserted on every review pass so the
 * latest snapshot is always near the top of the timeline.
 */
export function renderStickyStatus(opts: {
  /**
   * The verdict for the PR as it stands, not the one the last pass reached on
   * its own — see `resolveDisplayVerdict`, which is what callers pass through.
   */
  reviewState: "APPROVE" | "COMMENT" | "REQUEST_CHANGES" | "PENDING";
  /** Why that differs from the last pass's own verdict, when it does. */
  verdictReason?: string;
  risk?: RiskAssessment;
  unresolvedThreads: number;
  /** Subset of `unresolvedThreads` that gates the commit status. */
  blockingThreads?: number;
  failingChecks: number;
  pendingChecks: number;
  filesProcessed: number;
  filesSkipped: number;
  lastReviewedAt: string;
  lastReviewedSha: string;
  owner: string;
  repo: string;
  botName: string;
  riskHistory?: number[];
}): string {
  const verdict =
    opts.reviewState === "REQUEST_CHANGES"
      ? "🔴 **Changes requested**"
      : opts.reviewState === "APPROVE"
      ? "🟢 **Approved**"
      : opts.reviewState === "COMMENT"
      ? "🟡 **Comments only**"
      : "⚪ **Pending review**";

  const lines: string[] = [];
  lines.push(STICKY_MARKER);
  lines.push("");
  const headLink = `[\`${opts.lastReviewedSha.slice(0, 7)}\`](https://github.com/${opts.owner}/${opts.repo}/commit/${opts.lastReviewedSha})`;
  lines.push(`# 📌 Status — last updated ${headLink}`);
  lines.push("");
  lines.push(verdict);
  if (opts.verdictReason) {
    lines.push("");
    lines.push(`<sub>Reflects the PR's open threads, not just the latest pass: ${opts.verdictReason}.</sub>`);
  }
  lines.push("");
  lines.push(`| | |`);
  lines.push(`|---|---|`);
  if (opts.risk) {
    lines.push(`| **Risk score** | ${opts.risk.score}/100 (${capitalize(opts.risk.level)}) ${sparkline(opts.riskHistory ?? [opts.risk.score])} |`);
  }
  lines.push(
    `| **Unresolved threads** | ${opts.unresolvedThreads}${opts.blockingThreads ? ` (${opts.blockingThreads} blocking)` : ""} |`,
  );
  lines.push(`| **Failing checks** | ${opts.failingChecks} |`);
  lines.push(`| **Pending checks** | ${opts.pendingChecks} |`);
  lines.push(`| **Files reviewed** | ${opts.filesProcessed}${opts.filesSkipped ? ` (${opts.filesSkipped} skipped)` : ""} |`);
  lines.push(`| **Updated** | <code>${opts.lastReviewedAt}</code> |`);
  lines.push("");
  lines.push(`<sub>Live-updated by DiffSentry on every push. Use \`@${opts.botName} ship\` for a verdict, \`@${opts.botName} timeline\` for full history.</sub>`);

  return lines.join("\n");
}

function capitalize(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

/**
 * Render an N-point unicode block sparkline. Empty input returns ''.
 */
export function sparkline(values: number[]): string {
  if (values.length === 0) return "";
  const blocks = "▁▂▃▄▅▆▇█";
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  return values
    .slice(-20)
    .map((v) => blocks[Math.min(blocks.length - 1, Math.floor(((v - min) / span) * (blocks.length - 1)))])
    .join("");
}
