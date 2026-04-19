import type { Confidence, FileChange, ReviewResult } from "./types.js";

// ─── Risk score ─────────────────────────────────────────────────

const HIGH_RISK_PATTERNS = [
  /(^|\/)(auth|authentication|session|jwt|password|crypto|hash)/i,
  /(^|\/)(payment|billing|charge|invoice|stripe|paypal)/i,
  /(^|\/)(migration|migrations|schema|alembic)/i,
  /(^|\/)(security|secret|credential|token)/i,
  /(^|\/)(access[-_]?control|permission|rbac|policy)/i,
];

function isHighRiskFile(path: string): boolean {
  return HIGH_RISK_PATTERNS.some((re) => re.test(path));
}

export type RiskFactor = { label: string; weight: number; detail: string };

export type RiskAssessment = {
  score: number; // 0-100
  level: "low" | "moderate" | "elevated" | "high" | "critical";
  factors: RiskFactor[];
};

export function assessRisk(opts: {
  files: FileChange[];
  review: ReviewResult;
  effortEstimate?: number;
  hasNewTests: boolean;
}): RiskAssessment {
  const factors: RiskFactor[] = [];

  const totalChangedLines = opts.files.reduce((sum, f) => sum + f.additions + f.deletions, 0);
  const fileCount = opts.files.length;
  const highRiskFiles = opts.files.filter((f) => isHighRiskFile(f.filename));
  const criticalFindings = opts.review.comments.filter((c) => c.severity === "critical").length;
  const majorFindings = opts.review.comments.filter((c) => c.severity === "major").length;

  if (criticalFindings > 0) {
    factors.push({
      label: "Critical findings",
      weight: Math.min(40, criticalFindings * 20),
      detail: `${criticalFindings} critical issue${criticalFindings === 1 ? "" : "s"} flagged`,
    });
  }
  if (majorFindings > 0) {
    factors.push({
      label: "Major findings",
      weight: Math.min(20, majorFindings * 5),
      detail: `${majorFindings} major issue${majorFindings === 1 ? "" : "s"} flagged`,
    });
  }
  if (highRiskFiles.length > 0) {
    factors.push({
      label: "High-risk paths touched",
      weight: Math.min(20, highRiskFiles.length * 7),
      detail: highRiskFiles.map((f) => `\`${f.filename}\``).join(", "),
    });
  }
  if (totalChangedLines >= 500) {
    factors.push({
      label: "Large change",
      weight: Math.min(15, Math.round(totalChangedLines / 200)),
      detail: `${totalChangedLines} lines changed across ${fileCount} files`,
    });
  } else if (totalChangedLines >= 200) {
    factors.push({
      label: "Moderate change",
      weight: 5,
      detail: `${totalChangedLines} lines changed across ${fileCount} files`,
    });
  }
  if (opts.effortEstimate && opts.effortEstimate >= 4) {
    factors.push({
      label: "High review effort",
      weight: opts.effortEstimate === 5 ? 10 : 5,
      detail: `Effort estimate ${opts.effortEstimate}/5`,
    });
  }
  if (!opts.hasNewTests && opts.files.some((f) => isProductionFile(f.filename) && f.additions > 5)) {
    factors.push({
      label: "No new tests",
      weight: 10,
      detail: "Production code added/changed without accompanying tests",
    });
  }

  const score = Math.min(100, factors.reduce((sum, f) => sum + f.weight, 0));
  const level = riskLevel(score);
  return { score, level, factors };
}

function riskLevel(score: number): RiskAssessment["level"] {
  if (score >= 75) return "critical";
  if (score >= 55) return "high";
  if (score >= 35) return "elevated";
  if (score >= 15) return "moderate";
  return "low";
}

export function renderRiskBlock(risk: RiskAssessment): string {
  const badge: Record<RiskAssessment["level"], string> = {
    low: "🟢 Low",
    moderate: "🟡 Moderate",
    elevated: "🟠 Elevated",
    high: "🔴 High",
    critical: "🚨 Critical",
  };
  const lines: string[] = [];
  lines.push(`## Risk Assessment`);
  lines.push("");
  lines.push(`**Score: ${risk.score}/100** — ${badge[risk.level]}`);
  if (risk.factors.length === 0) {
    lines.push("");
    lines.push("No elevated risk signals detected.");
  } else {
    lines.push("");
    lines.push("| Factor | Weight | Detail |");
    lines.push("|---|---|---|");
    for (const f of risk.factors) {
      lines.push(`| ${f.label} | +${f.weight} | ${f.detail} |`);
    }
  }
  return lines.join("\n");
}

// ─── Test coverage signal ───────────────────────────────────────

const TEST_PATH_RE = /(^|\/)(__tests__|tests|test|spec|specs|e2e|integration)\/|\.(test|spec)\.[a-z]+$|_test\.[a-z]+$|test_[^/]+\.py$/i;

function isTestFile(path: string): boolean {
  return TEST_PATH_RE.test(path);
}

function isProductionFile(path: string): boolean {
  if (isTestFile(path)) return false;
  if (/\.(md|txt|yaml|yml|json|toml|ini|lock)$/i.test(path)) return false;
  if (/^\.diffsentry\.yaml$/.test(path)) return false;
  if (/^(README|LICENSE|CHANGELOG|AGENTS|CLAUDE)/.test(path)) return false;
  return /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|cs|rb|php|swift|scala)$/i.test(path);
}

