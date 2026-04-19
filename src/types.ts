// ─── Server / Environment Config ───────────────────────────────
export interface Config {
  port: number;
  githubAppId: string;
  githubPrivateKey: string;
  githubWebhookSecret: string;
  aiProvider: "anthropic" | "openai";
  anthropicApiKey?: string;
  anthropicBaseUrl?: string;
  openaiApiKey?: string;
  openaiBaseUrl?: string;
  anthropicModel: string;
  openaiModel: string;
  maxFilesPerReview: number;
  ignoredPatterns: string[];
  botName: string;
  learningsDir: string;
}

// ─── Per-Repo YAML Config (.diffsentry.yaml) ──────────────────
export interface RepoConfig {
  language?: string;
  tone_instructions?: string;
  reviews?: ReviewsConfig;
  chat?: ChatConfig;
}

export interface ReviewsConfig {
  profile?: "chill" | "assertive";
  request_changes_workflow?: boolean;
  high_level_summary?: boolean;
  walkthrough?: WalkthroughConfig;
  auto_review?: AutoReviewConfig;
  auto_apply_labels?: boolean;
  auto_assign_reviewers?: boolean;
  commit_status?: boolean;
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
  // CodeRabbit-style metadata used by the renderer.
  title?: string;
  suggestion?: string;
  suggestionLanguage?: "diff" | "suggestion";
  aiAgentPrompt?: string;
  fingerprint?: string;
  /** AI's self-rated confidence in this finding (default high). */
  confidence?: Confidence;
}

// ─── Review Result ─────────────────────────────────────────────
export interface ReviewResult {
  summary: string;
  comments: ReviewComment[];
  approval: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
}

// ─── Walkthrough Result ────────────────────────────────────────
export interface WalkthroughResult {
  summary: string;
  fileDescriptions: FileDescription[];
  cohorts?: ChangeCohort[];
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
}

export interface FileDescription {
  filename: string;
  status: string;
  changeDescription: string;
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
  files: FileChange[];
  isDraft?: boolean;
  labels?: string[];
  author?: string;
}

// ─── AI Provider Interface ─────────────────────────────────────
export interface AIProvider {
  review(context: PRContext, repoConfig?: RepoConfig, learnings?: Learning[]): Promise<ReviewResult>;
  generateWalkthrough(context: PRContext, repoConfig?: RepoConfig): Promise<WalkthroughResult>;
  chat(context: PRContext, userMessage: string, repoConfig?: RepoConfig): Promise<string>;
}

// ─── Learnings ─────────────────────────────────────────────────
export interface Learning {
  id: string;
  repo: string;
  content: string;
  createdAt: string;
  path?: string; // optional file path scope
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
