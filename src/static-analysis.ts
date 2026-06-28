// ─────────────────────────────────────────────────────────────────────────────
// Deterministic static-analysis findings (lint / typecheck / SAST).
//
// DiffSentry normally reviews PRs from the GitHub diff alone — it has no working
// tree. File-based analyzers (ESLint, tsc, Semgrep) need the actual checked-out
// PR head to run. This module is therefore OPT-IN and degrades to a no-op when:
//   • the feature is disabled in .diffsentry.yaml (default), or
//   • no checkout directory is available (DIFFSENTRY_REPO_CHECKOUT_DIR unset /
//     missing), or
//   • the analyzer isn't installed / configured in the target repo, or
//   • the analyzer errors or exceeds its per-tool timeout.
//
// In every one of those cases `runStaticAnalysis` resolves to `[]` so the
// review proceeds AI-only. It never throws and never rejects.
//
// Findings are normalized into the existing `ReviewComment` shape (path, line,
// severity, title, body, fingerprint, …) with a `staticSource` tag so callers
// can record the producer ("eslint" / "tsc" / "semgrep"). Only findings on
// ADDED diff lines are kept — GitHub inline comments can only attach to lines
// present in the diff, matching the safety/pattern scanners.
// ─────────────────────────────────────────────────────────────────────────────

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { CommentSeverity, FileChange, ReviewComment, StaticAnalysisConfig } from "./types.js";
import { renderInlineCommentBody } from "./ai/parse.js";

export type { StaticAnalysisConfig };

/** The deterministic analyzers this module knows how to drive. */
export type StaticSource = "eslint" | "tsc" | "semgrep";

export const STATIC_SOURCES: readonly StaticSource[] = ["eslint", "tsc", "semgrep"];

const DEFAULT_TIMEOUT_MS = 60_000;
/** Cap captured analyzer output so a pathological run can't exhaust memory. */
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

/** Extensions ESLint is asked to lint (others are skipped to avoid noise). */
const ESLINT_EXTS = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".vue"]);

/** Minimal logger surface so the reviewer can pass its child logger without a
 *  hard dependency (and tests can omit it). */
export interface StaticLogger {
  info?: (obj: unknown, msg?: string) => void;
  warn?: (obj: unknown, msg?: string) => void;
  debug?: (obj: unknown, msg?: string) => void;
}

export interface RunStaticAnalysisOptions {
  /** Changed files (filename + unified-diff patch) from the PR. */
  files: Pick<FileChange, "filename" | "patch">[];
  /** Absolute path to the checked-out PR head. Absent ⇒ no-op. */
  checkoutDir?: string;
  /** reviews.static_analysis from the repo config. */
  config?: StaticAnalysisConfig;
  /** Cancels in-flight analyzer processes when the review is aborted. */
  signal?: AbortSignal;
  logger?: StaticLogger;
}

// ─── Public entry ─────────────────────────────────────────────────────────────

/**
 * Run every available/configured analyzer against the checked-out PR head and
 * return normalized findings. Best-effort and non-throwing: any failure mode
 * yields `[]` and the review continues AI-only.
 */
export async function runStaticAnalysis(opts: RunStaticAnalysisOptions): Promise<ReviewComment[]> {
  const log = opts.logger ?? {};
  try {
    if (opts.config?.enabled !== true) return [];

    const cwd = opts.checkoutDir;
    if (!cwd || !isDir(cwd)) {
      log.debug?.({ cwd }, "Static analysis enabled but no checkout dir available; skipping");
      return [];
    }

    // Map every changed file to the set of added (RIGHT-side) line numbers so we
    // can keep only findings that land on lines actually in the diff.
    const addedLines = new Map<string, Set<number>>();
    const changedFiles: string[] = [];
    for (const f of opts.files) {
      if (!f.patch) continue;
      addedLines.set(f.filename, computeAddedLines(f.patch));
      changedFiles.push(f.filename);
    }
    if (changedFiles.length === 0) return [];

    const timeoutMs = opts.config?.timeout_ms ?? DEFAULT_TIMEOUT_MS;
    const requested = opts.config?.analyzers;
    const wanted = (analyzer: StaticSource) => !requested || requested.includes(analyzer);

    // Detect which analyzers are present/configured in the target repo, honoring
    // the optional analyzer allowlist.
    const available = detectAnalyzers(cwd).filter(wanted);
    if (available.length === 0) {
      log.debug?.({ cwd }, "Static analysis: no analyzers detected/configured; skipping");
      return [];
    }
    log.info?.({ analyzers: available }, "Running static analyzers");

    // Run analyzers concurrently — each is independently bounded and isolated,
    // so one tool's failure/timeout can't take down the others.
    const perTool = await Promise.all(
      available.map(async (source) => {
        try {
          const raw = await runAnalyzer(source, { cwd, changedFiles, timeoutMs, signal: opts.signal, log });
          return normalize(source, raw, cwd, changedFiles, addedLines);
        } catch (err) {
          log.warn?.({ err, source }, "Static analyzer failed; ignoring");
          return [];
        }
      }),
    );

    const findings = perTool.flat();
    // De-dup analyzer-vs-analyzer (e.g. eslint + a semgrep rule on the same
    // line) by fingerprint before they reach the reviewer.
    return dedupeByFingerprint(findings);
  } catch (err) {
    // Belt-and-suspenders: the whole feature must never break a review.
    log.warn?.({ err }, "Static analysis crashed; continuing AI-only");
    return [];
  }
}

