import { Octokit } from "@octokit/rest";
import { logger } from "./logger.js";

export interface LinkedIssue {
  number: number;
  title: string;
  body: string;
  state: string;
  labels: string[];
  url: string;
}

/**
 * Parse PR description/body for issue references.
 * Supports: fixes #123, closes #123, resolves #123 (and singular forms)
 * Also: linked to #123, references #123, relates to #123, re #123
 * Also: bare #123 references
 * Ignores references inside code blocks.
 */
export function parseIssueReferences(description: string): number[] {
  if (!description) return [];

  // Strip fenced code blocks (``` ... ```)
  const withoutCodeBlocks = description.replace(/```[\s\S]*?```/g, "");
  // Strip inline code (`...`)
  const cleaned = withoutCodeBlocks.replace(/`[^`]*`/g, "");

  const issueNumbers = new Set<number>();

  // Match all #\d+ patterns
  const matches = cleaned.matchAll(/#(\d+)/g);
  for (const match of matches) {
    const num = parseInt(match[1], 10);
    if (num > 0) {
      issueNumbers.add(num);
    }
  }

  return Array.from(issueNumbers).sort((a, b) => a - b);
}

/**
 * Fetch full issue details from GitHub.
 * Silently skips issues that return 404 (not found or in a different repo).
 */
export async function fetchLinkedIssues(
  octokit: Octokit,
  owner: string,
  repo: string,
  issueNumbers: number[]
): Promise<LinkedIssue[]> {
  const issues: LinkedIssue[] = [];

  for (const num of issueNumbers) {
    try {
      const { data } = await octokit.issues.get({
        owner,
        repo,
        issue_number: num,
      });

      issues.push({
        number: data.number,
        title: data.title,
        body: data.body ?? "",
        state: data.state,
        labels: data.labels.map((l) =>
          typeof l === "string" ? l : l.name ?? ""
        ),
        url: data.html_url,
      });
    } catch (err: unknown) {
      const status = (err as { status?: number }).status;
      if (status === 404) {
        logger.debug(`Issue #${num} not found, skipping`);
      } else {
        logger.warn({ err }, `Failed to fetch issue #${num}`);
      }
    }
  }

  return issues;
}

/**
 * Format issues for injection into the AI review prompt.
 */
export function formatIssuesForPrompt(issues: LinkedIssue[]): string {
  if (issues.length === 0) return "";

  const MAX_BODY_LENGTH = 1000;

  let output = `## Linked Issues\n\nThis PR is linked to the following issues. Verify the PR properly addresses them.\n`;

  for (const issue of issues) {
    const labels = issue.labels.length > 0 ? issue.labels.join(", ") : "none";
    const body =
      issue.body.length > MAX_BODY_LENGTH
        ? issue.body.slice(0, MAX_BODY_LENGTH) + "..."
        : issue.body;

    output += `\n### #${issue.number}: ${issue.title}\n`;
    output += `**State:** ${issue.state} | **Labels:** ${labels}\n`;
    if (body) {
      output += `${body}\n`;
    }
  }

  return output;
}

/**
 * Format issues as a markdown table for the walkthrough comment.
 */
export function formatIssuesForWalkthrough(issues: LinkedIssue[]): string {
  if (issues.length === 0) return "";

  let output = `## Related Issues\n\n`;
  output += `| Issue | Title | State |\n`;
  output += `|-------|-------|-------|\n`;

  for (const issue of issues) {
    const stateIcon = issue.state === "open" ? "\u{1F7E2}" : "\u{1F534}";
    output += `| [#${issue.number}](${issue.url}) | ${issue.title} | ${stateIcon} ${issue.state} |\n`;
  }

  return output;
}
