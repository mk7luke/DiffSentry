import { describe, it, expect } from "vitest";
import {
  createStackedPr,
  commitToHeadBranch,
  stackedBranchName,
  formatDeliveryReply,
  type StackedPrOutcome,
} from "../../src/stacked-pr.js";
import type { PRContext } from "../../src/types.js";

function ctx(): PRContext {
  return {
    owner: "o",
    repo: "r",
    pullNumber: 42,
    title: "t",
    description: "",
    baseBranch: "main",
    headBranch: "feat/thing",
    headSha: "abcdef1234567890",
    files: [],
  };
}

/** An HTTP error shaped like Octokit's. */
function apiError(status: number, message: string) {
  return Object.assign(new Error(message), { status });
}

interface Calls {
  getRef: unknown[];
  createRef: unknown[];
  getContent: unknown[];
  put: unknown[];
  create: unknown[];
}

interface FakeOptions {
  headSha?: string;
  getRefError?: unknown;
  /** Refs that already exist — createRef rejects with 422 for these. */
  existingRefs?: string[];
  createRefError?: unknown;
  /** Paths whose write is refused. `"*"` refuses everything. */
  writeErrors?: Record<string, unknown>;
  createPrError?: unknown;
}

function fakeOctokit(opts: FakeOptions = {}) {
  const calls: Calls = { getRef: [], createRef: [], getContent: [], put: [], create: [] };
  let commitCounter = 0;

  const octokit = {
    git: {
      async getRef(params: { ref: string }) {
        calls.getRef.push(params);
        if (opts.getRefError) throw opts.getRefError;
        return { data: { object: { sha: opts.headSha ?? "1111111222222233333334444444555555566666" } } };
      },
      async createRef(params: { ref: string; sha: string }) {
        calls.createRef.push(params);
        if (opts.createRefError) throw opts.createRefError;
        const name = params.ref.replace("refs/heads/", "");
        if (opts.existingRefs?.includes(name)) {
          throw apiError(422, "Reference already exists");
        }
        return { data: {} };
      },
    },
    repos: {
      async getContent(params: { path: string; ref: string }) {
        calls.getContent.push(params);
        throw apiError(404, "Not Found");
      },
      async createOrUpdateFileContents(params: { path: string; branch: string }) {
        calls.put.push(params);
        const err = opts.writeErrors?.[params.path] ?? opts.writeErrors?.["*"];
        if (err) throw err;
        commitCounter++;
        return { data: { commit: { sha: `commit${commitCounter}00000000` } } };
      },
    },
    pulls: {
      async create(params: { head: string; base: string }) {
        calls.create.push(params);
        if (opts.createPrError) throw opts.createPrError;
        return { data: { number: 99, html_url: "https://github.com/o/r/pull/99" } };
      },
    },
  };

  // The module only ever touches the five methods above; the cast is confined
  // to this test helper rather than leaking into src.
  return { octokit: octokit as unknown as Parameters<typeof createStackedPr>[0], calls };
}

const EDITS = [{ path: "src/a.ts", content: "a" }];

describe("stacked branch naming", () => {
  it("never repeats a name across clicks", () => {
    const names = new Set(
      Array.from({ length: 200 }, () => stackedBranchName("docstrings", 42, "abcdef1234")),
    );
    expect(names.size).toBe(200);
  });

  it("names the touch, the PR and the commit it stacks on", () => {
    const name = stackedBranchName("docstrings", 42, "abcdef1234567");
    expect(name).toMatch(/^diffsentry\/docstrings\/pr-42-abcdef1-[0-9a-f]{6}$/);
  });

  it("keeps two concurrent PRs on different branches", () => {
    const a = stackedBranchName("simplify", 1, "aaaaaaa");
    const b = stackedBranchName("simplify", 2, "aaaaaaa");
    expect(a).toContain("pr-1-");
    expect(b).toContain("pr-2-");
  });
});

