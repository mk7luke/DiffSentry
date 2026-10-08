import { PRContext, PreMergeConfig, CheckResult, CheckOutcome } from "./types.js";
import { logger } from "./logger.js";
import { stripFences } from "./ai/parse.js";

/** One AI evaluation: the instruction in, a verdict out. */
export type AiCheck = (name: string, instruction: string) => Promise<{ outcome: CheckOutcome; message: string }>;

/**
 * The prompt for one AI-evaluated check.
 *
 * The rules exist because the old prompt had no way to say "this doesn't apply"
 * or "I can't see it". A migration-id check on a PR with no migrations, or on a
 * PR whose migration diffs were budgeted out, came back as a failed `error` —
 * which turned `DiffSentry / Pre-Merge` red over nothing and made `ship` report
 * the PR as blocked by DiffSentry's own check. Only evidence fails a check now.
 */
export function buildCheckPrompt(name: string, instruction: string, unavailableFiles: string[] = []): string {
  const unavailable = [...new Set(unavailableFiles)];
  const scopeNote =
    unavailable.length > 0
      ? `\n\nThese files are part of the PR but their diffs are NOT shown to you: ${unavailable
          .map((f) => `\`${f}\``)
          .join(", ")}. You cannot see their contents.`
      : "";

  return `Pre-merge check "${name}":
${instruction.trim()}${scopeNote}

Evaluate this check against the PR above (title, description, and the diffs shown). Pick exactly one outcome:
- "pass": the PR satisfies the check, OR the check does not apply because the PR touches nothing it is about (for example a check about migrations on a PR that changes no migration files). For the second case start the message with "Not applicable —".
- "fail": you can point to concrete evidence in the title, description, or a shown diff that violates the check. Name the file (and line when relevant) or quote the text.
- "inconclusive": the check applies, but the files it concerns are not shown to you, so you cannot tell either way.

Never fail a check because something is not shown — that is "inconclusive". Never ask the author to go verify something manually.

