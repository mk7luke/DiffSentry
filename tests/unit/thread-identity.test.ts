import { describe, it, expect, vi } from "vitest";
import { GitHubClient } from "../../src/github.js";
import { resolveReviewStatus } from "../../src/ship-check.js";
import type { Config } from "../../src/types.js";
import { renderSeverityMarker, renderFingerprintMarker, DIFFSENTRY_COMMENT_FOOTER } from "../../src/thread-severity.js";

/**
 * The thread gate reads authorship off GraphQL, and GraphQL's `Bot` node
 * reports a login WITHOUT the `[bot]` suffix that REST appends. `isOurBotThread`
 * compared the two shapes directly, so it matched nothing: `botTotal`,
 * `botUnresolved` and `botUnresolvedBlocking` came back 0 for every PR, the
 * severity gate never fired once, and the `DiffSentry` check went green beside
 * its own open `major` findings.
 *
 * The unit fixtures couldn't catch it — they were written in the REST shape, so
 * they agreed with the bug. These tests drive the whole read path (query →
 * authorship → severity) over payloads copied from a live API response instead.
 */

function cfg(overrides: Partial<Config> = {}): Config {
  return {
    githubAppId: "1",
    githubPrivateKey: "k",
    botName: "diffsentry",
    ...overrides,
  } as unknown as Config;
}

/** Exactly what `author` looks like on a live `reviewThreads` response. */
const OUR_BOT = { __typename: "Bot", login: "diffsentry" };

function body(opts: { severity?: string; fingerprint?: string; footer?: boolean } = {}) {
  const parts = ["A finding."];
  if (opts.fingerprint) parts.push(renderFingerprintMarker(opts.fingerprint));
  if (opts.severity) parts.push(renderSeverityMarker(opts.severity as "major"));
  if (opts.footer !== false) parts.push(DIFFSENTRY_COMMENT_FOOTER);
  return parts.join("\n\n");
}

function graphqlThread(over: {
  id?: string;
  path?: string;
  isResolved?: boolean;
  severity?: string;
  fingerprint?: string;
  /** Drop DiffSentry's footer, so only the login can claim the thread. */
  footer?: boolean;
  author?: { __typename: string; login: string };
}) {
  return {
    id: over.id ?? "PRRT_1",
    isResolved: over.isResolved ?? false,
    path: over.path ?? "backend/app/deps.py",
    comments: {
      nodes: [
        {
          body: body({ severity: over.severity, fingerprint: over.fingerprint, footer: over.footer }),
          author: over.author ?? OUR_BOT,
        },
      ],
    },
  };
}

/** A client whose GraphQL calls are served from `threads`, recording mutations. */
function clientWith(threads: unknown[], config: Config = cfg()) {
  const mutations: string[] = [];
  const graphql = vi.fn(async (query: string, vars: Record<string, unknown>) => {
    if (query.includes("resolveReviewThread")) {
      mutations.push(vars.threadId as string);
      return { resolveReviewThread: { thread: { id: vars.threadId } } };
    }
    return {
      repository: {
        pullRequest: {
          reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: threads },
        },
      },
    };
  });
  const client = new GitHubClient(config);
  vi.spyOn(client, "getInstallationOctokit").mockResolvedValue({ graphql } as never);
  return { client, graphql, mutations };
}

describe("summarizeReviewThreads over a live-shaped GraphQL payload", () => {
  it("recognises our own threads from the bare Bot login GraphQL returns", async () => {
    // Footer omitted throughout: a real DiffSentry comment carries one, and
    // `isOurBotThread` accepts it as proof of authorship, so a fixture with the
    // footer would pass on that alone and say nothing about the login the bug
    // was in. Here the login is the only thing that can claim these threads.
    const { client } = clientWith([
      graphqlThread({ id: "a", severity: "major", footer: false }),
      graphqlThread({ id: "b", severity: "major", footer: false }),
      graphqlThread({ id: "c", severity: "minor", footer: false }),
      graphqlThread({ id: "d", severity: "critical", isResolved: true, footer: false }),
    ]);

    const summary = await client.summarizeReviewThreads(1, "mk7luke", "atlas-timeclock", 120);

    expect(summary).toEqual({
      total: 4,
      unresolved: 3,
      botTotal: 4,
      botUnresolved: 3,
      // The two majors. This was 0 for the entire life of the gate.
      botUnresolvedBlocking: 2,
    });
  });

  it("counts human threads in the totals but never as ours", async () => {
    const { client } = clientWith([
      graphqlThread({ id: "a", severity: "major" }),
      graphqlThread({ id: "h", severity: "critical", author: { __typename: "User", login: "mk7luke" } }),
    ]);

    const summary = await client.summarizeReviewThreads(1, "o", "r", 1);

    expect(summary.total).toBe(2);
    expect(summary.unresolved).toBe(2);
    expect(summary.botTotal).toBe(1);
    expect(summary.botUnresolvedBlocking).toBe(1);
  });

  it("honours a custom BOT_NAME against the bare login", async () => {
    const { client } = clientWith(
      [
        graphqlThread({
          severity: "major",
          footer: false,
          author: { __typename: "Bot", login: "acme-review" },
        }),
      ],
      cfg({ botName: "acme-review" }),
    );

    const summary = await client.summarizeReviewThreads(1, "o", "r", 1);

    expect(summary.botTotal).toBe(1);
    expect(summary.botUnresolvedBlocking).toBe(1);
  });

  it("reproduces the reported PR: two open majors read as two blocking findings", async () => {
    // Payload shape copied from mk7luke/atlas-timeclock#120 @ a82d458, where
    // the check went green ("Review complete with comments") six seconds after
    // these two threads were posted.
    const { client } = clientWith([
      graphqlThread({ id: "1", path: "frontend/src/pages/pay/PayRecent.tsx", severity: "major" }),
      graphqlThread({ id: "2", path: "backend/app/deps.py", severity: "major" }),
    ]);

    const summary = await client.summarizeReviewThreads(1, "mk7luke", "atlas-timeclock", 120);

    expect(summary.botUnresolvedBlocking).toBe(2);
    expect(resolveReviewStatus({
      approval: "COMMENT",
      threads: summary,
      successDescription: "Review complete with comments",
    })).toEqual({ state: "failure", description: "2 unresolved blocking findings" });
  });
});

