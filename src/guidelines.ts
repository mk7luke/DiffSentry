import { Octokit } from "@octokit/rest";
import { logger } from "./logger.js";

interface GuidelineFile {
  path: string;
  scope: string;
  content: string;
}

const GUIDELINE_FILENAMES = new Set([
  "agents.md",
  "agent.md",
  "claude.md",
  "gemini.md",
  ".cursorrules",
  ".windsurfrules",
]);

const GUIDELINE_DIRS = new Set([
  ".github/instructions",
  ".rules",
  ".clinerules",
  ".cursor/rules",
]);

function scopeFromPath(filePath: string): string {
  const lastSlash = filePath.lastIndexOf("/");
  return lastSlash === -1 ? "" : filePath.substring(0, lastSlash + 1);
}

function isGuidelineFile(treePath: string): boolean {
  const lower = treePath.toLowerCase();
  const name = lower.split("/").pop() || "";

  // Root-level well-known files
  if (GUIDELINE_FILENAMES.has(name)) return true;

  // .github/copilot-instructions.md
  if (lower === ".github/copilot-instructions.md") return true;

  // Files inside known directories
  for (const dir of GUIDELINE_DIRS) {
    if (lower.startsWith(dir + "/")) {
      // .github/instructions/ only loads *.instructions.md
      if (dir === ".github/instructions") {
        return name.endsWith(".instructions.md");
      }
      return true;
    }
  }

  return false;
}

export async function loadGuidelines(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string
): Promise<GuidelineFile[]> {
  const guidelines: GuidelineFile[] = [];

  try {
    // Single API call: get the full repo tree (non-recursive, shallow)
    // This avoids 12+ individual 404 requests for files that don't exist
    const { data } = await octokit.git.getTree({
      owner,
      repo,
      tree_sha: ref,
      recursive: "true",
    });

    // Filter tree for guideline files
    const guidelinePaths = data.tree
      .filter((item) => item.type === "blob" && item.path && isGuidelineFile(item.path))
      .map((item) => item.path!);

    if (guidelinePaths.length === 0) {
      logger.debug("No coding guideline files found in repo");
      return [];
    }

    // Fetch content for each found file (only the ones that actually exist)
    const results = await Promise.all(
      guidelinePaths.map(async (path) => {
        try {
          const response = await octokit.repos.getContent({ owner, repo, path, ref });
          const fileData = response.data;
          if ("content" in fileData && fileData.type === "file") {
            return {
              path,
              scope: scopeFromPath(path),
              content: Buffer.from(fileData.content, "base64").toString("utf-8"),
            };
          }
          return null;
        } catch {
          return null;
        }
      })
    );

    for (const result of results) {
      if (result) guidelines.push(result);
    }

    logger.debug(
      { count: guidelines.length, paths: guidelines.map((g) => g.path) },
      "Loaded coding guideline files"
    );
  } catch (err: any) {
    // If tree fetch fails (permissions, empty repo), just skip guidelines
    logger.debug({ err }, "Could not fetch repo tree for guidelines");
  }

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
