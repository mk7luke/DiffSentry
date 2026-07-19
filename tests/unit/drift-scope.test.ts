import { describe, it, expect } from "vitest";
import { detectDescriptionDrift } from "../../src/drift.js";
import { partitionFilesForReview } from "../../src/reviewer.js";
import type { AIProvider, FileChange, PRContext } from "../../src/types.js";

// Regression coverage for the "Description claims X with no matching diff"
// false-positive class. The check compares prose describing the WHOLE PR
// against whatever diff it is handed, so any file missing from the prompt
// reads as an unsupported claim. Two ways a file goes missing:
//   1. incremental review trims files unchanged since the last review
//   2. config ignores / the file cap / the size budget drop them
// Both produced confident, wrong Major findings. See mk7luke/agent-tui#1,
// where 6 of 6 PR-level findings named files that were in the PR all along.

function file(filename: string): FileChange {
  return {
    filename,
    status: "modified",
    patch: `@@ -1,2 +1,3 @@\n context\n+changed ${filename}\n`,
    additions: 1,
    deletions: 0,
  };
}

function ctx(files: FileChange[]): PRContext {
  return {
    owner: "o",
    repo: "r",
    pullNumber: 1,
    title: "Make it build on Windows",
    description:
      "Adds a windows-x86_64 DotSlash entry, appends -C symbol-mangling-version=v0 to " +
      ".cargo/config.toml, and raises the main-thread stack via /STACK:8388608 in build.rs.",
    baseBranch: "main",
    headBranch: "feat",
    headSha: "deadbee",
    files,
  };
}

/** Captures the prompt drift sends so we can assert on what the model sees. */
function recordingAI(): { ai: AIProvider; prompts: string[]; contexts: PRContext[] } {
  const prompts: string[] = [];
  const contexts: PRContext[] = [];
  const ai = {
    chat: async (context: PRContext, message: string) => {
      contexts.push(context);
      prompts.push(message);
      return "[]";
    },
  } as unknown as AIProvider;
  return { ai, prompts, contexts };
}

describe("description drift — diff scope", () => {
  it("sees every file in the PR, not just the incrementally-changed one", async () => {
    // What reviewer.ts now passes: the full reviewable set, even though only
    // lib.rs changed since the last review.
    const all = [file(".cargo/config.toml"), file("build.rs"), file("lib.rs")];
    const { ai, contexts } = recordingAI();

    await detectDescriptionDrift({ ai, context: ctx(all) });

    const seen = contexts[0].files.map((f) => f.filename);
    expect(seen).toEqual([".cargo/config.toml", "build.rs", "lib.rs"]);
  });

  it("tells the model which PR files it cannot see, so absence isn't read as evidence", async () => {
    const { ai, prompts } = recordingAI();

    await detectDescriptionDrift({
      ai,
      context: ctx([file("lib.rs")]),
      unavailableFiles: ["bin/protoc", ".cargo/config.toml"],
    });

    const prompt = prompts[0];
    expect(prompt).toContain("bin/protoc");
    expect(prompt).toContain(".cargo/config.toml");
    expect(prompt).toContain("Do NOT report drift about them");
  });

  it("adds no scope note when the full diff is present", async () => {
    const { ai, prompts } = recordingAI();

    await detectDescriptionDrift({ ai, context: ctx([file("lib.rs")]) });

    expect(prompts[0]).not.toContain("Do NOT report drift about them");
  });

  it("preserves the full file set across the incremental trim", () => {
    // The bug: on a synchronize push only the newest file differs from prior
    // state, so filesToReview collapses to it. allFiles must still carry the
    // whole PR, which is what the drift call site consumes.
    const files = [file(".cargo/config.toml"), file("build.rs"), file("lib.rs")];
    const priorShas: Record<string, string> = {};
    // Simulate "already reviewed" for the two older files by round-tripping
    // their hashes through a full-mode partition.
    const first = partitionFilesForReview(files, "full", undefined);
    priorShas[".cargo/config.toml"] = first.currentFileShas[".cargo/config.toml"];
    priorShas["build.rs"] = first.currentFileShas["build.rs"];

    const result = partitionFilesForReview(files, "incremental", priorShas);

    expect(result.filesToReview.map((f) => f.filename)).toEqual(["lib.rs"]);
    expect(result.filesSkippedSimilar).toEqual([".cargo/config.toml", "build.rs"]);
    // The invariant that keeps drift honest.
    expect(result.allFiles.map((f) => f.filename)).toEqual([
      ".cargo/config.toml",
      "build.rs",
      "lib.rs",
    ]);
  });

  it("deduplicates unavailable filenames", async () => {
    const { ai, prompts } = recordingAI();

    // ignoredFiles and the budget's omitted list can name the same file.
    await detectDescriptionDrift({
      ai,
      context: ctx([file("lib.rs")]),
      unavailableFiles: ["vendor/big.rs", "vendor/big.rs"],
    });

    expect(prompts[0].match(/vendor\/big\.rs/g)).toHaveLength(1);
  });
});