/**
 * Resolve the checked-out PR-head directory from the environment. Operator-level
 * (not committed in repo YAML): set DIFFSENTRY_REPO_CHECKOUT_DIR to a directory
 * containing the PR head when DiffSentry runs somewhere with a working tree
 * (e.g. a CI job). Returns undefined when unset or not a directory.
 */
export function resolveCheckoutDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env.DIFFSENTRY_REPO_CHECKOUT_DIR || env.DIFFSENTRY_STATIC_ANALYSIS_DIR;
  if (!raw) return undefined;
  const resolved = path.resolve(raw);
  return isDir(resolved) ? resolved : undefined;
}

/**
 * Keep only static findings that aren't already covered by an existing finding
 * (AI / safety / pattern) at the same path+line, and drop static-vs-static
 * duplicates. Existing findings are richer, so the analyzer note is redundant
 * there. Location-keyed because each producer mints a distinct fingerprint for
 * the same spot, so fingerprint equality alone would never collide across
 * producers.
 */
export function dedupeStaticFindings(
  staticFindings: ReviewComment[],
  existing: ReviewComment[],
): ReviewComment[] {
  const occupied = new Set(existing.map((c) => `${c.path}:${c.line}`));
  const seen = new Set<string>();
  const out: ReviewComment[] = [];
  for (const c of staticFindings) {
    const loc = `${c.path}:${c.line}`;
    if (occupied.has(loc)) continue;
    if (seen.has(loc)) continue;
    seen.add(loc);
    out.push(c);
  }
  return out;
}

// ─── Tool detection ───────────────────────────────────────────────────────────

function detectAnalyzers(cwd: string): StaticSource[] {
  const out: StaticSource[] = [];
  if (resolveBin(cwd, "eslint") && hasEslintConfig(cwd)) out.push("eslint");
  if (resolveBin(cwd, "tsc") && fileExists(path.join(cwd, "tsconfig.json"))) out.push("tsc");
  if (semgrepOnPath() && hasSemgrepConfig(cwd)) out.push("semgrep");
  return out;
}

/** Path to a locally-installed CLI in node_modules/.bin, or null. We never shell
 *  out to `npx` — that could trigger a network install at review time. */
function resolveBin(cwd: string, name: string): string | null {
  const candidates = [
    path.join(cwd, "node_modules", ".bin", name),
    path.join(cwd, "node_modules", ".bin", `${name}.cmd`),
  ];
  for (const c of candidates) if (fileExists(c)) return c;
  return null;
}

function hasEslintConfig(cwd: string): boolean {
  const flat = ["eslint.config.js", "eslint.config.mjs", "eslint.config.cjs", "eslint.config.ts"];
  const legacy = [".eslintrc.js", ".eslintrc.cjs", ".eslintrc.json", ".eslintrc.yml", ".eslintrc.yaml", ".eslintrc"];
  if ([...flat, ...legacy].some((f) => fileExists(path.join(cwd, f)))) return true;
  // package.json "eslintConfig" key also counts.
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8"));
    return !!pkg?.eslintConfig;
  } catch {
    return false;
  }
}

