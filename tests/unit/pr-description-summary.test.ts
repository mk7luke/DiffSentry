import { describe, it, expect, vi } from "vitest";
import { GitHubClient } from "../../src/github.js";
import { injectSummaryIntoPRBody } from "../../src/walkthrough.js";
import type { Config } from "../../src/types.js";

// A review runs for minutes. DiffSentry used to write the PR description back
// from the snapshot it captured before the model calls started, so any edit the
// author made in the meantime was silently reverted — including edits made in
// response to DiffSentry's own description findings, which then got re-raised
// against text DiffSentry itself had restored.

const SUMMARY =
  "<!-- DiffSentry Summary -->\n## Summary\n\nAdds the retry hook.\n\n<!-- End DiffSentry Summary -->";
const OLD_SUMMARY =
  "<!-- DiffSentry Summary -->\n## Summary\n\nStale prose from an earlier run.\n\n<!-- End DiffSentry Summary -->";

function cfg(): Config {
  return { githubAppId: "1", githubPrivateKey: "k" } as unknown as Config;
}

function harness(live: string | null | { throws: true }) {
  const updates: string[] = [];
  /** Calls in order, so a test can assert the read precedes the write. */
  const calls: string[] = [];
  const octokit = {
    pulls: {
      get: async () => {
        calls.push("get");
        if (live && typeof live === "object") throw new Error("502 from GitHub");
        return { data: { body: live } };
      },
      update: async ({ body }: { body: string }) => {
        calls.push("update");
        updates.push(body);
        return { data: {} };
      },
    },
  };
  const client = new GitHubClient(cfg());
  const auth = vi.spyOn(client, "getInstallationOctokit").mockResolvedValue(octokit as never);
  return { client, updates, calls, auth };
}

describe("upsertSummaryInPRDescription", () => {
  it("rebases onto the description as it is now, not a caller's snapshot", async () => {
    // The reported bug: the author corrected a sentence while the review was
    // in flight. The summary write must carry that correction forward.
    const { client, updates } = harness(
      "Corrected sentence the author just saved.\n\n" + OLD_SUMMARY,
    );

    const written = await client.upsertSummaryInPRDescription(1, "acme", "app", 7, SUMMARY);

    expect(written).toBe(true);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toContain("Corrected sentence the author just saved.");
    expect(updates[0]).toContain("Adds the retry hook.");
    expect(updates[0]).not.toContain("Stale prose from an earlier run.");
  });

  it("appends the summary when the live description has no block yet", async () => {
    const { client, updates } = harness("Author prose, no DiffSentry block.");

    await client.upsertSummaryInPRDescription(1, "acme", "app", 7, SUMMARY);

    expect(updates[0]).toContain("Author prose, no DiffSentry block.");
    expect(updates[0]).toContain(SUMMARY);
  });

  it("skips the write when the live description already carries this summary", async () => {
    // Re-reviews of an unchanged PR shouldn't churn the description, which
    // notifies watchers and fires a `pull_request.edited` webhook each time.
    const { client, updates } = harness("Author prose.\n\n---\n\n" + SUMMARY);

    const written = await client.upsertSummaryInPRDescription(1, "acme", "app", 7, SUMMARY);

    expect(written).toBe(false);
    expect(updates).toEqual([]);
  });

  it("leaves the description untouched when the live body can't be read", async () => {
    // Nothing safe to merge onto: the only fallback available is exactly the
    // stale snapshot this method exists to avoid.
    const { client, updates } = harness({ throws: true });

    const written = await client.upsertSummaryInPRDescription(1, "acme", "app", 7, SUMMARY);

    expect(written).toBe(false);
    expect(updates).toEqual([]);
  });

  it("writes through the client that already read, adding no round trip to the race window", async () => {
    // The read→write gap is the one window in which an author edit can still
    // be lost, and it cannot be closed: GitHub rejects conditional headers on
    // this endpoint outright (400 "Conditional request headers are not allowed
    // in unsafe requests unless supported by the endpoint"), so there is no
    // If-Match/compare-and-swap to reach for. All that's left is to keep the
    // gap as short as possible. getInstallationOctokit builds a *new* Octokit
    // each call, and a new client mints a fresh installation token on its first
    // request — routing the write through a second client put an entire auth
    // round trip between the read and the write.
    const { client, calls, auth } = harness("Author prose.");

    await client.upsertSummaryInPRDescription(1, "acme", "app", 7, SUMMARY);

    expect(calls).toEqual(["get", "update"]);
    expect(auth).toHaveBeenCalledTimes(1);
  });

  it("treats a null description as empty rather than the string 'null'", async () => {
    const { client, updates } = harness(null);

    await client.upsertSummaryInPRDescription(1, "acme", "app", 7, SUMMARY);

    expect(updates[0]).toBe(SUMMARY);
  });
});

describe("injectSummaryIntoPRBody — marker collisions", () => {
  // Self-inflicted on PR #132, which described this very fix and so quoted the
  // marker in prose. `indexOf` anchored the splice on that mention and paired
  // it with the real block's end marker 3189 bytes later, deleting 35 lines of
  // the author's description. A fresh read does not help: the destruction is in
  // the merge, not in the staleness.
  const PROSE = "It only swaps the `<!-- DiffSentry Summary -->` block, in place.";

  it("does not anchor on a marker quoted inline in prose", () => {
    const body = `## Root cause\n\n${PROSE}\n\n---\n\n${OLD_SUMMARY}`;

    const out = injectSummaryIntoPRBody(body, SUMMARY);

    expect(out).toContain(PROSE);
    expect(out).toContain("## Root cause");
    expect(out).toContain("Adds the retry hook.");
    expect(out).not.toContain("Stale prose from an earlier run.");
  });

  it("still replaces the block when prose quotes the marker after it", () => {
    const body = `${OLD_SUMMARY}\n\n${PROSE}`;

    const out = injectSummaryIntoPRBody(body, SUMMARY);

    expect(out).toContain(PROSE);
    expect(out).toContain("Adds the retry hook.");
    expect(out).not.toContain("Stale prose from an earlier run.");
  });

  it("is idempotent across repeated reviews of a description that quotes it", () => {
    // The real failure mode was cumulative: each review ate another chunk.
    const body = `## Root cause\n\n${PROSE}\n\n---\n\n${OLD_SUMMARY}`;

    const once = injectSummaryIntoPRBody(body, SUMMARY);
    const twice = injectSummaryIntoPRBody(once, SUMMARY);

    expect(twice).toBe(once);
    expect(twice).toContain(PROSE);
  });

  it("appends rather than splicing when only a prose mention exists", () => {
    // No real block yet — the very first review of PR #132's description.
    const body = `## Root cause\n\n${PROSE}`;

    const out = injectSummaryIntoPRBody(body, SUMMARY);

    expect(out).toContain(PROSE);
    expect(out).toContain("## Root cause");
    expect(out).toContain(SUMMARY);
  });
});
