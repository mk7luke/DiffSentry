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
 * Format check results as a markdown comment body.
 */
export function formatCheckResults(results: CheckResult[]): string {
  if (results.length === 0) {
    return "## Pre-Merge Checks\n\nNo checks configured.";
  }

  const rows = results.map((r) => {
    let status: string;
    if (r.passed) {
      status = "\u2705 Passed";
    } else if (r.mode === "warning") {
      status = "\u26a0\ufe0f Warning";
    } else {
      status = "\u274c Failed";
    }
    return `| ${r.name} | ${status} | ${r.message} |`;
  });

  const passed = results.filter((r) => r.passed).length;
  const warnings = results.filter(
    (r) => !r.passed && r.mode === "warning"
  ).length;
  const failures = results.filter(
    (r) => !r.passed && r.mode === "error"
  ).length;

  const summaryParts: string[] = [];
  if (passed > 0) summaryParts.push(`\u2705 ${passed} passed`);
  if (warnings > 0) summaryParts.push(`\u26a0\ufe0f ${warnings} warning`);
  if (failures > 0) summaryParts.push(`\u274c ${failures} failed`);

  return [
    "## Pre-Merge Checks",
    "",
    "| Check | Status | Details |",
    "|-------|--------|---------|",
    ...rows,
    "",
    "### Summary",
    summaryParts.join(" \u00b7 "),
  ].join("\n");
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
