import { describe, it, expect } from "vitest";
import { buildWalkthroughPrompt } from "../../src/ai/prompt.js";
import type { PRContext } from "../../src/types.js";

const CONTEXT: PRContext = {
  owner: "mk7luke",
  repo: "DiffSentry",
  pullNumber: 1,
  title: "Sanitize rendered markdown",
  description: "Replaces the regex filter with an allowlist.",
  baseBranch: "main",
  headBranch: "fix/sanitize",
  headSha: "abc1234",
  files: [
    { filename: "src/a.ts", status: "modified", patch: "@@ -1 +1 @@\n-a\n+b", additions: 1, deletions: 1 },
  ],
} as never;

function system(): string {
  return buildWalkthroughPrompt(CONTEXT).system;
}

describe("walkthrough prompt fields", () => {
  it("asks for the changeType enum and names all three values", () => {
    const s = system();
    expect(s).toContain('"changeType"');
    expect(s).toContain('"bug_fix"');
    expect(s).toContain('"feature"');
    expect(s).toContain('"other"');
    expect(s).toContain("do not invent a fourth value");
  });

  it("does not ask for a priority axis", () => {
    expect(system().toLowerCase()).not.toContain('"priority"');
  });

  it("asks for a cohort theme and says cohorts sharing one render as one table", () => {
    const s = system();
    expect(s).toContain('"theme"');
    expect(s).toContain("rendered as one table");
  });

  // A16: the corpus bound, not an invented one. CodeRabbit's 7 captured
  // diagrams never exceed 5 participants or 64 characters of participant
  // names; DiffSentry's widest carries 6 participants and 101 characters,
  // which is the diagram cut off in
  // tests/e2e/reference/2026-09/screenshots/diffsentry/walkthrough-expanded.png.
  it("bounds sequence diagrams by participant count and name budget", () => {
    const s = system();
    expect(s).toContain("AT MOST 5 participants");
    expect(s).toContain("AT MOST 64 characters");
  });

  it("keeps the semicolon rule that stops Mermaid failing to render", () => {
    expect(system()).toContain("Do NOT put semicolons");
  });
});