function hasSemgrepConfig(cwd: string): boolean {
  const files = [".semgrep.yml", ".semgrep.yaml", "semgrep.yml", "semgrep.yaml"];
  if (files.some((f) => fileExists(path.join(cwd, f)))) return true;
  return isDir(path.join(cwd, ".semgrep"));
}

/** Best-effort PATH lookup for the `semgrep` executable (no spawn). */
function semgrepOnPath(): boolean {
  const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      if (fileExists(path.join(dir, `semgrep${ext}`))) return true;
    }
  }
  return false;
}

// ─── Analyzer drivers ─────────────────────────────────────────────────────────

export interface RawFinding {
  /** File path as the analyzer reported it (absolute or cwd-relative). */
  file: string;
  line: number;
  ruleId: string;
  message: string;
  level: "error" | "warning" | "info";
}

interface RunCtx {
  cwd: string;
  changedFiles: string[];
  timeoutMs: number;
  signal?: AbortSignal;
  log: StaticLogger;
}

async function runAnalyzer(source: StaticSource, ctx: RunCtx): Promise<RawFinding[]> {
  switch (source) {
    case "eslint":
      return runEslint(ctx);
    case "tsc":
      return runTsc(ctx);
    case "semgrep":
      return runSemgrep(ctx);
  }
}

async function runEslint(ctx: RunCtx): Promise<RawFinding[]> {
  const bin = resolveBin(ctx.cwd, "eslint");
  if (!bin) return [];
  const targets = ctx.changedFiles.filter((f) => ESLINT_EXTS.has(path.extname(f).toLowerCase()));
  if (targets.length === 0) return [];

  const res = await exec(bin, ["--format", "json", "--no-error-on-unmatched-pattern", ...targets], ctx);
  if (res.spawnError || res.timedOut || res.outputTooLarge) return [];
  // ESLint exits 1 when it finds lint errors — that's expected, parse anyway.
  const json = parseJson<EslintFileResult[]>(res.stdout);
  if (!Array.isArray(json)) return [];

  const out: RawFinding[] = [];
  for (const file of json) {
    for (const m of file.messages ?? []) {
      if (typeof m.line !== "number") continue; // whole-file (config) messages have no line
      out.push({
        file: file.filePath,
        line: m.line,
        ruleId: m.ruleId || "eslint",
        message: m.message || "ESLint reported an issue.",
        level: m.severity === 2 ? "error" : "warning",
      });
    }
  }
  return out;
}

interface EslintFileResult {
  filePath: string;
  messages?: { ruleId?: string | null; severity?: number; message?: string; line?: number }[];
}

async function runTsc(ctx: RunCtx): Promise<RawFinding[]> {
  const bin = resolveBin(ctx.cwd, "tsc");
  if (!bin) return [];
  // tsc resolves the file set from tsconfig — it can't be limited to the changed
  // files, so we run the whole project (bounded by the timeout) and filter the
  // output down to changed files + added lines afterwards.
  const res = await exec(bin, ["--noEmit", "--pretty", "false"], ctx);
  if (res.spawnError || res.timedOut || res.outputTooLarge) return [];
  return parseTscDiagnostics(`${res.stdout}\n${res.stderr}`);
}

// tsc (`--pretty false`) writes one diagnostic per line, e.g.:
//   src/foo.ts(12,5): error TS2322: Type 'x' is not assignable to 'y'.
//   C:\repo\src\foo.ts(12,5): error TS2322: ...        (Windows absolute path)
//   src/some(weird).ts(12,5): error TS2322: ...        (parens in the filename)
// A greedy filename capture (`.*` rather than `.+?`) anchored by the trailing
// `(line,col):` segment lets it backtrack to the *last* coordinate group, so
// drive-letter colons and parentheses inside the path don't truncate the match.
const TSC_DIAGNOSTIC_RE = /^(.*)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.*)$/;

/** Parse `tsc --pretty false` text diagnostics into raw findings. Exported for
 *  tests — the spawn path is exercised separately. */
export function parseTscDiagnostics(text: string): RawFinding[] {
  const out: RawFinding[] = [];
  for (const raw of text.split("\n")) {
    const m = raw.trimEnd().match(TSC_DIAGNOSTIC_RE);
    if (!m) continue;
    out.push({
      file: m[1],
      line: parseInt(m[2], 10),
      ruleId: m[5],
      message: m[6],
      level: m[4] === "warning" ? "warning" : "error",
    });
  }
  return out;
}

