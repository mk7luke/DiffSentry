import yaml from "js-yaml";
import { minimatch } from "minimatch";
import { Octokit } from "@octokit/rest";
import { RepoConfig } from "./types.js";
import { logger } from "./logger.js";

const DEFAULT_CONFIG: RepoConfig = {
  reviews: {
    profile: "chill",
    request_changes_workflow: false,
    high_level_summary: true,
    walkthrough: {
      enabled: true,
      collapse: true,
      changed_files_summary: true,
      sequence_diagrams: true,
      estimate_effort: true,
      poem: false,
    },
    auto_review: {
      enabled: true,
      drafts: false,
      auto_incremental_review: true,
    },
  },
  chat: {
    auto_reply: true,
  },
  issues: {
    auto_summary: {
      enabled: true,
      on_edit: false,
    },
    chat: {
      auto_reply: true,
    },
  },
};

export async function loadRepoConfig(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string
): Promise<RepoConfig> {
  try {
    const { data } = await octokit.repos.getContent({
      owner,
      repo,
      path: ".diffsentry.yaml",
      ref,
    });

    if (Array.isArray(data) || data.type !== "file" || !data.content) {
      logger.warn({ owner, repo }, "Unexpected content type for .diffsentry.yaml");
      return {};
    }

    const content = Buffer.from(data.content, "base64").toString("utf-8");
    const parsed = yaml.load(content);

    if (parsed === null || parsed === undefined) {
      return {};
    }

    if (typeof parsed !== "object" || Array.isArray(parsed)) {
      logger.warn({ owner, repo }, ".diffsentry.yaml is not a valid object");
      return {};
    }

    logger.info({ owner, repo }, "Loaded .diffsentry.yaml");
    return parsed as RepoConfig;
  } catch (err: any) {
    if (err.status === 404) {
      logger.debug({ owner, repo }, "No .diffsentry.yaml found, using defaults");
      return {};
    }
    logger.error({ owner, repo, err }, "Failed to load .diffsentry.yaml");
    return {};
  }
}

export function mergeWithDefaults(config: RepoConfig): RepoConfig {
  return {
    ...config,
    reviews: {
      ...DEFAULT_CONFIG.reviews,
      ...config.reviews,
      walkthrough: {
        ...DEFAULT_CONFIG.reviews!.walkthrough,
        ...config.reviews?.walkthrough,
      },
      auto_review: {
        ...DEFAULT_CONFIG.reviews!.auto_review,
        ...config.reviews?.auto_review,
      },
    },
    chat: {
      ...DEFAULT_CONFIG.chat,
      ...config.chat,
    },
    issues: {
      ...DEFAULT_CONFIG.issues,
      ...config.issues,
      auto_summary: {
        ...DEFAULT_CONFIG.issues!.auto_summary,
        ...config.issues?.auto_summary,
      },
      chat: {
        ...DEFAULT_CONFIG.issues!.chat,
        ...config.issues?.chat,
      },
    },
  };
}

export function shouldReviewPR(
  config: RepoConfig,
  pr: {
    isDraft?: boolean;
    labels?: string[];
    title: string;
    author?: string;
    baseBranch: string;
  }
): boolean {
  const autoReview = config.reviews?.auto_review;

  if (autoReview?.enabled === false) {
    return false;
  }

  if (pr.isDraft && !autoReview?.drafts) {
    return false;
  }

  if (autoReview?.base_branches?.length) {
    const matches = autoReview.base_branches.some((pattern) =>
      new RegExp(pattern).test(pr.baseBranch)
    );
    if (!matches) return false;
  }

  if (autoReview?.labels?.length && pr.labels) {
    for (const labelRule of autoReview.labels) {
      if (labelRule.startsWith("!")) {
        const excluded = labelRule.slice(1);
        if (pr.labels.includes(excluded)) return false;
      }
    }

    const includeLabels = autoReview.labels.filter((l) => !l.startsWith("!"));
    if (includeLabels.length > 0) {
      const hasIncluded = includeLabels.some((l) => pr.labels!.includes(l));
      if (!hasIncluded) return false;
    }
  }

  if (autoReview?.ignore_title_keywords?.length) {
    const titleLower = pr.title.toLowerCase();
    const ignored = autoReview.ignore_title_keywords.some((kw) =>
      titleLower.includes(kw.toLowerCase())
    );
    if (ignored) return false;
  }

  if (autoReview?.ignore_usernames?.length && pr.author) {
    if (autoReview.ignore_usernames.includes(pr.author)) return false;
  }

  return true;
}

export function getPathInstructions(
  config: RepoConfig,
  filename: string
): string[] {
  if (!config.reviews?.path_instructions?.length) return [];

  return config.reviews.path_instructions
    .filter((pi) => minimatch(filename, pi.path))
    .map((pi) => pi.instructions);
}

export function isPathIncluded(
  config: RepoConfig,
  filename: string
): boolean {
  const filters = config.reviews?.path_filters;
  if (!filters?.length) return true;

  const includePatterns = filters.filter((f) => !f.startsWith("!"));
  const excludePatterns = filters.filter((f) => f.startsWith("!")).map((f) => f.slice(1));

  for (const pattern of excludePatterns) {
    if (minimatch(filename, pattern)) return false;
  }

  if (includePatterns.length === 0) return true;

  return includePatterns.some((pattern) => minimatch(filename, pattern));
}