describe("resolveAddressedThreads", () => {
  it("resolves only our unresolved threads on changed files", async () => {
    const { client, mutations } = clientWith([
      graphqlThread({ id: "ours-changed", path: "a.ts", severity: "major" }),
      graphqlThread({ id: "ours-untouched", path: "b.ts", severity: "major" }),
      graphqlThread({ id: "ours-resolved", path: "a.ts", severity: "major", isResolved: true }),
      graphqlThread({
        id: "theirs",
        path: "a.ts",
        author: { __typename: "User", login: "mk7luke" },
      }),
    ]);

    const result = await client.resolveAddressedThreads(1, "o", "r", 1, ["a.ts"]);

    expect(mutations).toEqual(["ours-changed"]);
    expect(result.resolved).toBe(1);
  });

  it("reports the fingerprints of the threads it resolved", async () => {
    // The caller drops these from the walkthrough's postedFingerprints. Without
    // them, cross-review dedup would suppress the re-raise of a finding this
    // just closed on nothing more than "the file was touched" — greening the
    // check on a finding nobody addressed.
    const { client } = clientWith([
      graphqlThread({ id: "1", path: "a.ts", severity: "major", fingerprint: "aaa111" }),
      graphqlThread({ id: "2", path: "a.ts", severity: "minor", fingerprint: "bbb222" }),
      // No fingerprint marker (pre-dating them): resolved, but nothing to drop.
      graphqlThread({ id: "3", path: "a.ts", severity: "major" }),
      // Not on a changed file, so not resolved and not dropped.
      graphqlThread({ id: "4", path: "z.ts", severity: "major", fingerprint: "ccc333" }),
    ]);

    const result = await client.resolveAddressedThreads(1, "o", "r", 1, ["a.ts"]);

    expect(result.resolved).toBe(3);
    expect([...result.fingerprints].sort()).toEqual(["aaa111", "bbb222"]);
  });

  it("reports the paths it closed threads on, deduplicated", async () => {
    // The caller drops these from fileShas. `changedFiles` is the PR's whole
    // diff, so a thread can be closed on a file this push never touched — and
    // that is exactly the file an incremental pass would skip, leaving the
    // un-suppressed finding with nobody to re-raise it.
    const { client } = clientWith([
      graphqlThread({ id: "1", path: "a.ts", severity: "major", fingerprint: "aaa111" }),
      graphqlThread({ id: "2", path: "a.ts", severity: "major", fingerprint: "bbb222" }),
      graphqlThread({ id: "3", path: "b.ts", severity: "major" }),
      graphqlThread({ id: "4", path: "z.ts", severity: "major" }),
    ]);

    const result = await client.resolveAddressedThreads(1, "o", "r", 1, ["a.ts", "b.ts"]);

    expect([...result.paths].sort()).toEqual(["a.ts", "b.ts"]);
  });

  it("returns an empty result rather than throwing when the read fails", async () => {
    const client = new GitHubClient(cfg());
    vi.spyOn(client, "getInstallationOctokit").mockResolvedValue({
      graphql: vi.fn().mockRejectedValue(new Error("503")),
    } as never);

    await expect(client.resolveAddressedThreads(1, "o", "r", 1, ["a.ts"])).resolves.toEqual({
      resolved: 0,
      fingerprints: [],
      paths: [],
    });
  });

  it("does not report a fingerprint for a thread whose resolve mutation failed", async () => {
    // A dropped fingerprint plus a still-open thread would re-raise the finding
    // as a duplicate beside the one already on the PR.
    const client = new GitHubClient(cfg());
    const graphql = vi.fn(async (query: string) => {
      if (query.includes("resolveReviewThread")) throw new Error("403");
      return {
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [graphqlThread({ id: "1", path: "a.ts", severity: "major", fingerprint: "aaa111" })],
            },
          },
        },
      };
    });
    vi.spyOn(client, "getInstallationOctokit").mockResolvedValue({ graphql } as never);

    await expect(client.resolveAddressedThreads(1, "o", "r", 1, ["a.ts"])).resolves.toEqual({
      resolved: 0,
      fingerprints: [],
      paths: [],
    });
  });
});
