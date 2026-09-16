import type { SlashSyntax } from "./slash-commands.js";

// ─── Server / Environment Config ───────────────────────────────
export interface Config {
  port: number;
  githubAppId: string;
  githubPrivateKey: string;
  githubWebhookSecret: string;
  aiProvider: "anthropic" | "openai" | "openai-compatible";
  anthropicApiKey?: string;
  anthropicBaseUrl?: string;
  openaiApiKey?: string;
  openaiBaseUrl?: string;
  anthropicModel: string;
  openaiModel: string;
  // OpenAI-compatible local/self-hosted providers (Ollama, LM Studio, vLLM,
  // llama.cpp server, LocalAI, etc.). Only used when aiProvider === "openai-compatible".
  localAiBaseUrl?: string;
  localAiApiKey?: string;
  localAiModel: string;
  localAiJsonMode: boolean;
  /** Hosted reasoning models behind an OpenAI-compatible endpoint (grok-4.5,
   *  DeepSeek-R1, …) default to a HIGH reasoning effort, which spends the
   *  output-token budget on hidden chain-of-thought and stretches a review well
   *  past the per-request deadline. Lowering it is a real trade-off, not a free
   *  win — measured against grok-4.5 on three PRs, "high" took 34-136s, "medium"
   *  29-98s, and "low" 2-10s, but "low" dropped a major finding the other two
   *  caught. Tune it against your own deadline. Unset (the default) sends no
   *  field at all, so local runtimes that reject the parameter are unaffected. */
  localAiReasoningEffort?: string;
  /**
   * Per-request deadline (ms) applied to every AI provider call. Sourced from
   * AI_REQUEST_TIMEOUT_MS (default 60s). Guarantees a hung model call surfaces
   * as a "review failed (AI timeout)" outcome instead of stalling indefinitely.
   */
  aiRequestTimeoutMs: number;
  // ─── Backup AI provider / failover (all optional; off unless backupAiProvider set) ───
  /** When set, wrap the primary provider in a FailoverProvider with this backup. */
  backupAiProvider?: "anthropic" | "openai" | "openai-compatible";
  backupAnthropicApiKey?: string;
  backupAnthropicModel?: string;
  backupAnthropicBaseUrl?: string;
  backupOpenaiApiKey?: string;
  backupOpenaiModel?: string;
  backupOpenaiBaseUrl?: string;
  backupLocalAiBaseUrl?: string;
  backupLocalAiApiKey?: string;
  backupLocalAiModel?: string;
  backupLocalAiJsonMode?: boolean;
  backupLocalAiReasoningEffort?: string;
  /** Short per-op deadline for the PRIMARY when a backup is configured, so a
   *  slow-hang fails over quickly. Ignored (primary uses aiRequestTimeoutMs)
   *  when no backup is set. */
  primaryAiTimeoutMs: number;
  /** Consecutive primary failures before the failover breaker opens. */
  backupCircuitThreshold: number;
  /** How long (ms) the failover breaker stays open. */
  backupCircuitCooldownMs: number;
  maxFilesPerReview: number;
  ignoredPatterns: string[];
  botName: string;
  learningsDir: string;
  /** Accept `/command` syntax in comments at all (SLASH_COMMANDS). */
  slashCommands: boolean;
  /**
   * Accept bare `/review` in addition to namespaced `/diffsentry review`
   * (SLASH_COMMANDS_BARE). Turn off on repos that run another ChatOps bot —
   * Prow, for instance, also answers `/help`.
   */
  bareSlashCommands: boolean;
}

// ─── Per-Repo YAML Config (.diffsentry.yaml) ──────────────────
export interface RepoConfig {
  language?: string;
  tone_instructions?: string;
  reviews?: ReviewsConfig;
  chat?: ChatConfig;
  issues?: IssuesConfig;
  release_notes?: ReleaseNotesConfig;
}

// ─── Release notes ─────────────────────────────────────────────
export interface ReleaseNotesConfig {
  /**
   * Default false. Post release notes automatically once every check on the
   * PR's head commit has passed, with no `@bot release-notes` needed.
   *
   * Opt-in rather than on, because it spends model budget on every PR that
   * goes green and leaves a comment nobody asked for. Read through
   * `isAutoReleaseNotesEnabled`, which normalises it: nothing validates this
   * value at runtime, so it arrives as whatever was typed in the YAML.
   */
  auto?: boolean;
}

