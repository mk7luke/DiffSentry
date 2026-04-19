import type { AIProvider, FileChange, LicenseHeaderConfig, PRContext } from "./types.js";
import { minimatch } from "minimatch";

/**
 * Compares the PR description's claims against the actual diff, asks the
 * AI to flag mismatches: claims with no supporting code, large changes
 * the description omits, or contradictory wording.
 */
export type DriftFinding = {
  level: "warning" | "info";
  summary: string;
  details: string;
};

export async function detectDescriptionDrift(opts: {
  ai: AIProvider;
  context: PRContext;
}): Promise<DriftFinding[]> {
  const desc = opts.context.description.trim();
  if (desc.length < 30) {
    return [
      {
        level: "warning",
        summary: "PR description is too short to drift-check.",
        details:
          "The PR description has less than 30 characters of meaningful content. " +
          "Consider expanding it so reviewers can see at a glance what changed and why.",
      },
    ];
  }

  const ask = `Compare the PR description against the actual code diff. Identify any DRIFT — claims in the description that aren't reflected in the code, OR significant changes in the code that the description doesn't mention.

Respond with ONLY a JSON array (no prose, no code fences). Each entry:
{
  "level": "warning" | "info",
  "summary": "one-line summary",
  "details": "1-3 sentences with specifics referencing files/symbols"
}

Use "warning" only when the drift is meaningful: missing critical changes, contradictory claims, or unsupported features named. Use "info" for minor omissions. If the description matches the diff well, return an empty array [].

Be specific — name files and identifiers, don't say "various changes".`;

  const raw = await opts.ai.chat(opts.context, ask);
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
  try {
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((f) => f && typeof f.summary === "string")
      .map((f) => ({
        level: f.level === "info" ? "info" : "warning",
        summary: String(f.summary).slice(0, 200),
        details: String(f.details ?? "").slice(0, 600),
      })) as DriftFinding[];
  } catch {
    return [];
  }
}

export function renderDriftBlock(findings: DriftFinding[]): string {
  if (findings.length === 0) return "";
  const lines: string[] = [];
  lines.push("## 🧭 Description Drift");
  lines.push("");
  for (const f of findings) {
    const icon = f.level === "warning" ? "⚠️" : "ℹ️";
    lines.push(`- ${icon} **${f.summary}**`);
    if (f.details) lines.push(`  - ${f.details}`);
  }
  lines.push("");
  lines.push(
    "<sub>Compares PR description claims to the actual diff. Update the description (or the code) so they tell the same story.</sub>",
  );
  return lines.join("\n");
}

// ─── Commit message coach ───────────────────────────────────────

export type CommitFinding = {
  sha: string;
  shaShort: string;
  message: string;
  level: "ok" | "weak" | "bad";
  reasons: string[];
};

const WEAK_MESSAGE_PATTERNS = [
  /^wip\b/i,
  /^fix\.?$/i,
  /^update\.?$/i,
  /^updates?\.?$/i,
  /^changes?\.?$/i,
  /^stuff\.?$/i,
  /^minor( changes?| fixes?)?\.?$/i,
  /^cleanup\.?$/i,
  /^test\.?$/i,
  /^asdf+$/i,
  /^\.+$/,
  /^[a-z]\.?$/i,
];

