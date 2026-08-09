import { describe, it, expect } from "vitest";
import { countBlockingThreads } from "../../src/github.js";
import { renderSeverityMarker, DIFFSENTRY_COMMENT_FOOTER } from "../../src/thread-severity.js";

const BOT = "diffsentry[bot]";

/** Shape of the GraphQL node `fetchAllReviewThreads` returns. */
function thread(over: {
  isResolved?: boolean;
  severity?: "critical" | "major" | "minor" | "trivial";
  marker?: boolean;
  /** Omit DiffSentry's footer, i.e. a comment from some other bot. */
  footer?: boolean;
  author?: { login: string; __typename: string };
}) {
  const marker = over.marker === false || !over.severity ? "" : `\n\n${renderSeverityMarker(over.severity!)}`;
  const footer = over.footer === false ? "" : `\n\n${DIFFSENTRY_COMMENT_FOOTER}`;
  return {
    id: "T",
    isResolved: over.isResolved ?? false,
    path: "src/a.ts",
    comments: {
      nodes: [
        {
          body: `A finding.${marker}${footer}`,
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

  it("counts an unresolved DiffSentry thread with no marker as blocking", () => {
    // Every thread posted before this shipped. Fail-safe by design — recognised
    // as ours by the footer, which predates the severity marker.
    expect(countBlockingThreads([thread({ marker: false })], BOT)).toBe(1);
  });

  it("ignores an unreadable thread from another vendor's bot", () => {
    // isOurBotThread matches any *[bot] login, so a Copilot/Sonar review comment
    // reaches here. Without a severity marker OR our footer it isn't ours, and
    // must not red the DiffSentry check.
    expect(countBlockingThreads([thread({ marker: false, footer: false })], BOT)).toBe(0);
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