// ─── Issues config (mirrors PR `reviews`/`chat` shape) ────────
export interface IssuesConfig {
  /** Auto-summarize new issues when they're opened. */
  auto_summary?: IssueAutoSummaryConfig;
  /** Free-form chat behavior on issues. */
  chat?: IssueChatConfig;
}

export interface IssueAutoSummaryConfig {
  /** Default true — post a CodeRabbit-style summary when an issue is opened. */
  enabled?: boolean;
  /** Default false — also re-summarize when an issue body is edited. */
  on_edit?: boolean;
}

export interface IssueChatConfig {
  /** Default true — respond to @bot mentions on issues. */
  auto_reply?: boolean;
}

export interface ReviewsConfig {
  /** How much of the review reaches the reader inline.
   *  - "chill"      — only critical issues are raised at all (the default).
   *  - "assertive"  — everything, including nitpicks.
   *  - "quiet"      — review at chill depth, but post ONLY critical/major
   *    findings as inline threads; everything else collapses into a single
   *    `🟡 Other comments (N)` bucket in the review body. For a solo
   *    maintainer an unfiltered inline stream is the thing that goes unread,
   *    so the bucket is what keeps the rest of the review reachable. */
  profile?: "chill" | "assertive" | "quiet";
  request_changes_workflow?: boolean;
  high_level_summary?: boolean;
  walkthrough?: WalkthroughConfig;
  auto_review?: AutoReviewConfig;
  auto_apply_labels?: boolean;
  auto_assign_reviewers?: boolean;
  commit_status?: boolean;
  /**
   * Whether unresolved blocking DiffSentry findings gate the `DiffSentry`
   * commit status. "blocking" (default) fails the check while a critical or
   * major thread is open; "off" restores verdict-only behaviour.
   */
  thread_gate?: "blocking" | "off";
  abort_on_close?: boolean;
  path_filters?: string[];
  path_instructions?: PathInstruction[];
  pre_merge_checks?: PreMergeConfig;
  /** Built-in performance / footgun pattern checks. Default true. */
  builtin_patterns?: boolean;
  /** User-defined plain-English/regex pattern checks. */
  anti_patterns?: AntiPattern[];
  /** License header check. */
  license_header?: LicenseHeaderConfig;
  /** Context-aware severity calibration (blast radius + coverage). */
  severity_calibration?: SeverityCalibrationConfig;
  /** Deterministic static analysis (lint / typecheck / SAST). Opt-in. */
  static_analysis?: StaticAnalysisConfig;
  /** Large-diff guard: per-file + per-review size budget for what is sent to the model. */
  diff_budget?: DiffBudgetConfig;
}

// ─── Large-diff budgeting ──────────────────────────────────────
// Bounds the size of the diff content sent to the model so a huge PR can't blow
// the context window (or run up cost). Truncation is intelligent — hunk headers
// plus a head/tail of each hunk are kept — and the whole-review pass prioritizes
// higher-risk files (auth/, payment/, migrations/, …) when not everything fits.
// Applies ONLY to the model prompt; deterministic scanners always see the full
// diff. See src/ai/diff-budget.ts. Coordinates with the code-graph related-
// context budget: `per_review_chars` is the COMBINED ceiling for the diff plus
// the related-context section, so the two together stay within the model window.
export interface DiffBudgetConfig {
  /** Master switch. Default true. */
  enabled?: boolean;
  /** A single file's patch is truncated past this many chars. Default 24000. */
  per_file_chars?: number;
  /** Combined budget (chars) for diff + related context across the review. Default 180000. */
  per_review_chars?: number;
  /** Lines kept at the head of each over-budget hunk. Default 40. */
  keep_head_lines?: number;
  /** Lines kept at the tail of each over-budget hunk. Default 20. */
  keep_tail_lines?: number;
}

/** Per-file outcome of the diff-budget pass. */
export interface BudgetedFile {
  filename: string;
  /** Patch to send to the model: original, truncated, or "" when omitted. */
  patch: string;
  /** The patch was shortened to fit the per-file budget. */
  truncated: boolean;
  /** The file was dropped entirely from the model prompt to fit the per-review budget. */
  omitted: boolean;
  /** Original patch length in chars. */
  originalChars: number;
  /** Chars actually sent to the model for this file (0 when omitted). */
  sentChars: number;
}

