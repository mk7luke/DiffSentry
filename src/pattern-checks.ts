import { createHash } from "node:crypto";
import { minimatch } from "minimatch";
import type {
  AntiPattern,
  CommentSeverity,
  CommentType,
  FileChange,
  RepoConfig,
  ReviewComment,
} from "./types.js";
import { renderInlineCommentBody } from "./ai/parse.js";

/**
 * Built-in performance / footgun heuristics. Tight regexes only — false
 * positives are a trust killer. Each entry produces an inline review
 * comment when matched on an added line.
 */
type BuiltinPattern = Required<Pick<AntiPattern, "name" | "pattern" | "severity" | "type" | "message" | "advice">> & { path?: string };

const BUILTIN_PATTERNS: BuiltinPattern[] = [
  {
    name: "async callback in .forEach",
    // arr.forEach(async (...) => ...)   .forEach(async function ...)
    pattern: "\\.forEach\\s*\\(\\s*async\\b",
    severity: "major",
    type: "issue",
    message:
      "`Array.prototype.forEach` ignores the promises returned by an async callback. Errors are silently swallowed and ordering / completion is not awaited — `forEach` returns before the work finishes.",
    advice:
      "Use `for (const x of arr) { await ... }` if order matters, or `await Promise.all(arr.map(async (x) => ...))` for parallel execution.",
  },
  {
    name: "Deep clone via JSON.parse(JSON.stringify(...))",
    pattern: "JSON\\.parse\\s*\\(\\s*JSON\\.stringify\\s*\\(",
    severity: "minor",
    type: "suggestion",
    message:
      "`JSON.parse(JSON.stringify(x))` silently drops `undefined`, functions, `Date` (becomes string), `Map`/`Set`, `Symbol`, and circular refs. It's also significantly slower than purpose-built deep-clone helpers.",
    advice:
      "Prefer `structuredClone(x)` (Node 17+, modern browsers). Use `lodash.cloneDeep` if you need to support older runtimes.",
  },
  {
    name: "child_process.exec with template literal",
    pattern: "child_process\\.exec(?:Sync|File|FileSync)?\\s*\\(\\s*`",
    severity: "critical",
    type: "security",
    message:
      "Calling `exec` with a template literal lets unsanitized values become shell metacharacters — classic shell-injection foothold.",
    advice:
      "Use `execFile` / `spawn` with an args array so the shell never sees user input. If you need shell features, escape values explicitly (e.g. `shell-quote.quote`).",
  },
  {
    name: "setInterval without stored handle",
    // bare expression statement, not assigned anywhere
    pattern: "(?:^|[^=\\w.$])setInterval\\s*\\(",
    severity: "minor",
    type: "suggestion",
    message:
      "An unassigned `setInterval` call has no handle, so it can't be cleared. The timer leaks for the lifetime of the process and fires forever even after the calling component/handler is gone.",
    advice:
      "Capture the return value (`const id = setInterval(...)`) and pair every `setInterval` with a `clearInterval(id)` in the corresponding cleanup path.",
  },
  {
    name: "RegExp built from a variable",
    pattern: "new\\s+RegExp\\s*\\(\\s*[A-Za-z_$][\\w$]*\\s*[,)]",
    severity: "minor",
    type: "suggestion",
    message:
      "Constructing a `RegExp` from a runtime string risks ReDoS or accidental injection of regex metacharacters from user input.",
    advice:
      "Validate the source against a strict allowlist before passing it to `RegExp`, or escape with a helper like `escape-string-regexp`. Consider a pre-built RegExp literal where possible.",
  },
  {
    name: "Math.random() used to build a string id",
    // Detect the common ID-generation idioms: Math.random().toString(...)
    // or Math.random() * 1eN — both shape randomness into token-like output.
    pattern: "Math\\.random\\s*\\(\\s*\\)\\s*(?:\\.toString|\\*\\s*1e)",
    severity: "major",
    type: "security",
    message:
      "`Math.random()` is not cryptographically secure — outputs are predictable enough to forge tokens, session IDs, OTPs, and other secrets. Both `Math.random().toString(36)` and `Math.random() * 1eN` are common ID-generation shortcuts that should not be used for anything authentication-adjacent.",
    advice:
      "Use `crypto.randomUUID()` for IDs or `crypto.randomBytes(n).toString('hex')` for keyed material.",
  },
  {
    name: "setTimeout / setInterval with string body",
    pattern: "(setTimeout|setInterval)\\s*\\(\\s*['\"`]",
    severity: "major",
    type: "security",
    message:
      "Passing a string to `setTimeout`/`setInterval` invokes `eval` on it, exposing an injection surface and breaking minifiers / strict CSPs.",
    advice: "Pass an inline arrow function instead: `setTimeout(() => doThing(), ms)`.",
  },
  {
    name: "Wide-open CORS",
    // app.use(cors()) or cors({ origin: "*" }) or origin: true
    pattern:
      "(?:app\\.use\\s*\\(\\s*cors\\s*\\(\\s*\\)|cors\\s*\\(\\s*\\{[^}]*origin\\s*:\\s*(?:['\"]\\*['\"]|true))",
    severity: "major",
    type: "security",
    message:
      "Permissive CORS exposes endpoints to any origin, including malicious ones. Combined with credentialed requests this lets third-party sites act on behalf of authenticated users.",
    advice:
      "Pass an explicit allowlist: `cors({ origin: ['https://app.example.com'], credentials: true })`. Even better, derive the list from config.",
  },
  {
    name: "Object.assign as object spread",
    pattern: "Object\\.assign\\s*\\(\\s*\\{\\s*\\}\\s*,",
    severity: "trivial",
    type: "nitpick",
    message: "`Object.assign({}, ...)` can be expressed more concisely as a spread.",
    advice: "Replace with `{ ...a, ...b }` for readability and to keep prototypes/getters consistent.",
  },

  // ─── Accessibility (JSX/TSX) ──────────────────────────────────
  {
    name: "<img> without alt attribute",
    pattern: "<img(?![^>]*\\salt\\s*=)[^>]*/?>",
    severity: "minor",
    type: "issue",
    message: "Images without an `alt` attribute are invisible to screen readers and can fail accessibility audits.",
    advice: "Add `alt=\"\"` for purely decorative images, or a descriptive string for meaningful ones.",
  },
  {
    name: "<button> with no accessible name",
    // <button>...</button> with no text content AND no aria-label/aria-labelledby
    pattern: "<button(?![^>]*\\b(?:aria-label|aria-labelledby)\\s*=)[^>]*>\\s*<\\/button>",
    severity: "minor",
    type: "issue",
    message: "An empty `<button>` with no `aria-label` is unlabeled to assistive tech and unusable via keyboard navigation.",
    advice: "Add `aria-label=\"...\"` or visible text content describing the action.",
  },
  {
    name: "onClick on non-interactive element",
    // <div onClick=... or <span onClick=... lacking role/keyboard handlers
    pattern: "<(?:div|span)(?![^>]*\\brole\\s*=)[^>]*\\bonClick\\s*=",
    severity: "minor",
    type: "issue",
    message: "Click handlers on `<div>` / `<span>` aren't focusable and don't fire on keyboard activation. Screen reader and keyboard users can't reach them.",
    advice: "Use a `<button>` (preferred) or add `role=\"button\"`, `tabIndex={0}`, and a matching `onKeyDown` handler.",
  },

  // ─── i18n / localization ──────────────────────────────────────
  {
    name: "Hardcoded user-facing string in JSX text",
    // >Plain English< inside JSX, not wrapped in {t(...)} or {i18n.*}
    // Heuristic: > ... < containing 2+ words and a lowercase letter,
    // not interpolated and not whitespace-only.
    pattern: ">\\s*[A-Z][A-Za-z][A-Za-z0-9 ,!\\?'-]{8,}\\s*<",
    severity: "minor",
    type: "documentation",
    message: "Hardcoded strings inside JSX bypass the translation pipeline and break for non-English users.",
    advice: "Wrap in your i18n helper, e.g. `{t('users.greeting', { name })}` instead of literal text.",
    path: "**/*.{tsx,jsx}",
  },
];

