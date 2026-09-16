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
  /** PR commits, oldest first, as `listPRCommits` returns them. */
  commits?: string[];
}) {
  const upsertComment = vi.fn().mockResolvedValue(undefined);
  // Every note the reviewer produced for a thread that closed, in order — what
  // GitHub would have posted as a reply before collapsing each thread.
  const notes: (string | null)[] = [];
  const github = {
    getPRContext: vi.fn().mockResolvedValue({
      headSha: "abc123",
      files: [{ filename: "a.ts" }, { filename: "b.ts" }],
    }),
    listPRCommits: vi.fn().mockResolvedValue(
      (opts.commits ?? []).map((sha) => ({ sha, message: "" })),
    ),
    // Stands in for the real method's loop: it asks the caller for a note on
    // every thread it is about to close, then reports what it closed.
    resolveAddressedThreads: vi.fn().mockImplementation(
      async (
        _inst: number, _o: string, _r: string, _n: number, _files: string[],
        resolveOpts?: { addressedNote?: (fp: string) => Promise<string | null> },
      ) => {
        for (const fp of opts.fingerprints) {
          notes.push(resolveOpts?.addressedNote ? await resolveOpts.addressedNote(fp) : null);
        }
        return {
          resolved: Math.max(opts.fingerprints.length, opts.paths?.length ?? 0),
          fingerprints: opts.fingerprints,
          paths: opts.paths ?? ["a.ts"],
        };
      },
    ),
    findCommentByMarker: vi.fn().mockResolvedValue(opts.comment ?? null),
    upsertComment,
  };
  const reviewer = Object.create(Reviewer.prototype) as InstanceType<typeof Reviewer>;
  (reviewer as unknown as { github: unknown }).github = github;
  const syncReviewCommitStatus = vi.fn().mockResolvedValue(true);
  (reviewer as unknown as { syncReviewCommitStatus: unknown }).syncReviewCommitStatus = syncReviewCommitStatus;
  return { reviewer, github, upsertComment, syncReviewCommitStatus, notes };
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

/**
 * Resolving a thread says DiffSentry stopped worrying; it doesn't say what
 * changed. On a PR with a dozen pushes that is the only question worth asking,
 * because a thread closed for the wrong reason looks identical to one closed
 * for the right one. The note names the commits so the claim is checkable.
 *
 * `findingShas` is what makes it possible — `lastReviewedSha` is per-review, and
 * the two diverge the moment a PR gets a second push.
 */
describe("the addressed note", () => {
  it("names the commits that landed after the finding was raised", async () => {
    const { reviewer, notes } = reviewerWith({
      fingerprints: ["aaa"],
      commits: ["c0000000", "c1111111", "c2222222"],
      comment: {
        id: 9,
        body: walkthroughBody({ postedFingerprints: ["aaa"], findingShas: { aaa: "c0000000" } }),
      },
    });

    await reviewer.autoResolveOnPush(1, "o", "r", 7);

    expect(notes).toEqual(["✅ Addressed in commits c111111 to c222222"]);
  });

  it("uses the singular form when a single commit landed", async () => {
    const { reviewer, notes } = reviewerWith({
      fingerprints: ["aaa"],
      commits: ["c0000000", "c1111111"],
      comment: {
        id: 9,
        body: walkthroughBody({ postedFingerprints: ["aaa"], findingShas: { aaa: "c0000000" } }),
      },
    });

    await reviewer.autoResolveOnPush(1, "o", "r", 7);

    expect(notes).toEqual(["✅ Addressed in commit c111111"]);
  });

  it("dates each finding from its own first raise, not the last review", async () => {
    // The whole reason the field exists: two findings raised on different
    // pushes get different ranges out of the same resolution pass.
    const { reviewer, notes } = reviewerWith({
      fingerprints: ["aaa", "bbb"],
      commits: ["c0000000", "c1111111", "c2222222"],
      comment: {
        id: 9,
        body: walkthroughBody({
          postedFingerprints: ["aaa", "bbb"],
          findingShas: { aaa: "c0000000", bbb: "c1111111" },
        }),
      },
    });

    await reviewer.autoResolveOnPush(1, "o", "r", 7);

    expect(notes).toEqual([
      "✅ Addressed in commits c111111 to c222222",
      "✅ Addressed in commit c222222",
    ]);
  });

  it("says nothing for a thread whose finding predates the field", async () => {
    // Every PR reviewed before findingShas shipped lands here. Silence is the
    // answer, and the commit list must not even be fetched.
    const { reviewer, notes, github } = reviewerWith({
      fingerprints: ["aaa"],
      commits: ["c0000000", "c1111111"],
      comment: { id: 9, body: walkthroughBody({ postedFingerprints: ["aaa"] }) },
    });

    await reviewer.autoResolveOnPush(1, "o", "r", 7);

    expect(notes).toEqual([null]);
    expect(github.listPRCommits).not.toHaveBeenCalled();
  });

  it("says nothing when the raised SHA is gone from the PR", async () => {
    // Force-push. Naming a range from a rewritten history points the reader at
    // a diff that never contained the fix.
    const { reviewer, notes } = reviewerWith({
      fingerprints: ["aaa"],
      commits: ["d0000000", "d1111111"],
      comment: {
        id: 9,
        body: walkthroughBody({ postedFingerprints: ["aaa"], findingShas: { aaa: "c0000000" } }),
      },
    });

    await reviewer.autoResolveOnPush(1, "o", "r", 7);

    expect(notes).toEqual([null]);
  });

  it("retires the raised SHA along with the fingerprint it belongs to", async () => {
    // Left behind, it would date the next raise of the same finding from the
    // first one — naming commits the reader already watched the thread survive.
    const { reviewer, upsertComment } = reviewerWith({
      fingerprints: ["aaa"],
      commits: ["c0000000", "c1111111"],
      comment: {
        id: 9,
        body: walkthroughBody({
          postedFingerprints: ["aaa", "bbb"],
          findingShas: { aaa: "c0000000", bbb: "c1111111" },
        }),
      },
    });

    await reviewer.autoResolveOnPush(1, "o", "r", 7);

    const written = upsertComment.mock.calls[0][4] as string;
    expect(extractState(written)?.findingShas).toEqual({ bbb: "c1111111" });
    expect(extractState(written)?.postedFingerprints).toEqual(["bbb"]);
  });

  it("reads the walkthrough comment once, not once per closed thread", async () => {
    const { reviewer, github } = reviewerWith({
      fingerprints: ["aaa", "bbb"],
      commits: ["c0000000", "c1111111"],
      comment: {
        id: 9,
        body: walkthroughBody({
          postedFingerprints: ["aaa", "bbb"],
          findingShas: { aaa: "c0000000", bbb: "c0000000" },
        }),
      },
    });

    await reviewer.autoResolveOnPush(1, "o", "r", 7);

    expect(github.findCommentByMarker).toHaveBeenCalledTimes(1);
    expect(github.listPRCommits).toHaveBeenCalledTimes(1);
  });
});