/** Result of applying the diff budget to a PR's changed files. */
export interface DiffBudgetResult {
  /** Whether budgeting ran (false ⇒ feature disabled, files untouched). */
  enabled: boolean;
  /** Per-file outcomes, in the original file order. */
  files: BudgetedFile[];
  /** Lookup by filename. */
  byFile: Record<string, BudgetedFile>;
  /** Filenames whose patch was truncated (still sent). */
  filesTruncated: string[];
  /** Filenames dropped entirely from the model prompt for size. */
  filesOmitted: string[];
  /** Sum of original patch lengths across all files. */
  totalOriginalChars: number;
  /** Sum of patch lengths actually sent to the model. */
  totalSentChars: number;
  /** Effective per-review diff budget after reserving room for related context. */
  effectivePerReviewChars: number;
  /** Resolved per-file budget. */
  perFileChars: number;
}

// ─── Static analysis ──────────────────────────────────────────────
// Folds deterministic analyzer output (ESLint / tsc / Semgrep) into the review.
// Opt-in and best-effort: needs a checked-out PR head (DIFFSENTRY_REPO_CHECKOUT_DIR)
// and the analyzer installed/configured in the target repo, else it no-ops and
// the review proceeds AI-only. See src/static-analysis.ts.
export interface StaticAnalysisConfig {
  /** Master switch. Default false — the whole feature is opt-in. */
  enabled?: boolean;
  /** Restrict to a subset of analyzers. Default: every detected analyzer. */
  analyzers?: ("eslint" | "tsc" | "semgrep")[];
  /** Per-analyzer wall-clock budget (ms). Default 60000. <=0 disables the bound. */
  timeout_ms?: number;
}

// ─── Severity calibration ─────────────────────────────────────
// Post-processing weights that nudge a finding's severity to reflect real risk:
// escalate in high-blast-radius (fan-in) files and recognized high-risk paths
// (auth/, payment/, migrations/, …); de-escalate (and optionally lower
// confidence) in well-tested paths. All fields optional — omitted ones fall back
// to the sane defaults in src/insights.ts (DEFAULT_SEVERITY_CALIBRATION).
export interface SeverityCalibrationConfig {
  /** Master switch. Default true. */
  enabled?: boolean;
  /** fan-in ≥ this marks a file high-blast-radius. Default 5 (matches the graph). */
  high_fan_in_threshold?: number;
  /** Severity steps to escalate for findings in high-fan-in files. Default 1. */
  escalate_high_fan_in?: number;
  /** Severity steps to escalate for findings in high-risk paths. Default 1. */
  escalate_risk_path?: number;
  /** Severity steps to de-escalate for findings in well-tested paths. Default 1. */
  deescalate_well_tested?: number;
  /** Also drop confidence one notch for findings in well-tested paths. Default true. */
  lower_confidence_well_tested?: boolean;
  /** Hard cap on the net escalation any single finding can receive. Default 2. */
  max_escalation?: number;
}

export interface LicenseHeaderConfig {
  /** Required header text — checked against the first ~10 lines of new source files. */
  required: string;
  /** Globs for files this applies to. Defaults to common source extensions. */
  paths?: string[];
}

export interface AntiPattern {
  /** Short label shown in the comment header. */
  name: string;
  /** Regex source (string). Tested against added lines, multiline=false. */
  pattern: string;
  /** Optional regex flags (defaults to no flags). */
  flags?: string;
  /** Severity of the finding (defaults to "minor"). */
  severity?: CommentSeverity;
  /** Comment type (defaults to "suggestion"). */
  type?: CommentType;
  /** Plain-English explanation appended to the comment body. */
  message?: string;
  /** Optional advice / fix recipe. */
  advice?: string;
  /** Optional path glob restricting where this pattern applies. */
  path?: string;
}

export interface WalkthroughConfig {
  enabled?: boolean;
  collapse?: boolean;
  changed_files_summary?: boolean;
  sequence_diagrams?: boolean;
  estimate_effort?: boolean;
  suggested_labels?: boolean;
  suggested_reviewers?: boolean;
  poem?: boolean;
}

export interface AutoReviewConfig {
  enabled?: boolean;
  drafts?: boolean;
  base_branches?: string[];
  labels?: string[];
  ignore_title_keywords?: string[];
  ignore_usernames?: string[];
  auto_incremental_review?: boolean;
  auto_pause_after_reviewed_commits?: number;
}

