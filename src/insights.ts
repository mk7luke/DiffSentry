import type {
  CommentSeverity,
  Confidence,
  FileChange,
  ReviewComment,
  ReviewResult,
  SeverityCalibrationConfig,
} from "./types.js";

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

// ─── Severity calibration (blast radius + coverage) ─────────────
//
// Severity as the model (or a deterministic rule) first reports it tracks the
// *kind* of finding, not where it lives. This pass nudges severity to reflect
// real risk using signals already computed during the review:
//   • escalate findings in high-fan-in files (blast radius — many files depend
//     on this one, so a bug here is more dangerous), using the per-file fan-in
//     counts the code-review-graph persisted on the review result;
//   • escalate findings in already-recognized high-risk paths (auth/, payment/,
//     migrations/, …) via the same isHighRiskFile() the risk score uses;
//   • de-escalate (and optionally lower confidence) for findings whose source
//     file has a directory-scoped sibling/mirrored test changed in the same PR
//     (wellTestedPaths) — a bug shipped alongside the tests that exercise it is
//     lower risk and more likely already understood. The pairing is per-path, not
//     an aggregate "tests were touched somewhere" count.
//
// Deterministic findings are protected from softening: a hardcoded-secret
// "critical" must not drop to "major" just because the file has tests. We
// therefore never de-escalate security-typed findings or pattern/safety-engine
// findings (those carrying a patternSource) — we only ever escalate those.

/** Severity, weakest → strongest. The index is the calibration "level". */
export const SEVERITY_ORDER: readonly CommentSeverity[] = ["trivial", "minor", "major", "critical"] as const;

/** Fully-resolved calibration weights (every field present). */
export interface ResolvedSeverityCalibration {
  enabled: boolean;
  highFanInThreshold: number;
  escalateHighFanIn: number;
  escalateRiskPath: number;
  deescalateWellTested: number;
  lowerConfidenceWellTested: boolean;
  maxEscalation: number;
}

/** Sane defaults — a finding in a high-risk OR high-blast-radius location is
 *  bumped one severity level, two when both apply; a well-tested finding is
 *  eased one level and dropped a confidence notch. */
export const DEFAULT_SEVERITY_CALIBRATION: ResolvedSeverityCalibration = {
  enabled: true,
  highFanInThreshold: 5,
  escalateHighFanIn: 1,
  escalateRiskPath: 1,
  deescalateWellTested: 1,
  lowerConfidenceWellTested: true,
  maxEscalation: 2,
};

/** Merge a partial `.diffsentry.yaml` `severity_calibration` block over the
 *  defaults. Non-finite / negative numerics fall back to the default for that
 *  field so a malformed config can't invert the calibration. */
export function resolveSeverityCalibration(cfg?: SeverityCalibrationConfig): ResolvedSeverityCalibration {
  const d = DEFAULT_SEVERITY_CALIBRATION;
  const num = (v: unknown, fallback: number): number =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : fallback;
  return {
    enabled: cfg?.enabled ?? d.enabled,
    highFanInThreshold: num(cfg?.high_fan_in_threshold, d.highFanInThreshold),
    escalateHighFanIn: num(cfg?.escalate_high_fan_in, d.escalateHighFanIn),
    escalateRiskPath: num(cfg?.escalate_risk_path, d.escalateRiskPath),
    deescalateWellTested: num(cfg?.deescalate_well_tested, d.deescalateWellTested),
    lowerConfidenceWellTested: cfg?.lower_confidence_well_tested ?? d.lowerConfidenceWellTested,
    maxEscalation: num(cfg?.max_escalation, d.maxEscalation),
  };
}

/** Normalise a path for cross-source key matching: POSIX separators, no
 *  leading `./` or `/`. Mirrors graph-context's normRel so fan-in keys (stored
 *  by the graph) and GitHub PR paths compare equal. */
function normPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.?\//, "");
}

/** The lower-cased stem (basename without extension) of a production path. */
function prodStem(filePath: string): string {
  const base = filePath.split("/").pop() ?? filePath;
  return base.replace(/\.[a-z0-9]+$/i, "").toLowerCase();
}

/** The production stem a test file most likely covers, e.g.
 *  `foo.test.ts`→`foo`, `__tests__/foo.ts`→`foo`, `test_foo.py`→`foo`,
 *  `foo_test.go`→`foo`. Best-effort; used only to pair tests with sources. */
function testTargetStem(testPath: string): string {
  const base = testPath.split("/").pop() ?? testPath;
  let stem = base
    .replace(/\.(test|spec)\.[a-z0-9]+$/i, "")
    .replace(/_test\.[a-z0-9]+$/i, "")
    .replace(/\.[a-z0-9]+$/i, "");
  stem = stem.replace(/^test_/i, "");
  return stem.toLowerCase();
}

/** Directory portion of a normalised path (`""` for a top-level file). */
function dirOf(filePath: string): string {
  const norm = normPath(filePath);
  const i = norm.lastIndexOf("/");
  return i === -1 ? "" : norm.slice(0, i);
}

