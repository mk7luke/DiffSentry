import { describe, it, expect } from "vitest";
import { formatReviewBody, isQuietOverflow } from "../../src/review-body.js";
import { PROFILES, isProfile } from "../../src/settings/overrides.js";
import { REPO_CONFIG_SCHEMA } from "../../src/config-schema.js";
import type { ReviewComment, ReviewResult } from "../../src/types.js";

const META = {
  profile: "quiet",
  owner: "o",
  repo: "r",
  headSha: "deadbee",
  baseBranch: "main",
  headBranch: "feat",
  filesProcessed: ["src/a.ts"],
  botName: "diffsentry",
};

function comment(over: Partial<ReviewComment> = {}): ReviewComment {
  return {
    path: "src/a.ts",
    line: 2,
    side: "RIGHT",
    body: "_🟡 Minor_\n\n**A finding.**\n\nProse.",
    title: "A finding.",
    severity: "minor",
    ...over,
  };
}

function result(comments: ReviewComment[]): ReviewResult {
  return { summary: "s", comments, approval: "COMMENT" };
}

describe("quiet is a first-class profile everywhere it is enumerated", () => {
  it("is in PROFILES and accepted by the shared guard", () => {
    expect(PROFILES).toContain("quiet");
    expect(isProfile("quiet")).toBe(true);
    expect(isProfile("chill")).toBe(true);
    expect(isProfile("assertive")).toBe(true);
    expect(isProfile("loud")).toBe(false);
    expect(isProfile(undefined)).toBe(false);
  });

  // The failure mode #168 fixed: a config key the schema accepts and no code
  // reads. Tie the two enumerations together so they cannot drift apart.
  it("the config schema enum and PROFILES agree", () => {
    const schemaEnum =
      REPO_CONFIG_SCHEMA.properties?.reviews?.properties?.profile?.enum ?? [];
    expect([...schemaEnum].sort()).toEqual([...PROFILES].sort());
  });
});

describe("isQuietOverflow", () => {
  it("keeps critical and major findings in the inline stream", () => {
    expect(isQuietOverflow(comment({ severity: "critical" }))).toBe(false);
    expect(isQuietOverflow(comment({ severity: "major" }))).toBe(false);
  });

  it("holds back minor, trivial and unrated findings", () => {
    expect(isQuietOverflow(comment({ severity: "minor" }))).toBe(true);
    expect(isQuietOverflow(comment({ severity: "trivial" }))).toBe(true);
    expect(isQuietOverflow(comment({ severity: undefined }))).toBe(true);
  });

  // Stricter than isNitpick on purpose: quiet is a promise about what will
  // interrupt you in the file view, and a major refactor suggestion interrupts.
  it("keeps a major finding inline even when its type is a nitpick bucket", () => {
    expect(isQuietOverflow(comment({ severity: "major", type: "suggestion" }))).toBe(false);
  });

  it("exempts findings that have no inline thread to withhold", () => {
    expect(isQuietOverflow(comment({ line: 0, prLevel: true, severity: "minor" }))).toBe(false);
  });
});

describe("the 🟡 Other comments bucket", () => {
  it("groups withheld findings under the quiet-mode note", () => {
    const body = formatReviewBody(
      result([
        comment({ severity: "critical", title: "A blocker.", line: 2 }),
        comment({ severity: "minor", title: "A small thing.", line: 3, quietOverflow: true }),
        comment({ severity: "trivial", title: "A tiny thing.", line: 4, quietOverflow: true }),
      ]),
      META,
    );

    expect(body).toContain("> [!NOTE]");
    expect(body).toContain(
      "> Quiet mode is enabled, so only the most important comments were posted inline. Other review comments are grouped below.",
    );
    expect(body).toContain("<summary>🟡 Other comments (2)</summary><blockquote>");
    expect(body).toContain("A small thing.");
    expect(body).toContain("A tiny thing.");
  });

  // Withheld findings are never posted inline, so listing them in the nitpick
  // collapse as well would print each one twice in the same body.
  it("does not also list withheld findings in the nitpick collapse", () => {
    const body = formatReviewBody(
      result([comment({ severity: "minor", title: "A small thing.", quietOverflow: true })]),
      META,
    );
    expect(body).toContain("🟡 Other comments (1)");
    expect(body).not.toContain("🧹 Nitpick comments");
  });

  it("stays out of the body entirely when nothing was withheld", () => {
    const body = formatReviewBody(result([comment({ severity: "critical" })]), META);
    expect(body).not.toContain("Quiet mode is enabled");
    expect(body).not.toContain("🟡 Other comments");
  });

  // A withheld finding is grouped, not dropped: it still counts toward the
  // header, or a quiet review would read as a review that found less.
  it("still counts a withheld actionable finding in the posted count", () => {
    const body = formatReviewBody(
      result([comment({ severity: "critical", quietOverflow: false })]),
      META,
    );
    expect(body).toContain("**Actionable comments posted: 1**");
  });
});