describe("createStackedPr — the happy path", () => {
  it("stacks on the PR head branch, not the default branch", async () => {
    const { octokit, calls } = fakeOctokit();
    const out = await createStackedPr(octokit, ctx(), EDITS, {
      touch: "docstrings",
      title: "T",
      body: "B",
      commitMessage: "M",
    });

    expect(out.error).toBeUndefined();
    expect(out.stacked?.number).toBe(99);
    expect(out.stacked?.base).toBe("feat/thing");
    expect(calls.create).toEqual([
      expect.objectContaining({ base: "feat/thing", head: out.stacked!.branch }),
    ]);
  });

  it("writes every file to the new branch and never to the head branch", async () => {
    const { octokit, calls } = fakeOctokit();
    const out = await createStackedPr(
      octokit,
      ctx(),
      [
        { path: "src/a.ts", content: "a" },
        { path: "src/b.ts", content: "b" },
      ],
      { touch: "simplify", title: "T", body: "B", commitMessage: "M" },
    );

    expect(out.filesChanged).toBe(2);
    const branches = calls.put.map((p) => (p as { branch: string }).branch);
    expect(new Set(branches)).toEqual(new Set([out.stacked!.branch]));
    expect(branches).not.toContain("feat/thing");
  });

  it("branches from the live head ref rather than the reviewed sha", async () => {
    const { octokit, calls } = fakeOctokit({ headSha: "9999999888888877777776666666" });
    await createStackedPr(octokit, ctx(), EDITS, {
      touch: "tests",
      title: "T",
      body: "B",
      commitMessage: "M",
    });
    expect(calls.getRef).toEqual([expect.objectContaining({ ref: "heads/feat/thing" })]);
    expect(calls.createRef[0]).toEqual(
      expect.objectContaining({ sha: "9999999888888877777776666666" }),
    );
  });
});

