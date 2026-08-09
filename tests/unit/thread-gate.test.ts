import { describe, it, expect } from "vitest";
import { countBlockingThreads } from "../../src/github.js";
import { renderSeverityMarker } from "../../src/thread-severity.js";

const BOT = "diffsentry[bot]";

/** Shape of the GraphQL node `fetchAllReviewThreads` returns. */
function thread(over: {
  isResolved?: boolean;
  severity?: "critical" | "major" | "minor" | "trivial";
  marker?: boolean;
  author?: { login: string; __typename: string };
}) {
  const marker = over.marker === false || !over.severity ? "" : `\n\n${renderSeverityMarker(over.severity!)}`;
  return {
    id: "T",
    isResolved: over.isResolved ?? false,
    path: "src/a.ts",
    comments: {
      nodes: [
        {
          body: `A finding.${marker}`,
          author: over.author ?? { login: "diffsentry[bot]", __typename: "Bot" },
        },
      ],
    },
  };
}

describe("countBlockingThreads", () => {
  it("counts unresolved critical and major threads", () => {
    expect(countBlockingThreads([thread({ severity: "critical" }), thread({ severity: "major" })], BOT)).toBe(2);
  });

  it("ignores unresolved minor and trivial threads", () => {
    expect(countBlockingThreads([thread({ severity: "minor" }), thread({ severity: "trivial" })], BOT)).toBe(0);
  });

  it("ignores resolved threads regardless of severity", () => {
    expect(countBlockingThreads([thread({ severity: "critical", isResolved: true })], BOT)).toBe(0);
  });

  it("counts an unresolved thread with no marker as blocking", () => {
    // Every thread posted before this shipped. Fail-safe by design.
    expect(countBlockingThreads([thread({ marker: false })], BOT)).toBe(1);
  });

  it("ignores threads a human opened", () => {
    const human = thread({ author: { login: "mk7luke", __typename: "User" } });
    expect(countBlockingThreads([human], BOT)).toBe(0);
  });

  it("is zero for an empty thread list", () => {
    expect(countBlockingThreads([], BOT)).toBe(0);
  });

  it("tolerates a thread with no comments", () => {
    expect(countBlockingThreads([{ id: "T", isResolved: false, comments: { nodes: [] } }], BOT)).toBe(0);
  });
});
