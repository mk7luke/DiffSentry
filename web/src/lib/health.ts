// Repo health scorecard — the single source of truth for the at-a-glance grade
// shown on the overview cards and the RepoDetail header. Both call sites feed
// the same `computeHealth` so a repo always reads the same letter everywhere.
//
// Deliberately decoupled from the API row shapes: callers normalize their data
// (which lives in different windows per view) into the plain `HealthInput`
// numbers below, and this module owns the weighting + grade thresholds.

export type HealthTone = "good" | "warn" | "danger" | "muted";

export interface HealthInput {
  /** Volume of reviewed PRs — the denominator for finding/critical rates. */
  prsReviewed: number;
  /** Review outcomes (any window): clean approvals. */
  approved: number;
  /** Review outcomes: changes requested — the friction signal. */
  changesRequested: number;
  /** Review outcomes: commented / undecided — neither approved nor blocked. */
  pending: number;
  /** Total findings surfaced in the scoring window. */
  findings: number;
  /** Critical-severity findings in the scoring window. */
  critical: number;
  /**
   * Signed risk-score trend (recent average − earlier average). Positive means
   * risk is climbing (worse), negative means it's cooling off. Omit / null when
   * a view has no risk series (e.g. the compact overview cards).
   */
  riskTrend?: number | null;
}

export interface HealthBreakdown {
  approved: number;
  changesRequested: number;
  pending: number;
  total: number;
}

export interface HealthScore {
  /** 0–100 "percent clean". */
  score: number;
  /** Letter grade derived from `score` (A+ … D), or "—" when there's no data. */
  grade: string;
  /** Color tier for badges / accents. */
  tone: HealthTone;
  /** Short human verdict ("Healthy", "Watch", "At risk", "No data"). */
  label: string;
  /** False when the repo has no reviews yet — render a neutral placeholder. */
  hasData: boolean;
  /** Approval split for the hover breakdown. */
  breakdown: HealthBreakdown;
  factors: { critical: number; findings: number; prsReviewed: number; riskTrend: number | null };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/** Map a 0–100 score to a letter grade. */
function gradeFor(score: number): string {
  if (score >= 97) return "A+";
  if (score >= 93) return "A";
  if (score >= 90) return "A-";
  if (score >= 85) return "B+";
  if (score >= 80) return "B";
  if (score >= 75) return "B-";
  if (score >= 68) return "C+";
  if (score >= 60) return "C";
  if (score >= 50) return "C-";
  return "D";
}

/** Color tier + verdict from the final score. */
function toneFor(score: number): { tone: HealthTone; label: string } {
  if (score >= 85) return { tone: "good", label: "Healthy" };
  if (score >= 70) return { tone: "warn", label: "Watch" };
  return { tone: "danger", label: "At risk" };
}

/**
 * Compute a repo's health grade from approval mix, finding/critical rate, and
 * (optionally) risk trend. Pure and deterministic.
 *
 * Scoring starts at a clean 100 and subtracts weighted penalties:
 *  - criticals dominate (a single critical per few PRs visibly drops the grade),
 *  - general finding volume is a mild drag,
 *  - a high changes-requested ratio adds review friction,
 *  - a rising risk trend nudges the score down (a cooling trend nudges it up).
 */
export function computeHealth(input: HealthInput): HealthScore {
  const approved = Math.max(0, input.approved);
  const changesRequested = Math.max(0, input.changesRequested);
  const pending = Math.max(0, input.pending);
  const decided = approved + changesRequested + pending;
  const breakdown: HealthBreakdown = { approved, changesRequested, pending, total: decided };
  const riskTrend = input.riskTrend ?? null;

  // No reviews → no verdict. Avoids dividing by zero and a misleading "A+".
  if (input.prsReviewed <= 0 && decided === 0) {
    return {
      score: 0,
      grade: "—",
      tone: "muted",
      label: "No data",
      hasData: false,
      breakdown,
      factors: { critical: input.critical, findings: input.findings, prsReviewed: input.prsReviewed, riskTrend },
    };
  }

  const denom = Math.max(1, input.prsReviewed);
  const criticalRate = input.critical / denom;
  const findingRate = input.findings / denom;
  const changesRate = decided > 0 ? changesRequested / decided : 0;

  let score = 100;
  score -= clamp(criticalRate * 60, 0, 45); // criticals hurt the most
  score -= clamp(findingRate * 8, 0, 20); // overall noise
  score -= clamp(changesRate * 35, 0, 25); // review friction
  if (riskTrend != null) score -= clamp(riskTrend * 0.3, -8, 8); // trend nudge

  score = Math.round(clamp(score, 0, 100));
  const { tone, label } = toneFor(score);
  return {
    score,
    grade: gradeFor(score),
    tone,
    label,
    hasData: true,
    breakdown,
    factors: { critical: input.critical, findings: input.findings, prsReviewed: input.prsReviewed, riskTrend },
  };
}

/**
 * Signed risk trend from an ordered series of risk scores (oldest → newest):
 * mean of the recent half minus the mean of the earlier half. Returns null when
 * there aren't enough points to compare. Used by views that carry a risk
 * sparkline (e.g. RepoDetail) to feed `computeHealth`.
 */
export function riskTrend(scores: Array<number | null | undefined>): number | null {
  const vals = scores.filter((s): s is number => typeof s === "number" && Number.isFinite(s));
  if (vals.length < 2) return null;
  const mid = Math.floor(vals.length / 2);
  const earlier = vals.slice(0, mid);
  const recent = vals.slice(mid);
  const avg = (xs: number[]) => xs.reduce((n, x) => n + x, 0) / xs.length;
  return avg(recent) - avg(earlier);
}