export interface PathInstruction {
  path: string;
  instructions: string;
}

export interface ChatConfig {
  auto_reply?: boolean;
}

// ─── Comment Categorization ────────────────────────────────────
export type CommentType =
  | "issue"
  | "suggestion"
  | "nitpick"
  | "documentation"
  | "security";
export type CommentSeverity = "critical" | "major" | "minor" | "trivial";

/**
 * Which engineering concern a finding touches — a different axis from
 * {@link CommentType}, which says what *kind of remark* it is. "Refactor
 * suggestion" and "Potential issue" can both be about data integrity; the type
 * tells a maintainer nothing about which of their concerns is in play.
 *
 * The six values and their glyphs are CodeRabbit's, read off the captured
 * corpus rather than invented: `tests/e2e/reference/2026-09/coderabbit/`,
 * where they carry 52 of 52 findings.
 */
export type CommentCategory =
  | "functional_correctness"
  | "stability_availability"
  | "security_privacy"
  | "data_integrity"
  | "performance_scalability"
  | "maintainability";

/**
 * Roughly what acting on a finding costs. A solo maintainer triages against
 * their own afternoon, so "is this two minutes or two days" is a scarcer signal
 * than severity — severity says how bad it is if ignored, not whether it can be
 * cleared before lunch. Values from the same corpus as {@link CommentCategory}.
 */
export type CommentEffort = "quick_win" | "heavy_lift" | "low_value";

/**
 * What kind of change the whole pull request is — a walkthrough-level axis,
 * not a per-finding one. One word answers the first question a maintainer asks
 * of an unfamiliar PR, and DiffSentry has had no equivalent: its labels are
 * suggestions for GitHub, its effort estimate is about reading cost.
 *
 * Three values, read off `tests/e2e/reference/2026-09/coderabbit/walkthrough.md`
 * where `**Change:**` carries `Bug fix` (5), `Feature` (2) and `Other` (2)
 * across 9 of 15 walkthroughs, and no fourth value appears.
 *
 * Deliberately *not* joined by a `**Priority:**` axis, which CodeRabbit also
 * carries (14/15). DiffSentry already computes a risk verdict and now shows it
 * above the fold; a second, model-authored priority would be a second verdict
 * on the same comment, free to disagree with the first.
 */
export type ChangeType = "bug_fix" | "feature" | "other";

// ─── File Change ───────────────────────────────────────────────
export interface FileChange {
  filename: string;
  status: "added" | "modified" | "removed" | "renamed";
  patch: string;
  additions: number;
  deletions: number;
}

// ─── Review Comment ────────────────────────────────────────────
export type Confidence = "high" | "medium" | "low";