export function reviewCommitMessages(commits: Array<{ sha: string; message: string }>): CommitFinding[] {
  const out: CommitFinding[] = [];
  for (const c of commits) {
    const subject = c.message.split("\n")[0].trim();
    const reasons: string[] = [];
    let level: CommitFinding["level"] = "ok";

    if (subject.length === 0) {
      reasons.push("Empty subject line.");
      level = "bad";
    } else if (subject.length < 8) {
      reasons.push(`Subject is only ${subject.length} characters — too short to convey intent.`);
      level = "bad";
    } else if (subject.length > 72) {
      reasons.push(`Subject is ${subject.length} characters — keep under 72 to avoid truncation.`);
      // The two earlier branches return "bad", so reaching here means level === "ok".
      level = "weak";
    }

    if (WEAK_MESSAGE_PATTERNS.some((re) => re.test(subject))) {
      reasons.push(`Subject "${subject}" doesn't say what changed. Use an imperative verb + the thing being changed.`);
      level = "bad";
    }

    if (subject && !/^[A-Z]/.test(subject) && !/^[a-z][a-z0-9_-]*(\([^)]+\))?!?:\s/.test(subject)) {
      // Allow Conventional Commits prefix (e.g. `feat:`, `fix(scope)!:`); otherwise expect capitalization.
      reasons.push("Subject doesn't start with a capital letter or a Conventional Commits prefix (e.g. `feat:`).");
      level = level === "ok" ? "weak" : level;
    }

    if (subject.endsWith(".")) {
      reasons.push("Subject ends with a period — drop it (subjects aren't sentences).");
      level = level === "ok" ? "weak" : level;
    }

    out.push({
      sha: c.sha,
      shaShort: c.sha.slice(0, 7),
      message: c.message,
      level,
      reasons,
    });
  }
  return out;
}

export function renderCommitCoachBlock(findings: CommitFinding[]): string {
  const flagged = findings.filter((f) => f.level !== "ok");
  if (flagged.length === 0) return "";

  const lines: string[] = [];
  lines.push("## ✍️ Commit Message Coach");
  lines.push("");
  lines.push(`${flagged.length} of ${findings.length} commit message${findings.length === 1 ? "" : "s"} could be stronger.`);
  lines.push("");
  lines.push("| Commit | Subject | Issues |");
  lines.push("|---|---|---|");
  for (const f of flagged) {
    const icon = f.level === "bad" ? "🔴" : "🟡";
    const subject = f.message.split("\n")[0];
    const issues = f.reasons.join(" ");
    lines.push(`| \`${f.shaShort}\` | ${icon} ${escapeCell(subject)} | ${escapeCell(issues)} |`);
  }
  lines.push("");
  lines.push(
    "<sub>Tip: imperative mood (`Add user lookup`), under 72 chars, no trailing period. Conventional Commits like `feat:` / `fix:` are also fine.</sub>",
  );
  return lines.join("\n");
}

function escapeCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

// ─── PR title coach ─────────────────────────────────────────────

const VAGUE_TITLE_PATTERNS = [
  /^(update|fix|change|tweak|cleanup|refactor)s?$/i,
  /^wip\b/i,
  /^(misc|minor|small)( changes?| fixes?| updates?)?$/i,
];

const IMPERATIVE_VERBS = [
  "add",
  "remove",
  "fix",
  "rename",
  "move",
  "extract",
  "introduce",
  "replace",
  "support",
  "drop",
  "split",
  "merge",
  "wire",
  "expose",
  "harden",
  "switch",
  "bump",
  "upgrade",
  "downgrade",
  "deprecate",
  "convert",
  "migrate",
  "enable",
  "disable",
  "implement",
  "guard",
  "log",
  "document",
  "polish",
  "refactor",
  "simplify",
  "make",
  "use",
  "skip",
  "show",
  "hide",
  "load",
  "save",
];

const CONVENTIONAL_PREFIX_RE = /^[a-z][a-z0-9_-]*(\([^)]+\))?!?:\s/;

export type TitleFinding = {
  level: "ok" | "weak" | "bad";
  reasons: string[];
};

