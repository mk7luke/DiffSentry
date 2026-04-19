import type { AIProvider, FileChange, PRContext } from "./types.js";

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

    if (subject && !/^[A-Z]/.test(subject) && !/^[a-z]+(\([^)]+\))?:/.test(subject)) {
      // allow conventional-commits prefix; otherwise expect capitalization
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
