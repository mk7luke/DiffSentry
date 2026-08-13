import { describe, it, expect, vi, beforeEach } from "vitest";
import { encodeState, extractState, replaceState } from "../../src/walkthrough-state.js";

const saveWalkthroughState = vi.fn().mockReturnValue(true);
let dbState: unknown = null;

vi.mock("../../src/storage/dao.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/storage/dao.js")>();
  return {
    ...actual,
    getWalkthroughState: () => dbState,
    saveWalkthroughState: (...args: unknown[]) => saveWalkthroughState(...args),
  };
});

const { Reviewer } = await import("../../src/reviewer.js");

const WALKTHROUGH_MARKER = "<!-- DiffSentry Walkthrough -->";

/**
 * Push auto-resolve closes every DiffSentry thread on a file the push touched,
 * whether or not the finding was addressed — "the file changed" is all it knows.
 * Cross-review dedup (reviewer.ts, `priorFingerprints`) then drops the next
 * pass's re-raise of that same finding, so a still-true `major` would vanish
 * from the PR and leave the check green. Dropping the resolved threads'
 * fingerprints is what keeps the two compatible: the finding gets one honest
 * re-raise per push, and only a resolution nobody undid makes it stick.
 */
function reviewerWith(opts: {
  fingerprints: string[];
  paths?: string[];
  priorState?: Record<string, unknown>;
  comment?: { id: number; body: string } | null;
}) {
  const upsertComment = vi.fn().mockResolvedValue(undefined);
  const github = {
    getPRContext: vi.fn().mockResolvedValue({
      headSha: "abc123",
      files: [{ filename: "a.ts" }, { filename: "b.ts" }],
    }),
    resolveAddressedThreads: vi.fn().mockResolvedValue({
      resolved: Math.max(opts.fingerprints.length, opts.paths?.length ?? 0),
      fingerprints: opts.fingerprints,
      paths: opts.paths ?? ["a.ts"],
    }),
    findCommentByMarker: vi.fn().mockResolvedValue(opts.comment ?? null),
    upsertComment,
  };
  const reviewer = Object.create(Reviewer.prototype) as InstanceType<typeof Reviewer>;
  (reviewer as unknown as { github: unknown }).github = github;
  const syncReviewCommitStatus = vi.fn().mockResolvedValue(true);
  (reviewer as unknown as { syncReviewCommitStatus: unknown }).syncReviewCommitStatus = syncReviewCommitStatus;
  return { reviewer, github, upsertComment, syncReviewCommitStatus };
}

function walkthroughBody(state: Record<string, unknown>) {
  return [
    WALKTHROUGH_MARKER,
    "## Walkthrough",
    "",
    "<!-- internal_state_start -->",
    encodeState({ v: 1, ...state } as never),
    "<!-- internal_state_end -->",
  ].join("\n");
}

beforeEach(() => {
  dbState = null;
  saveWalkthroughState.mockClear();
});

describe("replaceState", () => {
  it("swaps the encoded blob in place, leaving the rest of the body untouched", () => {
    const before = walkthroughBody({ postedFingerprints: ["aaa", "bbb"] });
    const after = replaceState(before, { v: 1, postedFingerprints: ["bbb"] });

    expect(extractState(after)?.postedFingerprints).toEqual(["bbb"]);
    expect(after).toContain("## Walkthrough");
    expect(after).toContain("<!-- internal_state_start -->");
    expect(after.startsWith(WALKTHROUGH_MARKER)).toBe(true);
  });

  it("returns the body unchanged when it carries no state blob", () => {
    const body = "## Walkthrough\n\nNo state here.";
    expect(replaceState(body, { v: 1, postedFingerprints: [] })).toBe(body);
  });
});