export function reviewPRTitle(title: string): TitleFinding {
  const reasons: string[] = [];
  let level: TitleFinding["level"] = "ok";
  const t = title.trim();

  if (t.length === 0) {
    return { level: "bad", reasons: ["Title is empty."] };
  }
  if (t.length < 10) {
    reasons.push(`Title is only ${t.length} characters — too short to convey intent.`);
    level = "bad";
  }
  if (t.length > 80) {
    reasons.push(`Title is ${t.length} characters — keep under 80 for readability in lists and notification subjects.`);
    level = level === "ok" ? "weak" : level;
  }
  if (VAGUE_TITLE_PATTERNS.some((re) => re.test(t))) {
    reasons.push(`Title "${t}" doesn't say what changed. Use an imperative verb plus the thing being changed.`);
    level = "bad";
  }
  if (t.endsWith(".")) {
    reasons.push("Title ends with a period — drop it (titles aren't sentences).");
    level = level === "ok" ? "weak" : level;
  }
  // Imperative-verb check (only if not Conventional Commits prefixed)
  if (!CONVENTIONAL_PREFIX_RE.test(t)) {
    const firstWord = t.replace(/^["'`(]+/, "").split(/\s|[:,.]/)[0]?.toLowerCase() ?? "";
    if (firstWord && !IMPERATIVE_VERBS.includes(firstWord)) {
      // Past-tense smell: "Added X", "Fixed Y" — common but worth flagging.
      if (/(ed|ing)$/i.test(firstWord)) {
        reasons.push(`Title starts with "${firstWord}" — prefer imperative mood (e.g. "Add ..." not "Added ..." / "Adding ...").`);
        level = level === "ok" ? "weak" : level;
      }
    }
  }
  return { level, reasons };
}

export function renderTitleCoachBlock(title: string, finding: TitleFinding): string {
  if (finding.level === "ok") return "";
  const icon = finding.level === "bad" ? "🔴" : "🟡";
  const lines: string[] = [];
  lines.push("## 🏷️ PR Title Coach");
  lines.push("");
  lines.push(`${icon} **${title}**`);
  lines.push("");
  for (const r of finding.reasons) lines.push(`- ${r}`);
  lines.push("");
  lines.push(
    "<sub>Tip: imperative verb + concrete object, under 80 chars, no trailing period. `feat:` / `fix:` prefixes are also fine.</sub>",
  );
  return lines.join("\n");
}

// ─── License header scanner ─────────────────────────────────────

const DEFAULT_LICENSE_PATHS = [
  "src/**/*.{ts,tsx,js,jsx,mjs,cjs,py,go,rs,java,kt,cs,rb,php,swift,scala}",
  "lib/**/*.{ts,tsx,js,jsx,mjs,cjs,py,go,rs,java,kt,cs,rb,php,swift,scala}",
];

export function scanLicenseHeaders(
  files: FileChange[],
  config: LicenseHeaderConfig | undefined,
): string[] {
  if (!config?.required) return [];
  const required = config.required.trim();
  if (!required) return [];
  const paths = config.paths ?? DEFAULT_LICENSE_PATHS;

  // Only "added" files get checked — modifying an existing file shouldn't
  // demand a header retrofit.
  const offenders: string[] = [];
  for (const f of files) {
    if (f.status !== "added") continue;
    if (!paths.some((p) => minimatch(f.filename, p, { dot: true }))) continue;
    // Reconstruct the new file's first ~10 lines from the patch
    const headLines: string[] = [];
    for (const raw of f.patch.split("\n")) {
      if (raw.startsWith("@@") || raw.startsWith("---") || raw.startsWith("+++")) continue;
      if (!raw.startsWith("+")) continue;
      headLines.push(raw.slice(1));
      if (headLines.length >= 12) break;
    }
    const head = headLines.join("\n").trim();
    if (!head.includes(required.split("\n")[0].trim())) {
      offenders.push(f.filename);
    }
  }
  return offenders;
}

export function renderLicenseHeaderBlock(offenders: string[], required: string): string {
  if (offenders.length === 0) return "";
  const lines: string[] = [];
  lines.push("## 📜 Missing License Headers");
  lines.push("");
  lines.push(`${offenders.length} new source file${offenders.length === 1 ? "" : "s"} missing the required header:`);
  lines.push("");
  for (const p of offenders) lines.push(`- \`${p}\``);
  lines.push("");
  lines.push("Required header (first line):");
  lines.push("");
  lines.push("```");
  lines.push(required.split("\n")[0]);
  lines.push("```");
  return lines.join("\n");
}
