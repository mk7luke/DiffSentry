export type FileChange = {
  path: string;
  content: string;
};

export type PostAction =
  | { type: "comment"; body: string }
  | { type: "wait"; ms: number };

export type Scenario = {
  name: string;
  description: string;
  files: FileChange[];
  prTitle: string;
  prBody?: string;
  draft?: boolean;
  postPrActions?: PostAction[];
  waitFor: {
    walkthrough?: boolean;
    review?: boolean;
    botIssueCommentsAtLeast?: number;
    inlineCommentsAtLeast?: number;
    timeoutMs?: number;
  };
  expect?: {
    reviewState?: "CHANGES_REQUESTED" | "COMMENTED" | "APPROVED";
    inlineCommentsContain?: Array<{ pathContains?: string; bodyContains: string[] }>;
    walkthroughContains?: string[];
    issueCommentContains?: string[];
    statusState?: "success" | "failure" | "pending" | "error";
    noBotActivity?: boolean;
  };
};

export type CapturedReview = {
  user: string;
  state: string;
  body: string | null;
  submitted_at: string | null;
};

export type CapturedInlineComment = {
  user: string;
  path: string;
  line: number | null;
  body: string;
  created_at: string;
};

export type CapturedIssueComment = {
  user: string;
  body: string;
  created_at: string;
};

export type CapturedStatus = {
  context: string;
  state: string;
  description: string | null;
};

export type ScenarioRun = {
  scenario: string;
  branch: string;
  prNumber: number;
  prUrl: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  walkthrough: string | null;
  reviews: CapturedReview[];
  inlineComments: CapturedInlineComment[];
  issueComments: CapturedIssueComment[];
  statuses: CapturedStatus[];
  expectations: ExpectationResult[];
  passed: boolean;
};

export type ExpectationResult = {
  name: string;
  passed: boolean;
  detail: string;
};