// Recognised top-level roots for the "mirrored tree" layout, where a test under
// `<testRoot>/a/b/foo.test.ts` covers a source under `<srcRoot>/a/b/foo.ts`.
const TEST_TREE_ROOTS = new Set(["tests", "test", "spec", "specs", "e2e", "integration", "__tests__", "__test__"]);
const SRC_TREE_ROOTS = new Set(["src", "lib", "app", "source", "pkg"]);

/** Strip a leading recognised root segment (e.g. `tests/`, `src/`) from a dir;
 *  returns `[stripped, didStrip]`. */
function stripLeadingRoot(dir: string, roots: Set<string>): [string, boolean] {
  if (!dir) return [dir, false];
  const parts = dir.split("/");
  if (roots.has(parts[0].toLowerCase())) return [parts.slice(1).join("/"), true];
  return [dir, false];
}

/** Remove any `__tests__` / `__test__` segments from a dir path. */
function stripTestFolderSegments(dir: string): string {
  return dir
    .split("/")
    .filter((seg) => seg !== "__tests__" && seg !== "__test__")
    .join("/");
}

/**
 * True when `testPath` is genuinely a sibling or mirrored test for `srcPath` —
 * matching stem AND a recognised *directory* relationship. This is deliberately
 * stricter than basename matching so a same-named file in an unrelated directory
 * (e.g. `packages/api/foo.ts` vs `packages/web/foo.test.ts`) is NOT treated as
 * tested. Supported layouts:
 *   (a) same directory          — `src/foo.ts` ↔ `src/foo.test.ts`
 *   (b) `__tests__/` subfolder  — `src/foo.ts` ↔ `src/__tests__/foo.test.ts`
 *   (c) mirrored test tree      — `src/a/foo.ts` ↔ `tests/a/foo.test.ts`, and
 *       nested layouts like `packages/api/src/foo.ts` ↔ `tests/packages/api/foo.test.ts`
 */
function isSiblingTestForSource(srcPath: string, testPath: string): boolean {
  if (prodStem(srcPath) !== testTargetStem(testPath)) return false;
  const srcDir = dirOf(srcPath);
  const testDir = dirOf(testPath);
  // (a) same directory
  if (testDir === srcDir) return true;
  // (b) a `__tests__` / `__test__` subfolder of the source dir (at any depth)
  if (stripTestFolderSegments(testDir) === srcDir) return true;
  // (c) mirrored tree: a leading test root over a sub-path that matches the
  //     source's sub-path. The source root may sit at the start (`src/a` →
  //     `a`) OR nested at the end (`packages/api/src` → `packages/api`), so we
  //     match the stripped test sub-path against both forms plus the raw dir.
  //     Candidates are derived only from THIS source path, so broadening can't
  //     pull in unrelated directories.
  const [testSub, didStripTest] = stripLeadingRoot(testDir, TEST_TREE_ROOTS);
  if (didStripTest) {
    const candidates = new Set<string>([srcDir]);
    candidates.add(stripLeadingRoot(srcDir, SRC_TREE_ROOTS)[0]);
    const parts = srcDir.split("/");
    if (parts.length > 0 && SRC_TREE_ROOTS.has(parts[parts.length - 1].toLowerCase())) {
      candidates.add(parts.slice(0, -1).join("/"));
    }
    if (candidates.has(testSub)) return true;
  }
  return false;
}

/** Repo-relative production paths in this change set that have a directory-scoped
 *  sibling/mirrored test file also changed in the same PR — our per-path
 *  "well-tested" signal, derived from the same file set assessCoverage uses.
 *  Pairing is by stem AND directory relationship (see isSiblingTestForSource),
 *  never by basename alone. */
export function wellTestedPaths(files: FileChange[]): Set<string> {
  const out = new Set<string>();
  const tests = files.filter((f) => isTestFile(f.filename));
  if (tests.length === 0) return out;
  for (const f of files) {
    if (!isProductionFile(f.filename)) continue;
    if (tests.some((t) => isSiblingTestForSource(f.filename, t.filename))) out.add(normPath(f.filename));
  }
  return out;
}

function shiftSeverity(sev: CommentSeverity, steps: number): CommentSeverity {
  const idx = SEVERITY_ORDER.indexOf(sev);
  if (idx < 0) return sev;
  const next = Math.max(0, Math.min(SEVERITY_ORDER.length - 1, idx + steps));
  return SEVERITY_ORDER[next];
}

function lowerConfidence(c: Confidence): Confidence {
  return c === "high" ? "medium" : c === "medium" ? "low" : "low";
}

/** One severity change the calibration made, for transparency/logging. */
export interface SeverityAdjustment {
  path: string;
  line: number;
  title?: string;
  from: CommentSeverity;
  to: CommentSeverity;
  reasons: string[];
}

export interface CalibrationResult {
  /** Severity changes applied (confidence-only nudges are not listed here). */
  adjustments: SeverityAdjustment[];
  /** Findings whose confidence was lowered for being in a well-tested path. */
  confidenceLowered: number;
}