async function runSemgrep(ctx: RunCtx): Promise<RawFinding[]> {
  // We only get here when a local config was detected, so scan offline against
  // it — never `--config auto`, which needs network. --quiet keeps the banner
  // out of stdout so the JSON parses cleanly. Limit the scan to changed files.
  const cfg = localSemgrepConfig(ctx.cwd);
  if (!cfg) return [];
  const targets = ctx.changedFiles.length > 0 ? ctx.changedFiles : ["."];
  const res = await exec("semgrep", ["--json", "--quiet", "--config", cfg, ...targets], ctx);
  if (res.spawnError || res.timedOut || res.outputTooLarge) return [];
  const json = parseJson<{ results?: SemgrepResult[] }>(res.stdout);
  const results = json?.results;
  if (!Array.isArray(results)) return [];

  const out: RawFinding[] = [];
  for (const r of results) {
    const line = r.start?.line;
    if (typeof line !== "number") continue;
    const sev = (r.extra?.severity || "").toUpperCase();
    out.push({
      file: r.path,
      line,
      ruleId: r.check_id || "semgrep",
      message: r.extra?.message || "Semgrep matched a rule.",
      level: sev === "ERROR" ? "error" : sev === "INFO" ? "info" : "warning",
    });
  }
  return out;
}

interface SemgrepResult {
  path: string;
  check_id?: string;
  start?: { line?: number };
  extra?: { message?: string; severity?: string };
}

function localSemgrepConfig(cwd: string): string | null {
  for (const f of [".semgrep.yml", ".semgrep.yaml", "semgrep.yml", "semgrep.yaml"]) {
    const p = path.join(cwd, f);
    if (fileExists(p)) return p;
  }
  if (isDir(path.join(cwd, ".semgrep"))) return path.join(cwd, ".semgrep");
  return null;
}

// ─── Normalization ────────────────────────────────────────────────────────────

function severityFor(level: RawFinding["level"]): CommentSeverity {
  switch (level) {
    case "error":
      return "major";
    case "warning":
      return "minor";
    case "info":
      return "trivial";
  }
}

function normalize(
  source: StaticSource,
  raw: RawFinding[],
  cwd: string,
  changedFiles: string[],
  addedLines: Map<string, Set<number>>,
): ReviewComment[] {
  const changed = new Set(changedFiles);
  const out: ReviewComment[] = [];
  for (const r of raw) {
    const rel = toRepoRelative(r.file, cwd);
    if (!rel || !changed.has(rel)) continue; // only files in this PR
    const added = addedLines.get(rel);
    if (!added || !added.has(r.line)) continue; // only lines in the diff

    const severity = severityFor(r.level);
    const type = "issue" as const;
    const title = `${labelFor(source)}: ${r.ruleId}`;
    const body =
      `${r.message}\n\n` +
      `_Reported by **${labelFor(source)}** (rule \`${r.ruleId}\`) — DiffSentry static analysis. ` +
      `Disable with \`reviews.static_analysis.enabled: false\` in \`.diffsentry.yaml\`._`;
    const aiAgentPrompt =
      `In ${rel} at line ${r.line}, resolve the ${labelFor(source)} finding (rule ${r.ruleId}): ${r.message}`;
    const fingerprint = fpFor(rel, r.line, source, r.ruleId);
    out.push({
      path: rel,
      line: r.line,
      side: "RIGHT",
      type,
      severity,
      title,
      aiAgentPrompt,
      fingerprint,
      staticSource: source,
      body: renderInlineCommentBody({ title, body, type, severity, aiAgentPrompt, fingerprint }),
    });
  }
  return out;
}

function labelFor(source: StaticSource): string {
  switch (source) {
    case "eslint":
      return "ESLint";
    case "tsc":
      return "TypeScript";
    case "semgrep":
      return "Semgrep";
  }
}

