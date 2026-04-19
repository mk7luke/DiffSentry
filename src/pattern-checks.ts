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
const BUILTIN_PATTERNS: Required<Pick<AntiPattern, "name" | "pattern" | "severity" | "type" | "message" | "advice">>[] = [
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
    name: "Math.random() used for token / id",
    pattern: "Math\\.random\\s*\\([^)]*\\)[^\\n]{0,80}\\b(token|id|key|secret|salt|nonce|otp|seed)\\b",
    severity: "major",
    type: "security",
    message:
      "`Math.random()` is not cryptographically secure — outputs are predictable enough to break tokens, IDs, OTPs, and similar secrets.",
    advice:
      "Use `crypto.randomUUID()` (modern Node + browsers) or `crypto.randomBytes(n).toString('hex')` for keyed material.",
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

type CompiledPattern = {
  rule: AntiPattern & { severity: CommentSeverity; type: CommentType };
  regex: RegExp;
  isBuiltin: boolean;
};

function buildPatterns(repoConfig: RepoConfig | undefined): CompiledPattern[] {
  const out: CompiledPattern[] = [];
  const builtinEnabled = repoConfig?.reviews?.builtin_patterns !== false;
  if (builtinEnabled) {
    for (const r of BUILTIN_PATTERNS) {
      const rx = compile({ pattern: r.pattern });
      if (!rx) continue;
      out.push({
        rule: { ...r, severity: r.severity, type: r.type },
        regex: rx,
        isBuiltin: true,
      });
    }
  }
  for (const r of repoConfig?.reviews?.anti_patterns ?? []) {
    const rx = compile(r);
    if (!rx) continue;
    out.push({
      rule: {
        ...r,
        severity: (r.severity ?? "minor") as CommentSeverity,
        type: (r.type ?? "suggestion") as CommentType,
      },
      regex: rx,
      isBuiltin: false,
    });
  }
  return out;
}

export function runPatternChecks(
  files: FileChange[],
  repoConfig: RepoConfig | undefined,
): ReviewComment[] {
  const patterns = buildPatterns(repoConfig);
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
              p.isBuiltin
                ? "_DiffSentry built-in pattern check — disable globally with `reviews.builtin_patterns: false`._"
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
