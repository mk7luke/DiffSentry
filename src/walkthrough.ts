import type { WalkthroughResult, WalkthroughConfig } from "./types.js";

const EFFORT_LABELS: Record<number, string> = {
  1: "Trivial",
  2: "Simple",
  3: "Moderate",
  4: "Complex",
  5: "Very Complex",
};

const DEFAULT_EFFORT_MINUTES: Record<number, number> = {
  1: 5,
  2: 15,
  3: 30,
  4: 60,
  5: 120,
};

function formatEffortLine(level: number, minutes?: number): string {
  const clamped = Math.max(1, Math.min(5, Math.round(level)));
  const word = EFFORT_LABELS[clamped] ?? "Moderate";
  const mins = minutes && minutes > 0 ? minutes : DEFAULT_EFFORT_MINUTES[clamped];
  return `🎯 ${clamped} (${word}) | ⏱️ ~${mins} minutes`;
}

function renderChangesTable(result: WalkthroughResult): string | null {
  const cohorts = result.cohorts;
  if (cohorts && cohorts.length > 0) {
    const header = "|Cohort / File(s)|Summary|\n|---|---|";
    const rows = cohorts.map((c) => {
      const files = c.files.map((f) => `\`${f}\``).join(", ");
      const cell = `**${c.label}** <br> ${files}`;
      const summary = c.summary.replace(/\|/g, "\\|");
      return `|${cell}|${summary}|`;
    });
    return `## Changes\n\n${header}\n${rows.join("\n")}`;
  }

  if (result.fileDescriptions.length > 0) {
    const header = "| File | Status | Summary |\n|------|--------|---------|";
    const rows = result.fileDescriptions.map(
      (f) => `| \`${f.filename}\` | ${f.status} | ${f.changeDescription} |`,
    );
    const table = `${header}\n${rows.join("\n")}`;
    if (result.fileDescriptions.length > 10) {
      return `## Changes\n\n<details>\n<summary>Changed files (${result.fileDescriptions.length})</summary>\n\n${table}\n\n</details>`;
    }
    return `## Changes\n\n${table}`;
  }

  return null;
}

/**
 * Render the inner body of the walkthrough (no collapse wrapper). The
 * caller wraps in `<details>` and may inject extra sections (related PRs,
 * linked issues) before wrapping.
 */
export function formatWalkthroughInner(
  result: WalkthroughResult,
  config: WalkthroughConfig,
): string {
  const sections: string[] = [];

  sections.push(`## Walkthrough\n\n${result.summary}`);

  if (config.changed_files_summary !== false) {
    const changes = renderChangesTable(result);
    if (changes) sections.push(changes);
  }

  const diagrams =
    result.sequenceDiagrams && result.sequenceDiagrams.length > 0
      ? result.sequenceDiagrams
      : result.sequenceDiagram
      ? [result.sequenceDiagram]
      : [];
  if (config.sequence_diagrams && diagrams.length > 0) {
    const blocks = diagrams.map((d) => `\`\`\`mermaid\n${d}\n\`\`\``).join("\n\n");
    sections.push(`## Sequence Diagram(s)\n\n${blocks}`);
  }

  if (config.estimate_effort && result.effortEstimate !== undefined) {
    sections.push(
      `## Estimated code review effort\n\n${formatEffortLine(result.effortEstimate, result.effortMinutes)}`,
    );
  }

  if (config.suggested_labels && result.suggestedLabels?.length) {
    const labels = result.suggestedLabels.map((l) => `\`${l}\``).join(", ");
    sections.push(`## Suggested Labels\n\n${labels}`);
  }

  if (config.suggested_reviewers && result.suggestedReviewers?.length) {
    const reviewers = result.suggestedReviewers
      .map((r) => (r.startsWith("@") ? r : `@${r}`))
      .join(", ");
    sections.push(`## Suggested Reviewers\n\n${reviewers}`);
  }

  if (config.poem && result.poem) {
    sections.push(`## Poem\n\n${result.poem}`);
  }

  return sections.join("\n\n");
}

/**
 * Wrap an arbitrary inner block in the walkthrough <details> collapse
 * (or return as-is when collapse is disabled).
 */
export function wrapWalkthroughCollapse(inner: string, collapse: boolean): string {
  if (!collapse) return inner;
  return `<details>\n<summary>📝 Walkthrough</summary>\n\n${inner}\n\n</details>`;
}

/**
 * Backward-compatible single-call form (no extra inner sections).
 */
export function formatWalkthrough(
  result: WalkthroughResult,
  config: WalkthroughConfig,
): string {
  return wrapWalkthroughCollapse(formatWalkthroughInner(result, config), config.collapse !== false);
}

// ─── formatPRSummary ──────────────────────────────────────────

export function formatPRSummary(result: WalkthroughResult): string {
  const rows = result.fileDescriptions
    .map((f) => `| \`${f.filename}\` | ${f.changeDescription} |`)
    .join("\n");

  const table =
    result.fileDescriptions.length > 0
      ? `\n### Changes\n| File | Changes |\n|------|---------|${rows ? "\n" + rows : ""}`
      : "";

  return `<!-- DiffSentry Summary -->\n## Summary\n\n${result.summary}\n${table}\n<!-- End DiffSentry Summary -->`;
}

// ─── injectSummaryIntoPRBody ──────────────────────────────────

const SUMMARY_START = "<!-- DiffSentry Summary -->";
const SUMMARY_END = "<!-- End DiffSentry Summary -->";

export function injectSummaryIntoPRBody(
  existingBody: string,
  summary: string,
): string {
  const startIdx = existingBody.indexOf(SUMMARY_START);
  const endIdx = existingBody.indexOf(SUMMARY_END);

  if (startIdx !== -1 && endIdx !== -1) {
    const before = existingBody.slice(0, startIdx);
    const after = existingBody.slice(endIdx + SUMMARY_END.length);
    return before + summary + after;
  }

  if (existingBody.trim().length === 0) {
    return summary;
  }

  return `${existingBody}\n\n---\n\n${summary}`;
}
