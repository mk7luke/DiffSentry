import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { renderLearningsUsed, resolveAppliedLearnings, parseReviewResponse } from "../../src/ai/parse.js";
import { LearningsStore, formatFindingLocation } from "../../src/learnings.js";
import { GLOBAL_REPO, Learning, PRContext } from "../../src/types.js";

/**
 * A learning overrides the reviewer's default judgement — it can silence a
 * whole class of real finding on every future PR. Until now it did that
 * invisibly: nothing DiffSentry posted said a learning had fired, let alone
 * which one or who taught it. A maintainer who disagreed with a finding had
 * nothing to argue with, and a learning that had gone stale had no way of
 * being noticed. Provenance is what makes one correctable.
 */

const LEARNING: Learning = {
  id: "l1",
  repo: "hypercerts-org/hypercerts-relay",
  content: "Prefer the repository's existing retry helper over a hand-rolled loop.",
  createdAt: "2026-09-09T17:11:30.140Z",
  author: "Ashex",
  prNumber: 22,
  sourceFile: "cmd/relay/control.go:166-170",
};

describe("renderLearningsUsed", () => {
  it("reproduces the captured block byte-for-byte", () => {
    // Transcribed, not designed. The corpus block is extracted here rather than
    // retyped so the assertion cannot drift from the evidence it claims to
    // match — including `Repo:` and `PR:` sharing one line.
    const corpus = fs.readFileSync(
      path.join(process.cwd(), "tests/e2e/reference/2026-09/coderabbit/inline.md"),
      "utf8",
    );
    const start = corpus.indexOf("<details>\n<summary>🧠 Learnings used</summary>");
    expect(start).toBeGreaterThan(-1);
    const captured = corpus.slice(start, corpus.indexOf("</details>", start) + "</details>".length);

    const [, author] = captured.match(/^Learnt from: (.+)$/m)!;
    const [, repo, pr] = captured.match(/^Repo: (\S+) PR: (\d+)$/m)!;
    const [, file] = captured.match(/^File: (.+)$/m)!;
    const [, timestamp] = captured.match(/^Timestamp: (.+)$/m)!;
    const [, content] = captured.match(/^Learning: (.+)$/m)!;

    expect(
      renderLearningsUsed([
        { id: "x", repo, content, createdAt: timestamp, author, prNumber: Number(pr), sourceFile: file },
      ]),
    ).toBe(captured);
  });

  it("omits the lines it has no data for", () => {
    // A learning added through the dashboard has no conversation to attribute.
    // A blank `Learnt from:` would claim there is one and name nobody.
    const rendered = renderLearningsUsed([
      { id: "l", repo: "acme/web", content: "Ship it.", createdAt: "2026-01-01T00:00:00.000Z" },
    ]);

    expect(rendered).toContain("Repo: acme/web");
    expect(rendered).toContain("Timestamp: 2026-01-01T00:00:00.000Z");
    expect(rendered).toContain("Learning: Ship it.");
    expect(rendered).not.toContain("Learnt from:");
    expect(rendered).not.toContain("PR:");
    expect(rendered).not.toContain("File:");
  });

  it("names the repo a cross-repo learning came from, not the sentinel", () => {
    // `repo` on a global learning is "*", which names nothing a reader can open.
    const rendered = renderLearningsUsed([
      {
        id: "g",
        repo: GLOBAL_REPO,
        content: "Never log tokens.",
        createdAt: "2026-01-01T00:00:00.000Z",
        sourceRepo: "acme/api",
        prNumber: 4,
      },
    ]);

    expect(rendered).toContain("Repo: acme/api PR: 4");
    expect(rendered).not.toContain("*");
  });

  it("says nothing at all when no learning fired", () => {
    expect(renderLearningsUsed([])).toBe("");
  });

  it("widens the fence past any backticks in the learning itself", () => {
    // Learning content is free text a maintainer wrote. A fence inside it would
    // close this block early and spill the finding body out as markup.
    const rendered = renderLearningsUsed([
      { ...LEARNING, content: "Avoid:\n```ts\nconst x = 1;\n```" },
    ]);

    expect(rendered).toContain("\n````\nLearnt from: Ashex");
    expect(rendered).toContain("```\n````\n\n</details>");
  });

  it("separates several learnings with a blank line inside one fence", () => {
    const rendered = renderLearningsUsed([
      LEARNING,
      { ...LEARNING, id: "l2", content: "Second rule.", author: "kim" },
    ]);

    expect(rendered.match(/^```$/gm)).toHaveLength(2);
    expect(rendered).toContain("Learning: Prefer the repository's existing retry helper over a hand-rolled loop.\n\nLearnt from: kim");
  });
});

describe("resolveAppliedLearnings", () => {
  const shown: Learning[] = [
    { ...LEARNING, id: "a", content: "first" },
    { ...LEARNING, id: "b", content: "second" },
  ];

  it("resolves 1-based indices into the list the model was shown", () => {
    expect(resolveAppliedLearnings([2], shown).map((l) => l.id)).toEqual(["b"]);
    expect(resolveAppliedLearnings([1, 2], shown).map((l) => l.id)).toEqual(["a", "b"]);
  });

  it("drops indices past the end", () => {
    // Attributing a finding to a rule that had nothing to do with it is worse
    // than attributing it to nothing.
    expect(resolveAppliedLearnings([0, 3, -1], shown)).toEqual([]);
  });

  it("drops non-integers and non-numbers", () => {
    expect(resolveAppliedLearnings(["1", 1.5, null, {}], shown)).toEqual([]);
  });

  it("de-duplicates a repeated index", () => {
    expect(resolveAppliedLearnings([1, 1, 1], shown).map((l) => l.id)).toEqual(["a"]);
  });

  it("resolves nothing when the field is not an array, or nothing was shown", () => {
    expect(resolveAppliedLearnings(undefined, shown)).toEqual([]);
    expect(resolveAppliedLearnings(2, shown)).toEqual([]);
    expect(resolveAppliedLearnings([1], undefined)).toEqual([]);
    expect(resolveAppliedLearnings([1], [])).toEqual([]);
  });
});

describe("formatFindingLocation", () => {
  it("names a single line", () => {
    expect(formatFindingLocation("src/a.ts", null, 42)).toBe("src/a.ts:42");
  });

  it("names a range when the finding spanned one", () => {
    // A learning taught against a multi-line finding is usually about the shape
    // of that whole block; its first line alone makes the reader guess.
    expect(formatFindingLocation("src/a.ts", 40, 42)).toBe("src/a.ts:40-42");
  });

  it("collapses a degenerate range to the single form", () => {
    expect(formatFindingLocation("src/a.ts", 42, 42)).toBe("src/a.ts:42");
  });

  it("falls back to the bare path when there is no line", () => {
    expect(formatFindingLocation("src/a.ts", null, null)).toBe("src/a.ts");
  });

  it("is absent when there is no path", () => {
    expect(formatFindingLocation(undefined, 1, 2)).toBeUndefined();
  });
});

describe("a finding that a learning shaped", () => {
  const context = {
    files: [{ filename: "src/a.ts", patch: "@@ -1,2 +1,3 @@\n context\n+const x = 1;\n" }],
  } as unknown as PRContext;

  const response = (learningsApplied?: unknown) =>
    JSON.stringify({
      summary: "ok",
      comments: [
        {
          path: "src/a.ts",
          line: 2,
          title: "Use the retry helper.",
          body: "Hand-rolled loop.",
          severity: "minor",
          ...(learningsApplied === undefined ? {} : { learningsApplied }),
        },
      ],
      approval: "COMMENT",
    });

  it("carries its provenance in the posted body", () => {
    const result = parseReviewResponse(response([1]), context, [LEARNING]);

    expect(result.comments[0].appliedLearnings?.map((l) => l.id)).toEqual(["l1"]);
    expect(result.comments[0].body).toContain("<summary>🧠 Learnings used</summary>");
    expect(result.comments[0].body).toContain("Learnt from: Ashex");
    expect(result.comments[0].body).toContain("File: cmd/relay/control.go:166-170");
  });

  it("renders the collapse after the fix, before the machine markers", () => {
    // What's wrong, then how to fix it, then why it was raised at all —
    // provenance is the question a reader asks only once they disagree.
    const body = parseReviewResponse(response([1]), context, [LEARNING]).comments[0].body;

    expect(body.indexOf("Hand-rolled loop.")).toBeLessThan(body.indexOf("🧠 Learnings used"));
    expect(body.indexOf("🧠 Learnings used")).toBeLessThan(body.indexOf("<!-- diffsentry-fingerprint"));
  });

  it("carries none when the model named none", () => {
    const comment = parseReviewResponse(response(), context, [LEARNING]).comments[0];

    expect(comment.appliedLearnings).toBeUndefined();
    expect(comment.body).not.toContain("🧠 Learnings used");
  });

  it("carries none when the review had no learnings to apply", () => {
    // A model that invents the field on a repo with an empty store must not
    // produce a block citing a learning that does not exist.
    const comment = parseReviewResponse(response([1]), context).comments[0];

    expect(comment.appliedLearnings).toBeUndefined();
    expect(comment.body).not.toContain("🧠 Learnings used");
  });
});

describe("the learnings store", () => {
  const withStore = async (fn: (store: LearningsStore) => Promise<void>) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ds-learnings-"));
    try {
      await fn(new LearningsStore(dir));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  it("records the conversation a learning came from", async () => {
    await withStore(async (store) => {
      const stored = await store.addLearning("acme/web", "Always X.", undefined, {
        author: "kim",
        prNumber: 17,
        sourceFile: "src/a.ts:12-14",
      });

      expect(stored).toMatchObject({ author: "kim", prNumber: 17, sourceFile: "src/a.ts:12-14" });
      expect(await store.getLearnings("acme/web")).toEqual([stored]);
    });
  });

  it("stores a learning with no origin exactly as it did before the fields existed", async () => {
    // Every learning already on disk has this shape. It must not gain a row of
    // nulls on the next write, and it must still round-trip.
    await withStore(async (store) => {
      const stored = await store.addLearning("acme/web", "Always X.");

      expect(Object.keys(stored).sort()).toEqual(["content", "createdAt", "id", "path", "repo"]);
      expect(renderLearningsUsed([stored])).not.toContain("Learnt from:");
    });
  });

  it("carries provenance across a promotion to global", async () => {
    // Widening a learning's scope is when it most needs to stay traceable: it
    // now speaks for every repo, answerable to the same one conversation.
    await withStore(async (store) => {
      const src = await store.addLearning("acme/web", "Never log tokens.", undefined, {
        author: "kim",
        prNumber: 17,
        sourceFile: "src/a.ts:12",
      });

      const promoted = await store.promoteToGlobal("acme/web", src.id);

      expect(promoted).toMatchObject({
        repo: GLOBAL_REPO,
        author: "kim",
        prNumber: 17,
        sourceFile: "src/a.ts:12",
        sourceRepo: "acme/web",
      });
      expect(renderLearningsUsed([promoted!])).toContain("Repo: acme/web PR: 17");
    });
  });
});