export interface ReviewComment {
  path: string;
  line: number;
  side: "RIGHT";
  body: string;
  type?: CommentType;
  severity?: CommentSeverity;
  /** Engineering domain the finding touches. Optional: a model that omits it,
   *  or names a value outside the enum, yields a shorter header rather than a
   *  broken one. */
  category?: CommentCategory;
  /** Rough cost of acting on the finding. Optional on the same terms as
   *  {@link ReviewComment.category}. */
  effort?: CommentEffort;
  // CodeRabbit-style metadata used by the renderer.
  title?: string;
  suggestion?: string;
  suggestionLanguage?: "diff" | "suggestion";
  aiAgentPrompt?: string;
  fingerprint?: string;
  /** AI's self-rated confidence in this finding (default high). */
  confidence?: Confidence;
  /** Repository Learnings the model said shaped this finding, resolved from the
   *  1-based indices it returned. Rendered as the `🧠 Learnings used` collapse,
   *  and kept on the comment so callers that re-render a body (the review-body
   *  bulk blocks, the dashboard) don't have to re-resolve them. */
  appliedLearnings?: Learning[];
  /** A finding NOT tied to a specific changed line — e.g. the diff contradicts
   *  the PR description, a claimed change is missing, or a cross-cutting concern
   *  spans the whole PR. These carry title/body/severity but no meaningful
   *  `line` (conventionally 0) and are never posted as inline comments
   *  (submitReview's `line > 0` filter excludes them).
   *
   *  `path` then decides where the finding surfaces, because it decides whether
   *  GitHub can host a thread for it (see isFileLevelFinding / isPrBodyFinding
   *  in review-body.ts). Both the model and the drift check may name a file
   *  directly, so a path here is the norm rather than a demotion artefact:
   *   - path set   → posted as a resolvable file-scoped review thread
   *                  (`subjectType: FILE`) on the same review as the inline
   *                  findings.
   *   - path empty → no file to attach to, so it renders as prose in the review
   *                  body — the one channel a reader can't resolve or collapse,
   *                  which is why entry there additionally requires high
   *                  `confidence`. */
  prLevel?: boolean;
  /** Set under `reviews.profile: quiet` on an inline finding held back from the
   *  inline stream. The finding is NOT dropped — it renders in the review
   *  body's `🟡 Other comments (N)` bucket instead of becoming its own thread,
   *  so the PR's file view carries only the findings that block a merge. */
  quietOverflow?: boolean;
  /** Set when a finding could not be anchored to a diff line and became a
   *  file-scoped thread instead — GitHub's limitation, not the model's
   *  mistake. `claimedLine` is the line the model named (null when it named
   *  none), kept so the review body's outside-diff callout can say where the
   *  finding meant rather than printing a bare filename. Distinguishes these
   *  from `prLevelComments` entries, which carry a path because the model
   *  chose to scope them to a file. */
  outsideDiff?: { claimedLine: number | null };
  /** Set by the pattern engine so callers can record the hit source without
   *  re-sniffing the rendered body. "builtin" = shipped heuristic; "custom" =
   *  a `.diffsentry.yaml` anti-pattern or an admin-authored command-center rule. */
  patternSource?: "builtin" | "custom";
  /** The admin custom-rule id that produced this finding (only for command-center
   *  rules; absent for built-ins and `.diffsentry.yaml` anti_patterns). The stable
   *  key analytics use so a hit is never matched to a rule by name. */
  customRuleId?: number;
  /** Set by the static-analysis integration so callers can record the producing
   *  analyzer ("eslint" / "tsc" / "semgrep") without sniffing the rendered body. */
  staticSource?: "eslint" | "tsc" | "semgrep";
}

// ─── Review Result ─────────────────────────────────────────────
export interface ReviewResult {
  summary: string;
  comments: ReviewComment[];
  approval: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
  /** True when the summary was synthesized by DiffSentry because the AI
   *  didn't supply a usable one. Callers (reviewer.ts) may re-synthesize
   *  after merging built-in findings so the summary reflects the full set. */
  summaryIsFallback?: boolean;
  /** True when the AI returned content that couldn't be parsed as JSON.
   *  In this state, AI-generated inline comments are absent — only
   *  built-in safety/pattern findings ran. */
  parseFailed?: boolean;
  /** Per-file fan-in / impact-radius counts from the code-review-graph, keyed
   *  by repo-relative path. Populated best-effort during the review and reused
   *  by downstream passes (e.g. severity calibration). Absent when the graph
   *  was unavailable. */
  fanInByFile?: Record<string, number>;
  /** Which provider produced this review. Set to "backup" by FailoverProvider
   *  when the primary failed over; absent/"primary" otherwise. Drives the
   *  subtle "reviewed by backup provider" footnote in the posted body. */
  servedBy?: "primary" | "backup";
}

// ─── Walkthrough Result ────────────────────────────────────────
export interface WalkthroughResult {
  summary: string;
  fileDescriptions: FileDescription[];
  cohorts?: ChangeCohort[];
  /** What kind of change this PR is. Absent when the model omitted it or named
   *  a value outside the enum — the walkthrough then renders without the line. */
  changeType?: ChangeType;
  effortEstimate?: number; // 1-5
  effortMinutes?: number;
  sequenceDiagrams?: string[];
  /** @deprecated use sequenceDiagrams */
  sequenceDiagram?: string;
  suggestedLabels?: string[];
  suggestedReviewers?: string[];
  poem?: string;
}

export interface ChangeCohort {
  label: string;
  files: string[];
  summary: string;
  /** Which broader concern this cohort belongs to. Cohorts sharing a theme are
   *  rendered as one table under a bold theme line; cohorts without one fall
   *  into a single untitled table, which is how the walkthrough looked before
   *  themes existed. See renderChangesTable. */
  theme?: string;
}