function fpFor(path: string, line: number, ruleName: string): string {
  return createHash("sha1")
    .update(`${path}:${line}:pattern:${ruleName}`)
    .digest("hex")
    .slice(0, 12);
}

function compile(rule: { pattern: string; flags?: string }): RegExp | null {
  try {
    return new RegExp(rule.pattern, rule.flags ?? "");
  } catch {
    return null;
  }
}

/**
 * Validate a regex (and optional flags) without running it. Used by the API so
 * a bad rule is rejected at author time instead of silently dropped at review
 * time. Returns the error message on failure.
 */
export function validatePattern(pattern: string, flags?: string): { ok: boolean; error?: string } {
  if (typeof pattern !== "string" || pattern.length === 0) {
    return { ok: false, error: "Pattern must be a non-empty string." };
  }
  try {
    new RegExp(pattern, flags ?? "");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Invalid regular expression." };
  }
}

// Where a compiled pattern came from. "builtin" = shipped heuristic; "config" =
// a `.diffsentry.yaml` anti_pattern; "custom" = an admin-authored command-center
// rule. The last two both record as source='custom' but render distinct footers.
type PatternOrigin = "builtin" | "config" | "custom";

type CompiledPattern = {
  rule: AntiPattern & { severity: CommentSeverity; type: CommentType };
  regex: RegExp;
  origin: PatternOrigin;
};