Respond with JSON only: {"outcome": "pass" | "fail" | "inconclusive", "message": "one or two sentences"}`;
}

/** Parse the model's reply. Anything unreadable is inconclusive, never a silent pass. */
export function parseCheckResponse(raw: string): { outcome: CheckOutcome; message: string } {
  try {
    const parsed = JSON.parse(stripFences(raw));
    const message = typeof parsed.message === "string" ? parsed.message : "";
    const o = typeof parsed.outcome === "string" ? parsed.outcome.toLowerCase() : undefined;
    if (o === "pass" || o === "passed") return { outcome: "passed", message };
    if (o === "fail" || o === "failed") return { outcome: "failed", message };
    if (o === "inconclusive") return { outcome: "inconclusive", message };
    // Legacy shape: {"passed": bool}.
    if (typeof parsed.passed === "boolean") return { outcome: parsed.passed ? "passed" : "failed", message };
  } catch {
    // fall through
  }
  return { outcome: "inconclusive", message: "Could not evaluate — the model's answer was unreadable." };
}

/**
 * Run all configured pre-merge checks against a PR.
 */
export async function runPreMergeChecks(
  context: PRContext,
  config: PreMergeConfig,
  aiCheck: AiCheck,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  // ── Title check ──────────────────────────────────────────────
  if (config.title && config.title.mode !== "off") {
    const mode = config.title.mode ?? "warning";
    logger.debug("Running pre-merge title check");

    if (!context.title || context.title.trim().length === 0) {
      results.push({ name: "PR Title", mode, outcome: "failed", message: "Title is empty" });
    } else if (context.title.startsWith("WIP") || context.title.startsWith("Draft")) {
      results.push({ name: "PR Title", mode, outcome: "failed", message: "Title starts with WIP or Draft" });
    } else if (config.title.requirements) {
      const result = await aiCheck(
        "PR Title",
        `Evaluate the PR title against these requirements.\n\nTitle: "${context.title}"\n\nRequirements: ${config.title.requirements}`,
      );
      results.push({ name: "PR Title", mode, ...result });
    } else {
      results.push({ name: "PR Title", mode, outcome: "passed", message: "Title follows conventions" });
    }
  }

  // ── Description check ────────────────────────────────────────
  if (config.description && config.description.mode !== "off") {
    const mode = config.description.mode ?? "warning";
    logger.debug("Running pre-merge description check");

    if (!context.description || context.description.trim().length === 0) {
      results.push({ name: "PR Description", mode, outcome: "failed", message: "Description is empty" });
    } else if (context.description.trim().length <= 20) {
      results.push({
        name: "PR Description",
        mode,
        outcome: "failed",
        message: "Description is too short (must be more than 20 characters)",
      });
    } else if (config.description.requirements) {
      const result = await aiCheck(
        "PR Description",
        `Evaluate the PR description (shown above) against these requirements.\n\nRequirements: ${config.description.requirements}`,
      );
      results.push({ name: "PR Description", mode, ...result });
    } else {
      results.push({ name: "PR Description", mode, outcome: "passed", message: "Description meets requirements" });
    }
  }

  // ── Custom checks ────────────────────────────────────────────
  // Independent of each other, so run them concurrently.
  const custom = (config.custom_checks ?? []).filter((c) => c.mode !== "off");
  const customResults = await Promise.all(
    custom.map(async (check): Promise<CheckResult> => {
      logger.debug({ check: check.name }, "Running custom pre-merge check");
      const result = await aiCheck(check.name, check.instructions);
      return { name: check.name, mode: check.mode, ...result };
    }),
  );
  results.push(...customResults);

  logger.info(
    {
      total: results.length,
      passed: results.filter((r) => r.outcome === "passed").length,
      failed: results.filter((r) => r.outcome === "failed").length,
      inconclusive: results.filter((r) => r.outcome === "inconclusive").length,
    },
    "Pre-merge checks completed",
  );

  return results;
}

/** Keep a model-written message from breaking the markdown table it lands in. */
function cell(text: string): string {
  return text.replace(/\r?\n+/g, " ").replace(/\|/g, "\\|").trim();
}

/**
 * Format check results as a CodeRabbit-style pre-merge checks block,
 * suitable for embedding as a sibling <details> next to the walkthrough.
 */
export function formatCheckResults(results: CheckResult[]): string {
  if (results.length === 0) return "";

  const passed = results.filter((r) => r.outcome === "passed");
  const failed = results.filter((r) => r.outcome === "failed");
  const inconclusive = results.filter((r) => r.outcome === "inconclusive");

  const counts = [`✅ ${passed.length}`, `❌ ${failed.length}`];
  if (inconclusive.length > 0) counts.push(`⚪ ${inconclusive.length}`);
  const summaryHeader = `🚥 Pre-merge checks | ${counts.join(" | ")}`;

  const sections: string[] = [];
  sections.push(`<details>`);
  sections.push(`<summary>${summaryHeader}</summary>`);
  sections.push("");

  if (failed.length > 0) {
    const warnings = failed.filter((r) => r.mode === "warning").length;
    const errors = failed.filter((r) => r.mode === "error").length;
    const failedHeading = `### ❌ Failed checks (${[
      errors > 0 ? `${errors} error${errors === 1 ? "" : "s"}` : "",
      warnings > 0 ? `${warnings} warning${warnings === 1 ? "" : "s"}` : "",
    ]
      .filter(Boolean)
      .join(", ")})`;
    sections.push(failedHeading);
    sections.push("");
    sections.push("| Check name | Status | Explanation |");
    sections.push("|---|---|---|");
    for (const r of failed) {
      const status = r.mode === "warning" ? "⚠️ Warning" : "❌ Blocks merge";
      sections.push(`| ${r.name} | ${status} | ${cell(r.message)} |`);
    }
    sections.push("");
  }

  if (inconclusive.length > 0) {
    sections.push(`<details>`);
    sections.push(`<summary>⚪ Couldn't verify (${inconclusive.length}) — not counted as failures</summary>`);
    sections.push("");
    sections.push("| Check name | Why |");
    sections.push("|---|---|");
    for (const r of inconclusive) {
      sections.push(`| ${r.name} | ${cell(r.message)} |`);
    }
    sections.push("");
    sections.push(`</details>`);
    sections.push("");
  }

  if (passed.length > 0) {
    sections.push(`<details>`);
    sections.push(`<summary>✅ Passed checks (${passed.length} passed)</summary>`);
    sections.push("");
    sections.push("| Check name | Status | Explanation |");
    sections.push("|---|---|---|");
    for (const r of passed) {
      sections.push(`| ${r.name} | ✅ Passed | ${cell(r.message)} |`);
    }
    sections.push("");
    sections.push(`</details>`);
    sections.push("");
  }

  sections.push(
    "<sub>Only `error`-mode failures turn `DiffSentry / Pre-Merge` red. Configure checks under `reviews.pre_merge_checks` in `.diffsentry.yaml`.</sub>",
  );
  sections.push("");
  sections.push(`</details>`);

  return sections.join("\n");
}

/**
 * Determine overall status from check results. Inconclusive checks never
 * fail the status: "couldn't see it" is not evidence of a problem.
 */
export function getOverallStatus(results: CheckResult[]): "pass" | "warning" | "fail" {
  if (results.some((r) => r.outcome === "failed" && r.mode === "error")) return "fail";
  if (results.some((r) => r.outcome === "failed" && r.mode === "warning")) return "warning";
  return "pass";
}

/** GitHub caps a commit status description at 140 characters. */
const STATUS_DESCRIPTION_MAX = 140;

/**
 * The `DiffSentry / Pre-Merge` status description. Names the checks that set
 * it, because "Pre-merge checks failed" on its own sends the author digging
 * through the walkthrough to find out which one.
 */
export function describePreMergeStatus(results: CheckResult[]): string {
  const names = (rs: CheckResult[]) => rs.map((r) => r.name).join(", ");
  const errors = results.filter((r) => r.outcome === "failed" && r.mode === "error");
  const warnings = results.filter((r) => r.outcome === "failed" && r.mode === "warning");

  let text: string;
  if (errors.length > 0) {
    text = `Failed: ${names(errors)}`;
  } else if (warnings.length > 0) {
    text = `Passed with ${warnings.length} warning${warnings.length === 1 ? "" : "s"}: ${names(warnings)}`;
  } else {
    text = `All ${results.length} check${results.length === 1 ? "" : "s"} passed`;
    const inconclusive = results.filter((r) => r.outcome === "inconclusive").length;
    if (inconclusive > 0) text = `No failures (${inconclusive} couldn't be verified)`;
  }
  return text.length <= STATUS_DESCRIPTION_MAX ? text : text.slice(0, STATUS_DESCRIPTION_MAX - 1) + "…";
}
