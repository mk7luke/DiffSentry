export interface Config {
  port: number;
  githubAppId: string;
  githubPrivateKey: string;
  githubWebhookSecret: string;
  aiProvider: "anthropic" | "openai";
  anthropicApiKey?: string;
  openaiApiKey?: string;
  anthropicModel: string;
  openaiModel: string;
  maxFilesPerReview: number;
  ignoredPatterns: string[];
}

export interface FileChange {
  filename: string;
  status: "added" | "modified" | "removed" | "renamed";
  patch: string;
  additions: number;
  deletions: number;
}

export interface ReviewComment {
  path: string;
  line: number;
  side: "RIGHT";
  body: string;
}

export interface ReviewResult {
  summary: string;
  comments: ReviewComment[];
  approval: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
}

export interface PRContext {
  owner: string;
  repo: string;
  pullNumber: number;
  title: string;
  description: string;
  baseBranch: string;
  headBranch: string;
  files: FileChange[];
}

export interface AIProvider {
  review(context: PRContext): Promise<ReviewResult>;
}
