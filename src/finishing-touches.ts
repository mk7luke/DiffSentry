import { Octokit } from "@octokit/rest";
import { PRContext, AIProvider, RepoConfig } from "./types.js";
import { logger } from "./logger.js";

// ─── Helpers ──────────────────────────────────────────────────

interface FileEdit {
  path: string;
  content: string;
}

async function commitFileChange(
  octokit: Octokit,
  owner: string,
  repo: string,
  branch: string,
  filePath: string,
  content: string,
  message: string
): Promise<string> {
  // Get current file SHA (if it exists) so the update succeeds
  let sha: string | undefined;
  try {
    const { data } = await octokit.repos.getContent({
      owner,
      repo,
      path: filePath,
      ref: branch,
    });
    if (!Array.isArray(data) && "sha" in data) {
      sha = data.sha;
    }
  } catch {
    // File doesn't exist yet — that's fine for new files (e.g. test files)
  }

  const { data } = await octokit.repos.createOrUpdateFileContents({
    owner,
    repo,
    path: filePath,
    message,
    content: Buffer.from(content).toString("base64"),
    branch,
    ...(sha ? { sha } : {}),
  });

  return data.commit.sha!;
}

function parseFileEdits(aiResponse: string): FileEdit[] | null {
  // Try to extract a JSON array from the response — the model may wrap it in
  // markdown fences or include surrounding prose.
  const jsonMatch = aiResponse.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return null;

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) return null;

    const edits: FileEdit[] = [];
    for (const item of parsed) {
      if (
        typeof item === "object" &&
        item !== null &&
        typeof item.path === "string" &&
        typeof item.content === "string"
      ) {
        edits.push({ path: item.path, content: item.content });
      }
    }
    return edits.length > 0 ? edits : null;
  } catch {
    return null;
  }
}

async function getFileContent(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string,
  path: string
): Promise<string | null> {
  try {
    const { data } = await octokit.repos.getContent({ owner, repo, path, ref });
    if (!Array.isArray(data) && "content" in data && data.encoding === "base64") {
      return Buffer.from(data.content, "base64").toString("utf-8");
    }
    return null;
  } catch {
    return null;
  }
}

function buildFileContext(files: { path: string; content: string | null; patch: string }[]): string {
  return files
    .map((f) => {
      if (f.content) {
        return `### ${f.path}\n\`\`\`\n${f.content}\n\`\`\``;
      }
      return `### ${f.path} (patch only)\n\`\`\`diff\n${f.patch}\n\`\`\``;
    })
    .join("\n\n");
}

async function applyEdits(
  octokit: Octokit,
  context: PRContext,
  edits: FileEdit[],
  commitMessage: string
): Promise<{ filesChanged: number; commitSha?: string }> {
  let lastSha: string | undefined;
  let filesChanged = 0;

  for (const edit of edits) {
    try {
      lastSha = await commitFileChange(
        octokit,
        context.owner,
        context.repo,
        context.headBranch,
        edit.path,
        edit.content,
        commitMessage
      );
      filesChanged++;
    } catch (err) {
      logger.warn({ err, path: edit.path }, "Failed to commit file change");
    }
  }

  return { filesChanged, commitSha: lastSha };
}

async function gatherFullFiles(
  octokit: Octokit,
  context: PRContext
): Promise<{ path: string; content: string | null; patch: string }[]> {
  const results: { path: string; content: string | null; patch: string }[] = [];

  for (const file of context.files) {
    if (file.status === "removed") continue;
    const content = await getFileContent(
      octokit,
      context.owner,
      context.repo,
      context.headBranch,
      file.filename
    );
    results.push({ path: file.filename, content, patch: file.patch });
  }

  return results;
}

// ─── Public API ───────────────────────────────────────────────

export async function generateDocstrings(
  octokit: Octokit,
  context: PRContext,
  ai: AIProvider,
  repoConfig?: RepoConfig
): Promise<{ filesChanged: number; commitSha?: string }> {
  logger.info({ pr: context.pullNumber }, "Generating docstrings for PR");

  const files = await gatherFullFiles(octokit, context);
  if (files.length === 0) return { filesChanged: 0 };

  const prompt = `Analyze these files and add docstrings to all functions/methods that are missing them. Return a JSON array of {path, content} where content is the full updated file. Preserve all existing code exactly. Use the appropriate docstring format for the language (JSDoc for JS/TS, Google-style for Python, etc.).

${buildFileContext(files)}`;

  const response = await ai.chat(context, prompt, repoConfig);
  const edits = parseFileEdits(response);
  if (!edits) {
    logger.warn("AI response did not contain valid file edits for docstrings");
    return { filesChanged: 0 };
  }

  return applyEdits(octokit, context, edits, "[DiffSentry] Add docstrings");
}