/**
 * Recalibrate finding severities in place against blast-radius, risk-path, and
 * test-coverage signals. Mutates `comments[].severity` / `.confidence` and
 * returns the changes made. A no-op (empty result, no mutation) when disabled or
 * when there are no findings. Pure and deterministic given its inputs.
 */
export function calibrateSeverities(opts: {
  comments: ReviewComment[];
  files: FileChange[];
  fanInByFile?: Record<string, number>;
  weights?: ResolvedSeverityCalibration;
}): CalibrationResult {
  const w = opts.weights ?? DEFAULT_SEVERITY_CALIBRATION;
  const adjustments: SeverityAdjustment[] = [];
  let confidenceLowered = 0;
  if (!w.enabled || opts.comments.length === 0) return { adjustments, confidenceLowered };

  // fan-in keys come from the graph (normRel-normalised); index by both the raw
  // and normalised path so lookups hit regardless of which form was stored.
  const fanIn: Record<string, number> = {};
  for (const [k, v] of Object.entries(opts.fanInByFile ?? {})) fanIn[normPath(k)] = v;

  // Per-path "well-tested" signal: a finding is only softened when its own
  // source file has a directory-scoped sibling/mirrored test changed in this PR
  // (see wellTestedPaths). This is the authoritative gate — we deliberately do
  // NOT use an aggregate "test lines added" count, which can flip true when an
  // unrelated test file is merely tweaked.
  const tested = wellTestedPaths(opts.files);

  for (const c of opts.comments) {
    if (!c.severity) continue;
    const key = normPath(c.path);
    const reasons: string[] = [];

    // ── escalation (applies to every finding source) ──
    let up = 0;
    const fileFanIn = fanIn[key] ?? 0;
    if (w.escalateHighFanIn > 0 && fileFanIn >= w.highFanInThreshold) {
      up += w.escalateHighFanIn;
      reasons.push(`high fan-in (${fileFanIn})`);
    }
    if (w.escalateRiskPath > 0 && isHighRiskFile(c.path)) {
      up += w.escalateRiskPath;
      reasons.push("high-risk path");
    }
    up = Math.min(up, w.maxEscalation);

    // ── de-escalation (only for AI findings, never for deterministic security
    //    or pattern/safety-engine findings) ──
    let down = 0;
    const deterministic = !!c.patternSource;
    const isSecurity = c.type === "security";
    const wellTested = tested.has(key) && !deterministic && !isSecurity;
    if (wellTested && w.deescalateWellTested > 0) {
      down += w.deescalateWellTested;
      reasons.push("well-tested path");
    }

    const net = up - down;

    // Lower confidence ONLY when test coverage actually softened the finding
    // (net < 0) — not merely because a sibling test exists. A finding whose
    // escalation cancels or outweighs the well-tested adjustment keeps its
    // confidence, matching the documented "softened by coverage" intent.
    if (wellTested && net < 0 && w.lowerConfidenceWellTested) {
      const lowered = lowerConfidence(c.confidence ?? "high");
      if (lowered !== (c.confidence ?? "high")) {
        c.confidence = lowered;
        confidenceLowered++;
      }
    }

    if (net === 0) continue;
    const to = shiftSeverity(c.severity, net);
    if (to === c.severity) continue;
    adjustments.push({ path: c.path, line: c.line, title: c.title, from: c.severity, to, reasons });
    c.severity = to;
  }

  return { adjustments, confidenceLowered };
}

export function renderSeverityCalibrationBlock(result: CalibrationResult): string {
  // Render whenever calibration mutated anything — severity adjustments OR a
  // confidence-only downgrade — so the walkthrough always explains changes the
  // pass made (matching the logging path in reviewer.ts).
  if (result.adjustments.length === 0 && result.confidenceLowered === 0) return "";
  const arrow = (a: SeverityAdjustment) => (SEVERITY_ORDER.indexOf(a.to) > SEVERITY_ORDER.indexOf(a.from) ? "⬆️" : "⬇️");
  const lines: string[] = [];
  lines.push("## ⚖️ Severity calibration");
  lines.push("");
  lines.push(
    "Some findings were re-weighted by **blast radius** (fan-in) and **test coverage** so severity reflects real risk, not just finding type:",
  );
  lines.push("");
  if (result.adjustments.length > 0) {
    lines.push("| Finding | Change | Why |");
    lines.push("|---|---|---|");
    for (const a of result.adjustments) {
      const label = a.title ? a.title : `\`${a.path}\`:${a.line}`;
      lines.push(`| ${label} | ${arrow(a)} ${a.from} → ${a.to} | ${a.reasons.join(", ")} |`);
    }
  }
  if (result.confidenceLowered > 0) {
    if (result.adjustments.length > 0) lines.push("");
    lines.push(
      `Confidence was lowered for ${result.confidenceLowered} well-tested finding${result.confidenceLowered === 1 ? "" : "s"}.`,
    );
  }
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