function dedupeByFingerprint(findings: ReviewComment[]): ReviewComment[] {
  const seen = new Set<string>();
  const out: ReviewComment[] = [];
  for (const c of findings) {
    const key = c.fingerprint ?? `${c.path}:${c.line}:${c.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

// ─── Diff / path helpers ──────────────────────────────────────────────────────

/** Set of RIGHT-side (added) line numbers in a unified-diff patch. Mirrors the
 *  per-line walk used by the safety + pattern scanners. */
export function computeAddedLines(patch: string): Set<number> {
  const added = new Set<number>();
  // null until the first `@@ ... @@` header gives us a real RIGHT-side start.
  // Any body lines before that (malformed/nonstandard patch text) are ignored
  // so we never emit an invalid line 0 position.
  let rightLine: number | null = null;
  for (const raw of patch.split("\n")) {
    const hunk = raw.match(/^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
    if (hunk) {
      rightLine = parseInt(hunk[1], 10);
      continue;
    }
    if (rightLine === null) continue; // pre-hunk noise — no line numbering yet
    if (raw.startsWith("---") || raw.startsWith("+++")) continue;
    if (raw.startsWith("-")) continue;
    if (raw.startsWith("+")) {
      added.add(rightLine);
    }
    rightLine++;
  }
  return added;
}

/** Normalize an analyzer-reported path to a repo-relative POSIX path, or null if
 *  it escapes the checkout. Accepts absolute paths, plain relative paths, and
 *  `./`-prefixed / `..`-containing forms — `path.resolve`+`path.relative` fold
 *  all of those to the same canonical relative path before the escape check.
 *  Exported for tests (path mapping is the highest-risk step in this module). */
export function toRepoRelative(file: string, cwd: string): string | null {
  const abs = path.isAbsolute(file) ? path.normalize(file) : path.resolve(cwd, file);
  const rel = path.relative(cwd, abs);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join("/");
}

function fpFor(p: string, line: number, source: StaticSource, ruleId: string): string {
  return createHash("sha1").update(`${p}:${line}:static-${source}:${ruleId}`).digest("hex").slice(0, 12);
}

// ─── Process / fs primitives ──────────────────────────────────────────────────

interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Child was killed because its output exceeded MAX_OUTPUT_BYTES. The captured
   *  stdout/stderr is truncated, so callers treat this like a failed run. */
  outputTooLarge?: boolean;
  spawnError?: Error;
}

/**
 * Spawn a CLI, capture bounded stdout/stderr, and resolve (never reject) with
 * the outcome. Enforces a per-call timeout and honors the review's AbortSignal
 * by killing the child. Output is captured but never piped to our own stdio.
 */
function exec(cmd: string, args: string[], ctx: RunCtx): Promise<ExecResult> {
  return new Promise<ExecResult>((resolve) => {
    let settled = false;
    // Hoisted so the single cleanup path below can tear them down regardless of
    // which exit mode fires — including the synchronous spawn() failure, before
    // either is assigned. Both are optional and cleared defensively.
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    const finish = (r: ExecResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (onAbort) ctx.signal?.removeEventListener("abort", onAbort);
      resolve(r);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, { cwd: ctx.cwd, env: process.env, windowsHide: true });
    } catch (err) {
      finish({ code: null, stdout: "", stderr: "", timedOut: false, spawnError: err as Error });
      return;
    }

    let stdout = "";
    let stderr = "";
    let bytes = 0;
    let timedOut = false;
    let outputTooLarge = false;

    const onData = (which: "out" | "err") => (chunk: Buffer) => {
      // Once over the limit, stop buffering entirely and kill exactly once — the
      // subsequent `close` resolves the promise with the outputTooLarge flag.
      if (outputTooLarge) return;
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) {
        outputTooLarge = true;
        try {
          child.kill("SIGKILL");
        } catch {
          // already gone
        }
        return;
      }
      if (which === "out") stdout += chunk.toString("utf8");
      else stderr += chunk.toString("utf8");
    };

    child.stdout?.on("data", onData("out"));
    child.stderr?.on("data", onData("err"));

    if (ctx.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill("SIGKILL");
        } catch {
          // already gone
        }
      }, ctx.timeoutMs);
    }

    onAbort = () => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    };
    ctx.signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (err) => finish({ code: null, stdout, stderr, timedOut, outputTooLarge, spawnError: err }));
    child.on("close", (code) => finish({ code, stdout, stderr, timedOut, outputTooLarge }));
  });
}

function parseJson<T>(text: string): T | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    // Some tools prefix a banner before the JSON payload; recover the first
    // JSON array/object if a bare parse fails.
    const start = trimmed.search(/[[{]/);
    if (start > 0) {
      try {
        return JSON.parse(trimmed.slice(start)) as T;
      } catch {
        return null;
      }
    }
    return null;
  }
}

function fileExists(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
