import { describe, it, expect } from "vitest";
import { countBlockingThreads } from "../../src/github.js";
import { renderSeverityMarker, DIFFSENTRY_COMMENT_FOOTER } from "../../src/thread-severity.js";

const BOT = "diffsentry[bot]";

/**
 * Shape of the GraphQL node `fetchAllReviewThreads` returns.
 *
 * The default author login is deliberately the bare `diffsentry`: GraphQL's
 * `Bot` node reports a login WITHOUT the `[bot]` suffix, while REST reports it
 * with one. These fixtures used to carry the REST shape, which made the whole
 * suite pass against data GitHub's GraphQL API never returns — and hid the fact
 * that `isOurBotThread` matched nothing in production, so the gate counted zero
 * blocking findings on every PR it has ever run on.
 */
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
          author: over.author ?? { login: "diffsentry", __typename: "Bot" },
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
    // A Copilot/Sonar review comment. Neither our login nor our footer, so it
    // isn't ours, and must not red the DiffSentry check.
    const other = thread({
      marker: false,
      footer: false,
      author: { login: "copilot-pull-request-reviewer", __typename: "Bot" },
    });
    expect(countBlockingThreads([other], BOT)).toBe(0);
  });

  it("ignores another vendor's bot even when its body carries a severity marker", () => {
    // Nothing stops a third-party bot quoting our marker, or emitting a
    // colliding one of its own. Authorship decides, not the body.
    const other = thread({
      severity: "critical",
      footer: false,
      author: { login: "sonarqubecloud", __typename: "Bot" },
    });
    expect(countBlockingThreads([other], BOT)).toBe(0);
  });

  // The two ways a thread is claimed as ours are tested apart on purpose. Every
  // real DiffSentry comment satisfies both, so a fixture carrying the footer
  // passes on the footer alone — which is how a first draft of these tests went
  // green against the very login bug they were written to pin.
  it("matches our bot on the bare GraphQL login, with no footer to fall back on", () => {
    // The reported bug: GraphQL says `diffsentry`, the caller passes
    // `diffsentry[bot]`, and every DiffSentry thread read as somebody else's.
    expect(countBlockingThreads([thread({ severity: "major", footer: false })], BOT)).toBe(1);
    expect(
      countBlockingThreads(
        [thread({ severity: "major", footer: false, author: { login: "DiffSentry", __typename: "Bot" } })],
        BOT,
      ),
    ).toBe(1);
    // And still matches if GitHub ever hands back the suffixed form.
    expect(
      countBlockingThreads(
        [thread({ severity: "major", footer: false, author: { login: "diffsentry[bot]", __typename: "Bot" } })],
        BOT,
      ),
    ).toBe(1);
  });

  it("normalises a BOT_NAME that already carries the suffix", () => {
    // Callers build the expected login as `${botName}[bot]`, so this one
    // arrives as `diffsentry[bot][bot]`. Both sides have to fold to the same
    // bare name or the login match is dead again.
    expect(
      countBlockingThreads([thread({ severity: "major", footer: false })], "diffsentry[bot][bot]"),
    ).toBe(1);
  });

  it("does not collapse a bot name whose interior contains [bot]", () => {
    // Stripping every occurrence rather than the trailing run folds
    // `acme[bot]-review[bot]` onto an unrelated `acme-review`. A login match
    // short-circuits the footer check, so that would hand another vendor's
    // thread the power to red our check.
    const other = thread({
      severity: "critical",
      footer: false,
      author: { login: "acme-review", __typename: "Bot" },
    });
    expect(countBlockingThreads([other], "acme[bot]-review[bot]")).toBe(0);
  });

  it("claims a thread from a deployment running under a different bot name", () => {
    // BOT_NAME is configurable, so the same PR can carry threads from an older
    // deployment under another login. Our footer is the authoritative signal —
    // the only one available once the login no longer matches.
    const legacy = thread({ severity: "critical", author: { login: "diffsentry-staging", __typename: "Bot" } });
    expect(countBlockingThreads([legacy], BOT)).toBe(1);
  });

  it("ignores threads a human opened", () => {
    const human = thread({ author: { login: "mk7luke", __typename: "User" } });
    expect(countBlockingThreads([human], BOT)).toBe(0);
  });

  it("ignores a human thread even when it quotes our footer", () => {
    // Quoting a DiffSentry comment in a reply must not turn a human thread into
    // a merge gate — `__typename` decides authorship before the body is read.
    const human = thread({ severity: "critical", author: { login: "mk7luke", __typename: "User" } });
    expect(countBlockingThreads([human], BOT)).toBe(0);
  });

  it("is zero for an empty thread list", () => {
    expect(countBlockingThreads([], BOT)).toBe(0);
  });

  it("tolerates a thread with no comments", () => {
    expect(countBlockingThreads([{ id: "T", isResolved: false, comments: { nodes: [] } }], BOT)).toBe(0);
  });
});
