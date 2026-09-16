import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { addressedCommitRange, renderAddressedNote, stampRaisedShas } from "../../src/addressed-commits.js";

const COMMITS = ["aaaaaaa1111", "bbbbbbb2222", "ccccccc3333", "ddddddd4444"];

describe("addressedCommitRange", () => {
  it("spans the commits that landed after the finding was raised", () => {
    expect(addressedCommitRange("aaaaaaa1111", COMMITS)).toEqual({
      from: "bbbbbbb2222",
      to: "ddddddd4444",
    });
  });

  it("collapses to a single commit when only one landed", () => {
    expect(addressedCommitRange("ccccccc3333", COMMITS)).toEqual({
      from: "ddddddd4444",
      to: "ddddddd4444",
    });
  });

  it("matches on the abbreviated SHA in either direction", () => {
    // State may hold a full SHA while the commit list is abbreviated, or the
    // reverse, depending on which API wrote each one.
    expect(addressedCommitRange("aaaaaaa", COMMITS)?.from).toBe("bbbbbbb2222");
    expect(addressedCommitRange("aaaaaaa1111", ["aaaaaaa", "bbbbbbb2222"])?.from).toBe("bbbbbbb2222");
  });

  it("names nothing when the raised SHA is still the head", () => {
    // Something other than a commit is closing this thread. Claiming a commit
    // addressed it would be a straight falsehood.
    expect(addressedCommitRange("ddddddd4444", COMMITS)).toBeNull();
  });

  it("names nothing when the raised SHA is no longer in the PR", () => {
    // A force-push or rebase rewrote the history the finding was raised
    // against, so every SHA we could name is one the reader cannot diff.
    expect(addressedCommitRange("eeeeeee5555", COMMITS)).toBeNull();
  });

  it("names nothing when the finding carries no raised SHA", () => {
    // A thread posted before findingShas existed. Silence, not a guess.
    expect(addressedCommitRange(undefined, COMMITS)).toBeNull();
    expect(addressedCommitRange("", COMMITS)).toBeNull();
  });

  it("names nothing on a PR with no commits", () => {
    expect(addressedCommitRange("aaaaaaa1111", [])).toBeNull();
  });
});

describe("stampRaisedShas", () => {
  it("dates a newly posted finding at the current head", () => {
    expect(stampRaisedShas(undefined, ["aaa", "bbb"], "head111")).toEqual({
      aaa: "head111",
      bbb: "head111",
    });
  });

  it("keeps the first raise when a finding is repeated on a later push", () => {
    // The commits that addressed a finding are the ones after it was first
    // said. Re-dating it on every echo would shrink the range to nothing.
    expect(stampRaisedShas({ aaa: "first00" }, ["aaa", "bbb"], "head111")).toEqual({
      aaa: "first00",
      bbb: "head111",
    });
  });

  it("drops entries for fingerprints that are no longer posted", () => {
    // The map lives inside a gzipped blob in a GitHub comment. Rebuilt from the
    // live list rather than merged, so it tracks that list instead of growing
    // beside it for the life of the PR.
    expect(stampRaisedShas({ aaa: "first00", gone: "old0000" }, ["aaa"], "head111")).toEqual({
      aaa: "first00",
    });
  });

  it("is empty when nothing has been posted", () => {
    expect(stampRaisedShas({ gone: "old0000" }, [], "head111")).toEqual({});
  });
});

describe("renderAddressedNote", () => {
  it("abbreviates both SHAs to seven characters", () => {
    expect(renderAddressedNote({ from: "bbbbbbb2222", to: "ddddddd4444" })).toBe(
      "✅ Addressed in commits bbbbbbb to ddddddd",
    );
  });

  it("uses the singular form for a single commit", () => {
    expect(renderAddressedNote({ from: "ddddddd4444", to: "ddddddd4444" })).toBe(
      "✅ Addressed in commit ddddddd",
    );
  });
});

/**
 * Both forms are transcribed from captured CodeRabbit output rather than
 * designed here. If the rendered text ever drifts from what the corpus records,
 * the row this implements (gap-backlog A9) stops being satisfied — so assert
 * against the corpus itself, not against a second copy of the string.
 *
 * Note the counts: the backlog row's headline is the range form, but the
 * singular form is the more common of the two in both captures.
 */
describe("against the captured corpus", () => {
  const corpus = ["tests/e2e/reference/2026-09/coderabbit/inline.md", "tests/e2e/reference/coderabbit-inline-comments.md"]
    .map((p) => fs.readFileSync(path.join(process.cwd(), p), "utf8"))
    .join("\n");

  it("renders a range exactly as CodeRabbit does", () => {
    const captured = corpus.match(/^✅ Addressed in commits [0-9a-f]{7} to [0-9a-f]{7}$/m);
    expect(captured).not.toBeNull();

    const [, from, to] = captured![0].match(/commits ([0-9a-f]{7}) to ([0-9a-f]{7})/)!;
    expect(renderAddressedNote({ from, to })).toBe(captured![0]);
  });

  it("renders a single commit exactly as CodeRabbit does", () => {
    const captured = corpus.match(/^✅ Addressed in commit [0-9a-f]{7}$/m);
    expect(captured).not.toBeNull();

    const [, sha] = captured![0].match(/commit ([0-9a-f]{7})/)!;
    expect(renderAddressedNote({ from: sha, to: sha })).toBe(captured![0]);
  });

  it("emits no third form the corpus does not contain", () => {
    const forms = new Set(
      (corpus.match(/^✅ Addressed in .*$/gm) ?? []).map((l) => l.replace(/[0-9a-f]{7,40}/g, "<sha>")),
    );
    expect([...forms].sort()).toEqual([
      "✅ Addressed in commit <sha>",
      "✅ Addressed in commits <sha> to <sha>",
    ]);
  });
});
