import { PRContext, PreMergeConfig, CheckResult } from "./types.js";
import { logger } from "./logger.js";

/**
 * Run all configured pre-merge checks against a PR.
 */
export async function runPreMergeChecks(
  context: PRContext,
  config: PreMergeConfig,
  aiCheck: (
    instruction: string,
    context: PRContext
  ) => Promise<{ passed: boolean; message: string }>
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  // ── Title check ──────────────────────────────────────────────
  if (config.title && config.title.mode !== "off") {
    const mode = config.title.mode ?? "warning";
    logger.debug("Running pre-merge title check");

    // Built-in validations
    if (!context.title || context.title.trim().length === 0) {
      results.push({
        name: "PR Title",
        mode,
        passed: false,
        message: "Title is empty",
      });
    } else if (
      context.title.startsWith("WIP") ||
      context.title.startsWith("Draft")
    ) {
      results.push({
        name: "PR Title",
        mode,
        passed: false,
        message: "Title starts with WIP or Draft",
      });
    } else if (config.title.requirements) {
      // AI-powered requirement evaluation
      const result = await aiCheck(
        `Evaluate this PR title against the following requirements.\n\nTitle: "${context.title}"\n\nRequirements: ${config.title.requirements}\n\nRespond with whether the title meets the requirements.`,
        context
      );
      results.push({
        name: "PR Title",
        mode,
        passed: result.passed,
        message: result.message,
      });
    } else {
      results.push({
        name: "PR Title",
        mode,
        passed: true,
        message: "Title follows conventions",
      });
    }
  }

  // ── Description check ────────────────────────────────────────
  if (config.description && config.description.mode !== "off") {
    const mode = config.description.mode ?? "warning";
    logger.debug("Running pre-merge description check");

    if (!context.description || context.description.trim().length === 0) {
      results.push({
        name: "PR Description",
        mode,
        passed: false,
        message: "Description is empty",
      });
    } else if (context.description.trim().length <= 20) {
      results.push({
        name: "PR Description",
        mode,
        passed: false,
        message: "Description is too short (must be more than 20 characters)",
      });
    } else if (config.description.requirements) {
      const result = await aiCheck(
        `Evaluate this PR description against the following requirements.\n\nDescription: "${context.description}"\n\nRequirements: ${config.description.requirements}\n\nRespond with whether the description meets the requirements.`,
        context
      );
      results.push({
        name: "PR Description",
        mode,
        passed: result.passed,
        message: result.message,
      });
    } else {
      results.push({
        name: "PR Description",
        mode,
        passed: true,
        message: "Description meets requirements",
      });
    }
  }

  // ── Custom checks ────────────────────────────────────────────
  if (config.custom_checks) {
    for (const check of config.custom_checks) {
      if (check.mode === "off") continue;

      logger.debug({ check: check.name }, "Running custom pre-merge check");
      const result = await aiCheck(check.instructions, context);
      results.push({
        name: check.name,
        mode: check.mode,
        passed: result.passed,
        message: result.message,
      });
    }
  }

  logger.info(
    {
      total: results.length,
      passed: results.filter((r) => r.passed).length,
      failed: results.filter((r) => !r.passed).length,
    },
    "Pre-merge checks completed"
  );

  return results;
}

/**
 * Format check results as a CodeRabbit-style pre-merge checks block,
 * suitable for embedding as a sibling <details> next to the walkthrough.
 */
export function formatCheckResults(results: CheckResult[]): string {
  if (results.length === 0) return "";

  const passed = results.filter((r) => r.passed);
  const failed = results.filter((r) => !r.passed);
  const passedCount = passed.length;
  const failedCount = failed.length;

  const summaryHeader = `🚥 Pre-merge checks | ✅ ${passedCount} | ❌ ${failedCount}`;

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
    sections.push("| Check name | Status | Explanation | Resolution |");
    sections.push("|---|---|---|---|");
    for (const r of failed) {
      const status = r.mode === "warning" ? "⚠️ Warning" : "❌ Error";
      const resolution = r.mode === "warning"
        ? "Address before merging or downgrade to non-blocking."
        : "Resolve the issue and re-trigger the check.";
      sections.push(`| ${r.name} | ${status} | ${r.message} | ${resolution} |`);
    }
    sections.push("");
  }

  if (passed.length > 0) {
    sections.push(`<details>`);
    sections.push(`<summary>✅ Passed checks (${passedCount} passed)</summary>`);
    sections.push("");
    sections.push("| Check name | Status | Explanation |");
    sections.push("|---|---|---|");
    for (const r of passed) {
      sections.push(`| ${r.name} | ✅ Passed | ${r.message} |`);
    }
    sections.push("");
    sections.push(`</details>`);
    sections.push("");
  }

  sections.push(
    "<sub>✏️ Tip: You can configure your own custom pre-merge checks in your `.diffsentry.yaml`.</sub>",
  );
  sections.push("");
  sections.push(`</details>`);

  return sections.join("\n");
}

/**
 * Determine overall status from check results.
 */
export function getOverallStatus(
  results: CheckResult[]
): "pass" | "warning" | "fail" {
  const hasError = results.some((r) => !r.passed && r.mode === "error");
  if (hasError) return "fail";

  const hasWarning = results.some((r) => !r.passed && r.mode === "warning");
  if (hasWarning) return "warning";

  return "pass";
}