describe("createStackedPr — every failure says something", () => {
  it("surfaces a head ref it cannot read", async () => {
    const { octokit, calls } = fakeOctokit({ getRefError: apiError(404, "Branch not found") });
    const out = await createStackedPr(octokit, ctx(), EDITS, {
      touch: "docstrings",
      title: "T",
      body: "B",
      commitMessage: "M",
    });

    expect(out.stacked).toBeUndefined();
    expect(out.error).toContain("feat/thing");
    expect(out.error).toContain("Branch not found");
    expect(calls.createRef).toHaveLength(0);
  });

  it("retries a name collision instead of failing on it", async () => {
    // Two clicks in the same millisecond: the first name is already taken.
    // Capture whatever name the first attempt picks and refuse exactly that
    // one, so the retry has to produce a different one to get through.
    const attempted: string[] = [];
    const { octokit } = fakeOctokit();
    octokit.git.createRef = async (params: { ref: string; sha: string }) => {
      attempted.push(params.ref);
      if (attempted.length === 1) throw apiError(422, "Reference already exists");
      return { data: {} };
    };

    const out = await createStackedPr(octokit, ctx(), EDITS, {
      touch: "docstrings",
      title: "T",
      body: "B",
      commitMessage: "M",
    });

    expect(attempted).toHaveLength(2);
    expect(attempted[0]).not.toBe(attempted[1]);
    expect(out.stacked?.number).toBe(99);
    expect(out.error).toBeUndefined();
  });

  it("gives up with a message after repeated collisions", async () => {
    const { octokit, calls } = fakeOctokit({
      createRefError: apiError(422, "Reference already exists"),
    });
    const out = await createStackedPr(octokit, ctx(), EDITS, {
      touch: "docstrings",
      title: "T",
      body: "B",
      commitMessage: "M",
    });

    expect(calls.createRef).toHaveLength(3);
    expect(out.error).toContain("couldn't create a branch");
    expect(out.error).toContain("already exists");
    expect(calls.create).toHaveLength(0);
  });

  it("surfaces a refused branch creation (protected ref, no permission)", async () => {
    const { octokit } = fakeOctokit({
      createRefError: apiError(403, "Resource not accessible by integration"),
    });
    const out = await createStackedPr(octokit, ctx(), EDITS, {
      touch: "autofix",
      title: "T",
      body: "B",
      commitMessage: "M",
    });
    expect(out.error).toContain("Resource not accessible by integration");
    expect(out.error).toContain("HTTP 403");
  });

  it("reports the branch it left behind when no file could be written", async () => {
    const { octokit, calls } = fakeOctokit({
      writeErrors: { "*": apiError(409, "is at 1234 but expected 5678") },
    });
    const out = await createStackedPr(octokit, ctx(), EDITS, {
      touch: "docstrings",
      title: "T",
      body: "B",
      commitMessage: "M",
    });

    expect(calls.create).toHaveLength(0);
    expect(out.filesChanged).toBe(0);
    expect(out.orphanBranch).toMatch(/^diffsentry\/docstrings\//);
    expect(out.error).toContain("could not write any file");
    expect(out.failures).toHaveLength(1);
    expect(out.failures[0].path).toBe("src/a.ts");
  });

  it("keeps the pushed branch and names it when pulls.create is refused", async () => {
    const { octokit } = fakeOctokit({
      createPrError: apiError(422, "GitHub Actions is not permitted to create pull requests"),
    });
    const out = await createStackedPr(octokit, ctx(), EDITS, {
      touch: "tests",
      title: "T",
      body: "B",
      commitMessage: "M",
    });

    expect(out.filesChanged).toBe(1);
    expect(out.stacked).toBeUndefined();
    expect(out.orphanBranch).toMatch(/^diffsentry\/tests\//);
    expect(out.error).toContain("couldn't open a PR into `feat/thing`");
    expect(out.error).toContain("not permitted to create pull requests");
  });

  it("reports a partial write failure alongside the PR it did open", async () => {
    const { octokit } = fakeOctokit({ writeErrors: { "src/b.ts": apiError(413, "Too large") } });
    const out = await createStackedPr(
      octokit,
      ctx(),
      [
        { path: "src/a.ts", content: "a" },
        { path: "src/b.ts", content: "b" },
      ],
      { touch: "simplify", title: "T", body: "B", commitMessage: "M" },
    );

    expect(out.stacked?.number).toBe(99);
    expect(out.filesChanged).toBe(1);
    expect(out.failures).toEqual([{ path: "src/b.ts", message: "Too large (HTTP 413)" }]);
  });

  it("does nothing at all when there is nothing to deliver", async () => {
    const { octokit, calls } = fakeOctokit();
    const out = await createStackedPr(octokit, ctx(), [], {
      touch: "docstrings",
      title: "T",
      body: "B",
      commitMessage: "M",
    });
    expect(out.filesChanged).toBe(0);
    expect(calls.createRef).toHaveLength(0);
    expect(calls.getRef).toHaveLength(0);
  });
});

describe("commitToHeadBranch", () => {
  it("writes to the head branch and returns the last commit", async () => {
    const { octokit, calls } = fakeOctokit();
    const out = await commitToHeadBranch(octokit, ctx(), EDITS, "M");
    expect(out.filesChanged).toBe(1);
    expect(out.commitSha).toBe("commit100000000");
    expect(calls.put[0]).toEqual(expect.objectContaining({ branch: "feat/thing" }));
    expect(calls.createRef).toHaveLength(0);
  });

  it("no longer reports a wholly refused run as a clean no-op", async () => {
    const { octokit } = fakeOctokit({ writeErrors: { "*": apiError(403, "Protected branch") } });
    const out = await commitToHeadBranch(octokit, ctx(), EDITS, "M");
    expect(out.filesChanged).toBe(0);
    expect(out.error).toContain("every file write was refused");
    expect(out.failures[0].message).toContain("Protected branch");
  });
});

describe("formatDeliveryReply", () => {
  const base: StackedPrOutcome = { filesChanged: 0, failures: [] };

  it("links the stacked PR and names its base", () => {
    const reply = formatDeliveryReply(
      {
        ...base,
        filesChanged: 3,
        stacked: {
          branch: "diffsentry/docstrings/pr-42-abcdef1-aaaaaa",
          number: 99,
          url: "https://github.com/o/r/pull/99",
          base: "feat/thing",
        },
      },
      "docstrings",
      "nothing to do",
    );
    expect(reply).toContain("https://github.com/o/r/pull/99");
    expect(reply).toContain("stacked on `feat/thing`");
  });

  it("renders a failure as a warning callout, not silence", () => {
    const reply = formatDeliveryReply(
      { ...base, error: "I couldn't create a branch: nope" },
      "docstrings",
      "nothing to do",
    );
    expect(reply).toContain("> [!WARNING]");
    expect(reply).toContain("nope");
    expect(reply).not.toContain("nothing to do");
  });

  it("tells the user where an orphaned branch is", () => {
    const reply = formatDeliveryReply(
      { ...base, filesChanged: 1, error: "PR refused", orphanBranch: "diffsentry/tests/pr-1-a-b" },
      "unit tests",
      "nothing to do",
    );
    expect(reply).toContain("diffsentry/tests/pr-1-a-b");
    expect(reply).toContain("nothing was deleted");
  });

  it("reports the branch commit with a short sha", () => {
    const reply = formatDeliveryReply(
      { ...base, filesChanged: 2, commitSha: "abcdef1234567890" },
      "docstrings",
      "nothing to do",
    );
    expect(reply).toContain("Applied docstrings to 2 file(s).");
    expect(reply).toContain("`abcdef1`");
  });

  it("lists per-file failures even on an otherwise successful run", () => {
    const reply = formatDeliveryReply(
      { ...base, filesChanged: 1, commitSha: "aaa", failures: [{ path: "src/b.ts", message: "Too large" }] },
      "docstrings",
      "nothing to do",
    );
    expect(reply).toContain("I couldn't write 1 file(s):");
    expect(reply).toContain("`src/b.ts` — Too large");
  });

  it("falls back to the empty note only when nothing happened and nothing failed", () => {
    expect(formatDeliveryReply(base, "docstrings", "No files needed docstring updates.")).toBe(
      "No files needed docstring updates.",
    );
  });
});