export interface FileDescription {
  filename: string;
  status: string;
  changeDescription: string;
}

// ─── Issue Context ────────────────────────────────────────────
export interface IssueComment {
  author?: string;
  authorAssociation?: string;
  body: string;
  createdAt: string;
  isBot: boolean;
}

export interface IssueContext {
  owner: string;
  repo: string;
  issueNumber: number;
  title: string;
  body: string;
  state: string;
  labels: string[];
  author?: string;
  authorAssociation?: string;
  url: string;
  comments: IssueComment[];
  /** Top-level entries of the default branch (e.g. ["src/", "tests/", "README.md"]). */
  repoFileTree?: string[];
  /** Default branch name (e.g. "main"). */
  defaultBranch?: string;
}

// ─── PR Context ────────────────────────────────────────────────
export interface PRContext {
  owner: string;
  repo: string;
  pullNumber: number;
  title: string;
  description: string;
  baseBranch: string;
  baseSha?: string;
  headBranch: string;
  headSha: string;
  /** Repo default branch (e.g. "main"). Authoritative source for .diffsentry.yaml. */
  defaultBranch?: string;
  files: FileChange[];
  /**
   * Filenames dropped by the operator-level ignore list (`ignoredPatterns` —
   * e.g. *.min.js, *.map, dist/**, lockfiles) before `files` was built. Kept so
   * the reviewer can tell "PR only contains ignored files (minified bundle)"
   * apart from a genuinely empty diff and surface which files were skipped.
   */
  ignoredFiles?: string[];
  /**
   * Filenames dropped by the `maxFilesPerReview` cap — the post-`ignoredFiles`
   * overflow beyond `.slice(0, fileCap)`. Recorded so the empty-files status
   * comment can explain "N files beyond the review cap" rather than silently
   * returning when the cap is the only reason nothing was reviewed.
   */
  cappedFiles?: string[];
  isDraft?: boolean;
  labels?: string[];
  author?: string;
  /**
   * Optional pre-rendered, budget-capped "Related context" section drawn from
   * the code-review-graph (whole-function bodies + cross-file dependents/
   * dependencies + high-fan-in flags). Injected by the review prompt builder
   * when present; absent (or empty) preserves diff-only behaviour. See
   * graph-context.ts.
   */
  relatedContext?: string;
  /**
   * Optional result of the large-diff budget pass. When present, the review and
   * walkthrough prompt builders render the budgeted (possibly truncated) patches
   * and annotate truncated/omitted files instead of the raw diff. Absent ⇒ the
   * full diff is sent (legacy behaviour). Computed once in reviewer.ts so the
   * model prompt and the human-facing review body agree on what was trimmed.
   * See src/ai/diff-budget.ts.
   */
  diffBudget?: DiffBudgetResult;
  /**
   * Incremental reviews only: the part of THIS PR that was already reviewed on
   * an earlier commit, handed to the review prompt as read-only context. See
   * PriorReviewContext.
   */
  priorReview?: PriorReviewContext;
}

/**
 * The already-reviewed remainder of an incremental review's pull request.
 *
 * On a synchronize push `PRContext.files` is trimmed to the delta, but the
 * title and description still describe the whole branch — so a model shown the
 * slice alone reliably concludes that the feature the description promises was
 * never implemented. This carries the rest of the PR into the prompt as
 * context: never commented on, only used to judge the new commit against the
 * complete change set.
 */
export interface PriorReviewContext {
  /** Files in this PR reviewed on an earlier commit, with their full patches. */
  files: FileChange[];
  /**
   * Budget applied to those patches. Entries marked `omitted` are named in the
   * prompt but not shown. Absent ⇒ send every patch in full (budgeting off).
   */
  budget?: DiffBudgetResult;
  /**
   * Set when the delta and related-context sections already consumed the review
   * budget: name the earlier files so the model knows they exist, but spend no
   * budget on their diffs.
   */
  namesOnly?: boolean;
}