describe("autoResolveOnPush", () => {
  it("drops the resolved threads' fingerprints from the walkthrough comment", async () => {
    const { reviewer, upsertComment } = reviewerWith({
      fingerprints: ["aaa", "ccc"],
      comment: { id: 9, body: walkthroughBody({ postedFingerprints: ["aaa", "bbb", "ccc"] }) },
    });

    await reviewer.autoResolveOnPush(1, "o", "r", 7);

    expect(upsertComment).toHaveBeenCalledTimes(1);
    const written = upsertComment.mock.calls[0][4] as string;
    expect(extractState(written)?.postedFingerprints).toEqual(["bbb"]);
  });

  it("drops them from the database copy too", async () => {
    // The next pass prefers the DB row over the comment blob, so a drop written
    // only to the comment would be overruled and the finding stay suppressed.
    dbState = { v: 1, postedFingerprints: ["aaa", "bbb"] };
    const { reviewer } = reviewerWith({
      fingerprints: ["aaa"],
      comment: { id: 9, body: walkthroughBody({ postedFingerprints: ["aaa", "bbb"] }) },
    });

    await reviewer.autoResolveOnPush(1, "o", "r", 7);

    expect(saveWalkthroughState).toHaveBeenCalledTimes(1);
    const saved = saveWalkthroughState.mock.calls[0][3] as { postedFingerprints: string[] };
    expect(saved.postedFingerprints).toEqual(["bbb"]);
  });

  it("retires the file SHAs of the files whose threads it closed", async () => {
    // Retiring the fingerprint alone isn't enough. `getPRContext` returns the
    // PR's WHOLE diff, not the push delta, so auto-resolve closes threads on
    // files this push never touched — and `partitionFilesForReview` then skips
    // exactly those files on the next incremental pass, because their patch
    // hash is unchanged. The finding would be closed, un-suppressed, and still
    // never looked at again. Dropping the file SHA forces the re-read.
    const { reviewer, upsertComment } = reviewerWith({
      fingerprints: ["aaa"],
      paths: ["b.ts"],
      comment: {
        id: 9,
        body: walkthroughBody({
          postedFingerprints: ["aaa"],
          fileShas: { "a.ts": "h1", "b.ts": "h2" },
        }),
      },
    });

    await reviewer.autoResolveOnPush(1, "o", "r", 7);

    const written = upsertComment.mock.calls[0][4] as string;
    expect(extractState(written)?.fileShas).toEqual({ "a.ts": "h1" });
  });

  it("retires a file SHA even for a thread that carried no fingerprint", async () => {
    // Threads posted before fingerprints were stamped have nothing to
    // un-suppress, but their file still has to be re-read — otherwise closing
    // one is a pure deletion.
    const { reviewer, upsertComment } = reviewerWith({
      fingerprints: [],
      paths: ["b.ts"],
      comment: { id: 9, body: walkthroughBody({ fileShas: { "a.ts": "h1", "b.ts": "h2" } }) },
    });

    await reviewer.autoResolveOnPush(1, "o", "r", 7);

    expect(upsertComment).toHaveBeenCalledTimes(1);
    const written = upsertComment.mock.calls[0][4] as string;
    expect(extractState(written)?.fileShas).toEqual({ "a.ts": "h1" });
  });

  it("leaves state alone when nothing it resolved was ever fingerprinted", async () => {
    const { reviewer, upsertComment } = reviewerWith({
      fingerprints: [],
      comment: { id: 9, body: walkthroughBody({ postedFingerprints: ["aaa"] }) },
    });

    await reviewer.autoResolveOnPush(1, "o", "r", 7);

    expect(upsertComment).not.toHaveBeenCalled();
    expect(saveWalkthroughState).not.toHaveBeenCalled();
  });

  it("leaves state alone when the resolved fingerprints were never recorded", async () => {
    // No overlap ⇒ no rewrite. Keeps a routine push from churning the comment.
    const { reviewer, upsertComment } = reviewerWith({
      fingerprints: ["zzz"],
      comment: { id: 9, body: walkthroughBody({ postedFingerprints: ["aaa"] }) },
    });

    await reviewer.autoResolveOnPush(1, "o", "r", 7);

    expect(upsertComment).not.toHaveBeenCalled();
    expect(saveWalkthroughState).not.toHaveBeenCalled();
  });

  it("still syncs the commit status when the state rewrite fails", async () => {
    // The status is the merge gate; bookkeeping must not hold it hostage.
    const { reviewer, upsertComment, syncReviewCommitStatus } = reviewerWith({
      fingerprints: ["aaa"],
      comment: { id: 9, body: walkthroughBody({ postedFingerprints: ["aaa"] }) },
    });
    upsertComment.mockRejectedValue(new Error("403"));

    await reviewer.autoResolveOnPush(1, "o", "r", 7);

    expect(syncReviewCommitStatus).toHaveBeenCalledWith(1, "o", "r", 7, { headSha: "abc123" });
  });

  it("does nothing at all when no thread was resolved", async () => {
    const { reviewer, github, syncReviewCommitStatus } = reviewerWith({ fingerprints: [] });
    (github.resolveAddressedThreads as ReturnType<typeof vi.fn>).mockResolvedValue({
      resolved: 0,
      fingerprints: [],
      paths: [],
    });

    await reviewer.autoResolveOnPush(1, "o", "r", 7);

    expect(syncReviewCommitStatus).not.toHaveBeenCalled();
    expect(github.findCommentByMarker).not.toHaveBeenCalled();
  });
});
