import { Octokit } from "@octokit/rest";
import { logger } from "./logger.js";

interface GuidelineFile {
  path: string;
  scope: string;
  content: string;
}

const GUIDELINE_PATTERNS = [
  "AGENTS.md",
  "AGENT.md",
  "CLAUDE.md",
  "GEMINI.md",
  ".cursorrules",
  ".windsurfrules",
  ".github/copilot-instructions.md",
];

const DIRECTORY_PATTERNS = [
  ".github/instructions",
  ".rules",
  ".clinerules",
  ".cursor/rules",
];

function scopeFromPath(filePath: string): string {
  const lastSlash = filePath.lastIndexOf("/");
  return lastSlash === -1 ? "" : filePath.substring(0, lastSlash + 1);
}

async function fetchFileContent(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string,
  path: string
): Promise<GuidelineFile | null> {
  try {
    const response = await octokit.repos.getContent({ owner, repo, path, ref });
    const data = response.data;
    if ("content" in data && data.type === "file") {
      const content = Buffer.from(data.content, "base64").toString("utf-8");
      return { path, scope: scopeFromPath(path), content };
    }
    return null;
  } catch (err: any) {
    if (err.status === 404) return null;
    logger.debug({ err, path }, "Error fetching guideline file");
    return null;
  }
}

async function fetchDirectoryFiles(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string,
  dirPath: string,
  filter?: (name: string) => boolean
): Promise<GuidelineFile[]> {
  try {
    const response = await octokit.repos.getContent({ owner, repo, path: dirPath, ref });
    const data = response.data;
    if (!Array.isArray(data)) return [];

    const files: GuidelineFile[] = [];
    for (const item of data) {
      if (item.type !== "file") continue;
      if (filter && !filter(item.name)) continue;

      const file = await fetchFileContent(octokit, owner, repo, ref, item.path);
      if (file) files.push(file);
    }
    return files;
  } catch (err: any) {
    if (err.status === 404) return [];
    logger.debug({ err, dirPath }, "Error listing guideline directory");
    return [];
  }
}

export async function loadGuidelines(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string
): Promise<GuidelineFile[]> {
  const guidelines: GuidelineFile[] = [];

  // Fetch well-known files from repo root
  const rootResults = await Promise.all(
    GUIDELINE_PATTERNS.map((pattern) =>
      fetchFileContent(octokit, owner, repo, ref, pattern)
    )
  );
  for (const result of rootResults) {
    if (result) guidelines.push(result);
  }

  // Fetch files from known directories
  const [instructionsFiles, rulesFiles, clineFiles, cursorFiles] =
    await Promise.all([
      fetchDirectoryFiles(
        octokit, owner, repo, ref,
        ".github/instructions",
        (name) => name.endsWith(".instructions.md")
      ),
      fetchDirectoryFiles(octokit, owner, repo, ref, ".rules"),
      fetchDirectoryFiles(octokit, owner, repo, ref, ".clinerules"),
      fetchDirectoryFiles(octokit, owner, repo, ref, ".cursor/rules"),
    ]);

  guidelines.push(...instructionsFiles, ...rulesFiles, ...clineFiles, ...cursorFiles);

  logger.debug(
    { count: guidelines.length, paths: guidelines.map((g) => g.path) },
    "Loaded coding guideline files"
  );

  return guidelines;
}

export function getRelevantGuidelines(
  guidelines: GuidelineFile[],
  changedFiles: string[]
): GuidelineFile[] {
  const seen = new Set<string>();
  const relevant: GuidelineFile[] = [];

  for (const guideline of guidelines) {
    if (seen.has(guideline.path)) continue;

    if (guideline.scope === "") {
      seen.add(guideline.path);
      relevant.push(guideline);
      continue;
    }

    for (const file of changedFiles) {
      if (file.startsWith(guideline.scope)) {
        seen.add(guideline.path);
        relevant.push(guideline);
        break;
      }
    }
  }

  return relevant;
}

export function formatGuidelinesForPrompt(guidelines: GuidelineFile[]): string {
  if (guidelines.length === 0) return "";

  const sections = guidelines
    .map((g) => `### ${g.path}\n${g.content}`)
    .join("\n\n");

  return `## Code Guidelines\n\nThe following coding guidelines apply to this review:\n\n${sections}`;
}