export async function generateTests(
  octokit: Octokit,
  context: PRContext,
  ai: AIProvider,
  repoConfig?: RepoConfig
): Promise<{ filesChanged: number; commitSha?: string }> {
  logger.info({ pr: context.pullNumber }, "Generating tests for PR");

  const files = await gatherFullFiles(octokit, context);
  if (files.length === 0) return { filesChanged: 0 };

  const prompt = `Generate comprehensive unit tests for the changed code. Return a JSON array of {path, content} where path is the test file path (e.g., tests/foo.test.ts) and content is the full test file. Use the project's existing test framework if detectable, otherwise use common defaults (Jest for JS/TS, pytest for Python).

${buildFileContext(files)}`;

  const response = await ai.chat(context, prompt, repoConfig);
  const edits = parseFileEdits(response);
  if (!edits) {
    logger.warn("AI response did not contain valid file edits for tests");
    return { filesChanged: 0 };
  }

  return applyEdits(octokit, context, edits, "[DiffSentry] Add unit tests");
}

export async function simplifyCode(
  octokit: Octokit,
  context: PRContext,
  ai: AIProvider,
  repoConfig?: RepoConfig
): Promise<{ filesChanged: number; commitSha?: string }> {
  logger.info({ pr: context.pullNumber }, "Simplifying code for PR");

  const files = await gatherFullFiles(octokit, context);
  if (files.length === 0) return { filesChanged: 0 };

  const prompt = `Review these changed files for simplification opportunities. Reduce complexity, remove dead code, simplify conditionals, consolidate duplicated logic. Do NOT change public APIs, rename exports, or alter behavior. Return a JSON array of {path, content} with the simplified files.

${buildFileContext(files)}`;

  const response = await ai.chat(context, prompt, repoConfig);
  const edits = parseFileEdits(response);
  if (!edits) {
    logger.warn("AI response did not contain valid file edits for simplification");
    return { filesChanged: 0 };
  }

  return applyEdits(octokit, context, edits, "[DiffSentry] Simplify code");
}

export async function autofix(
  octokit: Octokit,
  context: PRContext,
  ai: AIProvider,
  repoConfig?: RepoConfig
): Promise<{ filesChanged: number; commitSha?: string }> {
  logger.info({ pr: context.pullNumber }, "Auto-fixing review comments for PR");

  // Fetch unresolved review comments
  let comments: { path: string; body: string; line: number | null }[] = [];
  try {
    const { data } = await octokit.pulls.listReviewComments({
      owner: context.owner,
      repo: context.repo,
      pull_number: context.pullNumber,
    });
    comments = data
      .filter((c) => !(c as any).resolved_at)
      .map((c) => ({ path: c.path, body: c.body, line: c.line ?? null }));
  } catch (err) {
    logger.warn({ err }, "Failed to fetch review comments for autofix");
    return { filesChanged: 0 };
  }

  if (comments.length === 0) {
    logger.info("No unresolved review comments to fix");
    return { filesChanged: 0 };
  }

  // Get full content for the files referenced by comments
  const affectedPaths = Array.from(new Set(comments.map((c) => c.path)));
  const files: { path: string; content: string | null; patch: string }[] = [];

  for (const filePath of affectedPaths) {
    const content = await getFileContent(
      octokit,
      context.owner,
      context.repo,
      context.headBranch,
      filePath
    );
    const fileChange = context.files.find((f) => f.filename === filePath);
    files.push({ path: filePath, content, patch: fileChange?.patch ?? "" });
  }

  const commentText = comments
    .map((c) => `- **${c.path}** (line ${c.line ?? "?"}): ${c.body}`)
    .join("\n");

  const prompt = `You are given unresolved review comments on a PR. Implement the suggested fixes. Return a JSON array of {path, content} with the fixed files.

### Unresolved Review Comments
${commentText}

### Files
${buildFileContext(files)}`;

  const response = await ai.chat(context, prompt, repoConfig);
  const edits = parseFileEdits(response);
  if (!edits) {
    logger.warn("AI response did not contain valid file edits for autofix");
    return { filesChanged: 0 };
  }

  return applyEdits(octokit, context, edits, "[DiffSentry] Auto-fix review comments");
}
