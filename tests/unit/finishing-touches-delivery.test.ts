import { describe, it, expect } from "vitest";
import {
  autofix,
  generateDocstrings,
  generateTests,
  simplifyCode,
  formatTouchReply,
} from "../../src/finishing-touches.js";
import { formatReviewBody } from "../../src/review-body.js";
import { newlyCheckedTriggers } from "../../src/webhook/checkbox.js";
import type { AIProvider, PRContext, ReviewResult } from "../../src/types.js";

function ctx(): PRContext {
  return {
    owner: "o",
    repo: "r",
    pullNumber: 42,
    title: "t",
    description: "",
    baseBranch: "main",
    headBranch: "feat/thing",
    headSha: "abcdef1234567",
    files: [{ filename: "src/a.ts", status: "modified", patch: "@@ -1 +1 @@\n+x", additions: 1, deletions: 0 }],
  };
}

const EDIT_JSON = JSON.stringify([{ path: "src/a.ts", content: "updated" }]);

function ai(response = EDIT_JSON): AIProvider {
  return { chat: async () => response } as unknown as AIProvider;
}

interface Recorded {
  createRef: string[];
  writes: { path: string; branch: string }[];
  pulls: { head: string; base: string }[];
}

function fakeOctokit(opts: { reviewComments?: unknown[]; listError?: unknown } = {}) {
  const rec: Recorded = { createRef: [], writes: [], pulls: [] };
  const octokit = {
    git: {
      async getRef() {
        return { data: { object: { sha: "1111111" } } };
      },
      async createRef(p: { ref: string }) {
        rec.createRef.push(p.ref);
        return { data: {} };
      },
    },
    repos: {
      async getContent() {
        return { data: { sha: "blob", content: Buffer.from("old").toString("base64"), encoding: "base64" } };
      },
      async createOrUpdateFileContents(p: { path: string; branch: string }) {
        rec.writes.push({ path: p.path, branch: p.branch });
        return { data: { commit: { sha: "cafebabe0000" } } };
      },
    },
    pulls: {
      async listReviewComments() {
        if (opts.listError) throw opts.listError;
        return { data: opts.reviewComments ?? [] };
      },
      async create(p: { head: string; base: string }) {
        rec.pulls.push({ head: p.head, base: p.base });
        return { data: { number: 77, html_url: "https://github.com/o/r/pull/77" } };
      },
    },
  };
  return { octokit: octokit as unknown as Parameters<typeof generateDocstrings>[0], rec };
}

describe("each finishing touch honours its delivery choice", () => {
  const touches = [
    { name: "docstrings", run: generateDocstrings, slug: "docstrings" },
    { name: "tests", run: generateTests, slug: "tests" },
    { name: "simplify", run: simplifyCode, slug: "simplify" },
  ] as const;

  for (const t of touches) {
    it(`${t.name}: branch delivery writes to the head branch and opens no PR`, async () => {
      const { octokit, rec } = fakeOctokit();
      const out = await t.run(octokit, ctx(), ai(), undefined, "branch");
      expect(out.filesChanged).toBe(1);
      expect(rec.writes).toEqual([{ path: "src/a.ts", branch: "feat/thing" }]);
      expect(rec.createRef).toEqual([]);
      expect(rec.pulls).toEqual([]);
    });

    it(`${t.name}: stacked delivery opens a PR into the head branch and never writes to it`, async () => {
      const { octokit, rec } = fakeOctokit();
      const out = await t.run(octokit, ctx(), ai(), undefined, "stacked");
      expect(out.stacked?.number).toBe(77);
      expect(rec.createRef[0]).toMatch(new RegExp(`^refs/heads/diffsentry/${t.slug}/pr-42-`));
      expect(rec.writes.map((w) => w.branch)).not.toContain("feat/thing");
      expect(rec.pulls).toEqual([{ head: out.stacked!.branch, base: "feat/thing" }]);
    });
  }

  it("defaults to the head branch when no delivery is named", async () => {
    const { octokit, rec } = fakeOctokit();
    await generateDocstrings(octokit, ctx(), ai());
    expect(rec.writes).toEqual([{ path: "src/a.ts", branch: "feat/thing" }]);
  });

  it("autofix stacks its fixes when asked to", async () => {
    const { octokit, rec } = fakeOctokit({
      reviewComments: [{ path: "src/a.ts", body: "fix this", line: 3 }],
    });
    const out = await autofix(octokit, ctx(), ai(), undefined, "stacked");
    expect(out.stacked?.url).toBe("https://github.com/o/r/pull/77");
    expect(rec.pulls).toEqual([{ head: out.stacked!.branch, base: "feat/thing" }]);
  });

  it("says so when it cannot even read the review comments", async () => {
    const { octokit } = fakeOctokit({ listError: new Error("Bad credentials") });
    const out = await autofix(octokit, ctx(), ai(), undefined, "stacked");
    expect(out.error).toContain("couldn't read the review comments");
    expect(formatTouchReply("autofix", out)).toContain("> [!WARNING]");
  });

  it("falls back to the empty note when the model returns no edits", async () => {
    const { octokit } = fakeOctokit();
    const out = await simplifyCode(octokit, ctx(), ai("no JSON here"), undefined, "stacked");
    expect(out.filesChanged).toBe(0);
    expect(out.error).toBeUndefined();
    expect(formatTouchReply("simplify", out)).toBe("No simplification opportunities found.");
  });
});

describe("the review body's 🪄 Autofix block", () => {
  const meta = {
    profile: "chill" as const,
    owner: "o",
    repo: "r",
    headSha: "abcdef1234567",
    baseBranch: "main",
    headBranch: "feat/thing",
    filesProcessed: ["src/a.ts"],
    botName: "diffsentry",
  };

  function bodyWithFinding(): string {
    const result: ReviewResult = {
      summary: "s",
      approval: "COMMENT",
      comments: [
        {
          path: "src/a.ts",
          line: 1,
          body: "Prose.",
          severity: "minor",
          title: "A finding.",
        },
      ],
    } as unknown as ReviewResult;
    return formatReviewBody(result, meta);
  }

  it("keeps both corpus labels", () => {
    const body = bodyWithFinding();
    expect(body).toContain("Push a commit to this branch (recommended)");
    expect(body).toContain("Create a new PR with the fixes");
  });

  it("gives the new-PR box routing it did not have", () => {
    const body = bodyWithFinding();
    const line = body
      .split("\n")
      .find((l) => l.includes("Create a new PR with the fixes"));
    expect(line).toBeDefined();
    expect(line).toContain('"action":"autofix"');
    expect(line).toContain('"delivery":"stacked"');
  });

  it("dispatches when either box is ticked", () => {
    const before = bodyWithFinding();
    const after = before.replace(/- \[ \]/g, "- [x]");
    expect(newlyCheckedTriggers(after, before)).toEqual([
      { action: "autofix", delivery: "stacked" },
    ]);
  });
});
