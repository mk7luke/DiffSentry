import { describe, it, expect, vi } from "vitest";
import { GitHubClient } from "../../src/github.js";
import type { Config } from "../../src/types.js";

// getPRContext used to call pulls.listFiles with per_page: 100 and no
// pagination, so PRs over 100 files silently lost the remainder. The loss was
// invisible downstream: dropped files never reach ignoredFiles or cappedFiles,
// so description drift read their absence as the description claiming changes
// that weren't in the code.

function cfg(overrides: Partial<Config> = {}): Config {
  return {
    githubAppId: "1",
    githubPrivateKey: "k",
    maxFilesPerReview: 10_000,
    ignoredPatterns: [],
    ...overrides,
  } as unknown as Config;
}

function ghFile(i: number) {
  return {
    filename: `src/file-${i}.ts`,
    status: "modified",
    patch: `@@ -1 +1,2 @@\n context\n+line ${i}\n`,
    additions: 1,
    deletions: 0,
  };
}

/**
 * Faithful stand-in for octokit.paginate(route, params, mapFn): walks pages,
 * invokes the mapper with (response, done), and stops early when done() is
 * called — which is how the LISTFILES_MAX bound is enforced.
 */
function fakeOctokit(totalFiles: number) {
  const pages: unknown[][] = [];
  for (let i = 0; i < totalFiles; i += 100) {
    pages.push(Array.from({ length: Math.min(100, totalFiles - i) }, (_, j) => ghFile(i + j)));
  }
  let pagesFetched = 0;

  return {
    pagesFetched: () => pagesFetched,
    pulls: {
      get: async () => ({
        data: {
          title: "t",
          body: "d",
          base: { ref: "main", repo: { default_branch: "main" } },
          head: { ref: "feat", sha: "deadbee" },
          draft: false,
          labels: [],
          user: { login: "someone" },
        },
      }),
      listFiles: "listFiles-route",
    },
    paginate: async (_route: unknown, _params: unknown, mapFn: (r: any, done: () => void) => unknown[]) => {
      const out: unknown[] = [];
      let stopped = false;
      const done = () => {
        stopped = true;
      };
      for (const page of pages) {
        pagesFetched++;
        out.push(...mapFn({ data: page }, done));
        if (stopped) break;
      }
      return out;
    },
  };
}

async function filesFor(totalFiles: number, config = cfg()) {
  const client = new GitHubClient(config);
  const octokit = fakeOctokit(totalFiles);
  vi.spyOn(client, "getInstallationOctokit").mockResolvedValue(octokit as never);
  const context = await client.getPRContext(1, "o", "r", 1);
  return { context, octokit };
}

describe("getPRContext — listFiles pagination", () => {
  it("fetches every file in a PR larger than one page", async () => {
    const { context, octokit } = await filesFor(250);

    expect(context.files).toHaveLength(250);
    expect(context.files[249].filename).toBe("src/file-249.ts");
    expect(octokit.pagesFetched()).toBe(3);
  });

  it("still works for a single-page PR without extra requests", async () => {
    const { context, octokit } = await filesFor(40);

    expect(context.files).toHaveLength(40);
    expect(octokit.pagesFetched()).toBe(1);
  });

  it("stops at GitHub's 3000-file ceiling instead of walking forever", async () => {
    const { context, octokit } = await filesFor(3500);

    expect(context.files).toHaveLength(3000);
    // 30 pages of 100 reaches the bound; the 31st is never requested.
    expect(octokit.pagesFetched()).toBe(30);
  });

  it("applies the file cap to the fully-paginated set, recording the overflow", async () => {
    // The cap must see all 250 files, not just the first page — otherwise
    // cappedFiles under-reports what review skipped.
    const { context } = await filesFor(250, cfg({ maxFilesPerReview: 60 }));

    expect(context.files).toHaveLength(60);
    expect(context.cappedFiles).toHaveLength(190);
    expect(context.cappedFiles).toContain("src/file-249.ts");
  });
});