function compileUserPattern(r: AntiPattern, origin: PatternOrigin): CompiledPattern | null {
  const rx = compile(r);
  if (!rx) return null;
  return {
    rule: {
      ...r,
      severity: (r.severity ?? "minor") as CommentSeverity,
      type: (r.type ?? "suggestion") as CommentType,
    },
    regex: rx,
    origin,
  };
}

function buildPatterns(
  repoConfig: RepoConfig | undefined,
  customRules: AntiPattern[] = [],
): CompiledPattern[] {
  const out: CompiledPattern[] = [];
  const builtinEnabled = repoConfig?.reviews?.builtin_patterns !== false;
  if (builtinEnabled) {
    for (const r of BUILTIN_PATTERNS) {
      const rx = compile({ pattern: r.pattern });
      if (!rx) continue;
      out.push({
        rule: { ...r, severity: r.severity, type: r.type },
        regex: rx,
        origin: "builtin",
      });
    }
  }
  for (const r of repoConfig?.reviews?.anti_patterns ?? []) {
    const c = compileUserPattern(r, "config");
    if (c) out.push(c);
  }
  // Admin-authored rules from the command center (already filtered to enabled +
  // applicable scope by the DAO). They compose with built-ins and file rules.
  for (const r of customRules) {
    const c = compileUserPattern(r, "custom");
    if (c) out.push(c);
  }
  return out;
}