export type CoverageSignal = {
  productionFiles: number;
  productionAdditions: number;
  testFiles: number;
  testAdditions: number;
  flag: "ok" | "warn" | "missing";
  detail: string;
};

export function assessCoverage(files: FileChange[]): CoverageSignal {
  const prod = files.filter((f) => isProductionFile(f.filename));
  const tests = files.filter((f) => isTestFile(f.filename));
  const productionFiles = prod.length;
  const productionAdditions = prod.reduce((s, f) => s + f.additions, 0);
  const testFiles = tests.length;
  const testAdditions = tests.reduce((s, f) => s + f.additions, 0);

  let flag: CoverageSignal["flag"] = "ok";
  let detail = "";
  if (productionAdditions > 0 && testAdditions === 0) {
    flag = productionAdditions > 30 ? "missing" : "warn";
    detail = `${productionAdditions} line(s) of production code added with no test changes.`;
  } else if (productionAdditions > 0 && testAdditions > 0) {
    detail = `${productionAdditions} prod / ${testAdditions} test lines added.`;
  } else if (productionAdditions === 0) {
    detail = "No production code changes.";
  }
  return { productionFiles, productionAdditions, testFiles, testAdditions, flag, detail };
}

export function renderCoverageBlock(c: CoverageSignal): string {
  if (c.productionFiles === 0 && c.testFiles === 0) return "";
  const icon = c.flag === "missing" ? "🔴" : c.flag === "warn" ? "🟡" : "🟢";
  const lines: string[] = [];
  lines.push(`## Test Coverage Signal`);
  lines.push("");
  lines.push(`${icon} ${c.detail}`);
  lines.push("");
  lines.push(`| Source files changed | Test files changed | Source lines + | Test lines + |`);
  lines.push(`|---|---|---|---|`);
  lines.push(`| ${c.productionFiles} | ${c.testFiles} | ${c.productionAdditions} | ${c.testAdditions} |`);
  return lines.join("\n");
}

// ─── PR splitting suggestion ────────────────────────────────────

export function shouldSuggestSplit(opts: {
  cohortCount: number;
  effortEstimate?: number;
  fileCount: number;
  totalChangedLines: number;
}): boolean {
  if (opts.cohortCount >= 5 && opts.totalChangedLines >= 300) return true;
  if (opts.effortEstimate === 5 && opts.fileCount >= 8) return true;
  return false;
}

// ─── Confidence aggregate ───────────────────────────────────────

export function renderConfidenceAggregate(review: ReviewResult): string {
  if (review.comments.length === 0) return "";
  const counts: Record<Confidence, number> = { high: 0, medium: 0, low: 0 };
  for (const c of review.comments) {
    counts[(c.confidence ?? "high") as Confidence] += 1;
  }
  if (counts.medium === 0 && counts.low === 0) return "";
  const total = review.comments.length;
  return `## 📊 Confidence breakdown\n\n${total} finding${total === 1 ? "" : "s"} — 🟢 ${counts.high} high · 🟡 ${counts.medium} medium · 🔴 ${counts.low} low. Treat the medium / low ones as hypotheses to verify.`;
}

// ─── Reviewer-delta block (what changed since each reviewer last looked) ──

export type ReviewerDelta = {
  reviewer: string;
  filesChanged: number;
  paths: string[];
};

export function computeReviewerDeltas(opts: {
  reviewerLastReviewed: Array<{ login: string; submittedAt: string }>;
  files: Array<{ filename: string; latestCommitAt?: string }>;
  excludeBots?: boolean;
}): ReviewerDelta[] {
  const out: ReviewerDelta[] = [];
  for (const r of opts.reviewerLastReviewed) {
    if (opts.excludeBots && r.login.toLowerCase().endsWith("[bot]")) continue;
    const reviewedAt = new Date(r.submittedAt).getTime();
    const changed = opts.files.filter((f) => {
      if (!f.latestCommitAt) return true;
      return new Date(f.latestCommitAt).getTime() > reviewedAt;
    });
    if (changed.length === 0) continue;
    out.push({
      reviewer: r.login,
      filesChanged: changed.length,
      paths: changed.map((f) => f.filename),
    });
  }
  return out;
}

export function renderReviewerDeltaBlock(deltas: ReviewerDelta[]): string {
  if (deltas.length === 0) return "";
  const lines: string[] = [];
  lines.push("## 🔁 Changes since last reviewed");
  lines.push("");
  for (const d of deltas) {
    lines.push(`- @${d.reviewer}: ${d.filesChanged} file(s) changed since their last review`);
    for (const p of d.paths.slice(0, 5)) lines.push(`  - \`${p}\``);
    if (d.paths.length > 5) lines.push(`  - _…and ${d.paths.length - 5} more_`);
  }
  return lines.join("\n");
}

export function renderSplitSuggestion(cohorts: Array<{ label: string; files: string[] }>): string {
  const lines: string[] = [];
  lines.push(`## 💡 Suggested PR Split`);
  lines.push("");
  lines.push(
    "This change spans several distinct cohorts. Splitting it into smaller PRs would make review faster and lower the chance of regressions slipping through. A natural split:",
  );
  lines.push("");
  for (const [i, c] of cohorts.entries()) {
    lines.push(`${i + 1}. **${c.label}** — \`${c.files.join("`, `")}\``);
  }
  lines.push("");
  lines.push("<sub>Heuristic suggestion — feel free to ignore if the cohorts truly belong together.</sub>");
  return lines.join("\n");
}