// ─── AI Provider Interface ─────────────────────────────────────
export interface AIProvider {
  review(context: PRContext, repoConfig?: RepoConfig, learnings?: Learning[]): Promise<ReviewResult>;
  generateWalkthrough(context: PRContext, repoConfig?: RepoConfig): Promise<WalkthroughResult>;
  chat(context: PRContext, userMessage: string, repoConfig?: RepoConfig): Promise<string>;
  /**
   * Free-form markdown response grounded in issue context. Used for the auto-
   * summary on issue open, the `@bot plan` command, and free-form `@bot`
   * questions. The handler shapes `userMessage` per intent.
   */
  chatIssue(context: IssueContext, userMessage: string, repoConfig?: RepoConfig): Promise<string>;
  /**
   * Bare prompt -> text helper, no PR/issue context. Used for small one-off
   * synthesis tasks (e.g. shaping a `@bot learn` note into a structured rule).
   */
  complete(system: string, user: string, opts?: { maxTokens?: number; json?: boolean }): Promise<string>;
}

// ─── Learnings ─────────────────────────────────────────────────
/** Sentinel {@link Learning.repo} for cross-repo (global) learnings. Real
 *  GitHub owners can never be "*", so a global learning never collides with a
 *  per-repo one. Lives beside the field it constrains so every consumer can
 *  recognise it without importing the store. */
export const GLOBAL_REPO = "*";

export interface Learning {
  id: string;
  repo: string;
  content: string;
  createdAt: string;
  path?: string; // optional file path scope
  // ─── Provenance ──────────────────────────────────────────────
  // Who taught this, where, and about what. A learning overrides the
  // reviewer's default judgement, so a wrong one silences real findings
  // indefinitely — and the only way a maintainer can decide whether to retire
  // one is to see the conversation it came from. `path` is a matching glob and
  // answers none of this; these three do.
  //
  // All optional, and absent on every learning stored before they existed as
  // well as on ones added through the dashboard API, where there is no
  // conversation to attribute. The renderer omits whichever lines are missing.
  /** GitHub login of the maintainer whose note produced the learning. */
  author?: string;
  /** Number of the PR the note was left on. */
  prNumber?: number;
  /** Where the finding the note replied to sat: `path:line`, or
   *  `path:start-end` when the finding spanned a range. */
  sourceFile?: string;
  /** `owner/name` of the repo the note was left on. Only meaningful on a
   *  cross-repo learning, where {@link Learning.repo} is the `*` sentinel and
   *  would otherwise be the whole trail back to the conversation. Left unset
   *  on a per-repo learning, which already names its repo. */
  sourceRepo?: string;
}

/** The conversational origin of a learning, recorded at the moment it is
 *  taught. See the provenance fields on {@link Learning}. */
export interface LearningOrigin {
  author?: string;
  prNumber?: number;
  sourceFile?: string;
  sourceRepo?: string;
}

// ─── Chat Command ──────────────────────────────────────────────
export type ChatCommand =
  | { type: "review" }
  | { type: "full_review" }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "resolve" }
  | { type: "help" }
  | { type: "configuration" }
  | { type: "summary" }
  | { type: "learn"; content: string }
  | { type: "generate_docstrings" }
  | { type: "generate_tests" }
  | { type: "simplify" }
  | { type: "autofix" }
  | { type: "tldr" }
  | { type: "tour" }
  | { type: "ship" }
  | { type: "rubber_duck" }
  | { type: "five_why"; target: string }
  | { type: "eli5" }
  | { type: "timeline" }
  | { type: "bench" }
  | { type: "changelog" }
  | { type: "release_notes" }
  | { type: "diff_pr"; target: string }
  | { type: "rewrite_description" }
  | { type: "unknown_command"; name: string; syntax: SlashSyntax }
  | { type: "chat"; message: string };

// ─── Issue Chat Command ────────────────────────────────────────
export type IssueChatCommand =
  | { type: "help" }
  | { type: "summary" }
  | { type: "plan"; target?: string }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "configuration" }
  | { type: "learn"; content: string }
  | { type: "unknown_command"; name: string; syntax: SlashSyntax }
  | { type: "chat"; message: string };

// ─── Pre-Merge Checks ──────────────────────────────────────────
export type CheckMode = "off" | "warning" | "error";

export interface PreMergeConfig {
  title?: {
    mode?: CheckMode;
    requirements?: string;
  };
  description?: {
    mode?: CheckMode;
    requirements?: string;
  };
  custom_checks?: CustomCheck[];
}

export interface CustomCheck {
  name: string;
  mode: CheckMode;
  instructions: string;
}

export interface CheckResult {
  name: string;
  mode: CheckMode;
  passed: boolean;
  message: string;
}