export function runPatternChecks(
  files: FileChange[],
  repoConfig: RepoConfig | undefined,
  customRules: AntiPattern[] = [],
): ReviewComment[] {
  const patterns = buildPatterns(repoConfig, customRules);
  if (patterns.length === 0) return [];

  const comments: ReviewComment[] = [];

  for (const f of files) {
    if (!f.patch) continue;
    const applicable = patterns.filter((p) => !p.rule.path || minimatch(f.filename, p.rule.path));
    if (applicable.length === 0) continue;

    let rightLine = 0;
    for (const raw of f.patch.split("\n")) {
      const hunk = raw.match(/^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
      if (hunk) {
        rightLine = parseInt(hunk[1], 10);
        continue;
      }
      if (raw.startsWith("---") || raw.startsWith("+++")) continue;
      if (raw.startsWith("-")) continue;
      const isAdded = raw.startsWith("+");
      const content = raw.startsWith("+") || raw.startsWith(" ") ? raw.slice(1) : raw;

      if (isAdded) {
        for (const p of applicable) {
          if (p.regex.test(content)) {
            const title = p.rule.name;
            const bodyParts: string[] = [];
            if (p.rule.message) bodyParts.push(p.rule.message);
            if (p.rule.advice) bodyParts.push(`**Suggested fix:** ${p.rule.advice}`);
            bodyParts.push(
              p.origin === "builtin"
                ? "_DiffSentry built-in pattern check — disable globally with `reviews.builtin_patterns: false`._"
                : p.origin === "custom"
                  ? "_Custom rule (managed in the DiffSentry command center)._"
                  : "_Project anti-pattern from `.diffsentry.yaml`._",
            );
            const body = bodyParts.join("\n\n");
            const aiAgentPrompt =
              `In ${f.filename} at line ${rightLine}, the line matches the "${p.rule.name}" anti-pattern. ` +
              `${p.rule.advice ?? p.rule.message ?? "Address the flagged pattern."}`;
            const fingerprint = fpFor(f.filename, rightLine, p.rule.name);
            comments.push({
              path: f.filename,
              line: rightLine,
              side: "RIGHT",
              type: p.rule.type,
              severity: p.rule.severity,
              title,
              aiAgentPrompt,
              fingerprint,
              patternSource: p.origin === "builtin" ? "builtin" : "custom",
              body: renderInlineCommentBody({
                title,
                body,
                type: p.rule.type,
                severity: p.rule.severity,
                aiAgentPrompt,
                fingerprint,
              }),
            });
          }
        }
      }
      rightLine++;
    }
  }

  return comments;
}

// ─── Live rule tester (no persistence) ─────────────────────────────

export interface PatternTestInput {
  pattern: string;
  flags?: string;
  /** Optional minimatch glob — when set, matching only runs if `filename` fits. */
  path?: string;
}

export interface PatternTestMatch {
  /** 1-based line number within the pasted snippet. */
  line: number;
  /** The full source line (leading diff "+" stripped). */
  text: string;
  /** The exact substring the regex matched. */
  match: string;
}

export interface PatternTestResult {
  /** False when the regex failed to compile (`error` carries why). */
  ok: boolean;
  error?: string;
  /** False when a path glob is set and `filename` doesn't satisfy it. */
  applies: boolean;
  matches: PatternTestMatch[];
}

/** Hard cap so a pathological rule + huge paste can't balloon the response. */
const MAX_TEST_MATCHES = 200;

/**
 * Run a candidate rule against a pasted snippet without touching the database.
 * Mirrors runPatternChecks' per-line semantics: each line is treated as an
 * added line (a leading "+" is tolerated so a raw diff can be pasted), and the
 * optional path glob is honored against `filename`. Returns every matching line
 * (capped) plus the matched substring, or a compile error.
 */
export function testPattern(input: PatternTestInput, snippet: string, filename?: string): PatternTestResult {
  const regex = compile(input);
  if (!regex) {
    const v = validatePattern(input.pattern, input.flags);
    return { ok: false, error: v.error ?? "Invalid regular expression.", applies: false, matches: [] };
  }
  // If a glob is set we need a filename to judge applicability. With no filename
  // we still run (so the tester is useful), but report applies=false so the UI
  // can hint that scope wasn't exercised.
  const applies = !input.path || (!!filename && minimatch(filename, input.path));
  if (input.path && !applies) {
    return { ok: true, applies: false, matches: [] };
  }

  const matches: PatternTestMatch[] = [];
  const lines = snippet.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (matches.length >= MAX_TEST_MATCHES) break;
    const raw = lines[i];
    // Tolerate pasted diffs: skip hunk/headers and removed lines, strip the
    // leading marker so the regex sees the real source.
    if (raw.startsWith("@@") || raw.startsWith("---") || raw.startsWith("+++")) continue;
    if (raw.startsWith("-")) continue;
    const content = raw.startsWith("+") || raw.startsWith(" ") ? raw.slice(1) : raw;
    // Fresh lastIndex per line — a global-flagged regex is stateful otherwise.
    regex.lastIndex = 0;
    const m = regex.exec(content);
    if (m) {
      matches.push({ line: i + 1, text: content, match: m[0] });
    }
  }
  return { ok: true, applies: true, matches };
}
