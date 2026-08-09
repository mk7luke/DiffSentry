import { describe, it, expect } from "vitest";
import {
  renderSeverityMarker,
  parseThreadSeverity,
  isBlockingSeverity,
  VALID_SEVERITIES,
} from "../../src/thread-severity.js";
import { renderInlineCommentBody } from "../../src/ai/parse.js";

describe("renderSeverityMarker", () => {
  it("renders an HTML comment that survives markdown rendering", () => {
    expect(renderSeverityMarker("critical")).toBe("<!-- diffsentry-severity:critical -->");
  });
});

describe("parseThreadSeverity", () => {
  it("round-trips every severity", () => {
    for (const sev of VALID_SEVERITIES) {
      expect(parseThreadSeverity(`some finding\n\n${renderSeverityMarker(sev)}`)).toBe(sev);
    }
  });

  it("returns undefined when the marker is absent", () => {
    // Every thread posted before this shipped looks like this.
    expect(parseThreadSeverity("a finding with no marker")).toBeUndefined();
  });

  it("returns undefined for an unrecognised severity", () => {
    expect(parseThreadSeverity("<!-- diffsentry-severity:catastrophic -->")).toBeUndefined();
  });

  it("returns undefined for an empty body", () => {
    expect(parseThreadSeverity("")).toBeUndefined();
  });

  it("takes the last marker when several are present", () => {
    // A finding whose prose quotes an earlier marker must not win over the
    // real one, which formatCommentBody always appends at the end.
    const body = "quoting <!-- diffsentry-severity:trivial -->\n\n<!-- diffsentry-severity:critical -->";
    expect(parseThreadSeverity(body)).toBe("critical");
  });

  it("tolerates whitespace variation inside the marker", () => {
    expect(parseThreadSeverity("<!--diffsentry-severity:major-->")).toBe("major");
    expect(parseThreadSeverity("<!--   diffsentry-severity:major   -->")).toBe("major");
  });
});

describe("isBlockingSeverity", () => {
  it("blocks on critical and major", () => {
    expect(isBlockingSeverity("critical")).toBe(true);
    expect(isBlockingSeverity("major")).toBe(true);
  });

  it("does not block on minor and trivial", () => {
    expect(isBlockingSeverity("minor")).toBe(false);
    expect(isBlockingSeverity("trivial")).toBe(false);
  });

  it("blocks on unknown severity", () => {
    // Fail-safe: a thread DiffSentry cannot read must not silently go green.
    expect(isBlockingSeverity(undefined)).toBe(true);
  });
});

describe("renderInlineCommentBody integration", () => {
  it("stamps a marker that parseThreadSeverity reads back", () => {
    const body = renderInlineCommentBody({
      title: "Null deref",
      body: "Null deref here.",
      severity: "critical",
      fingerprint: "abc123",
    });
    expect(parseThreadSeverity(body)).toBe("critical");
  });

  it("omits the marker when the finding has no severity", () => {
    const body = renderInlineCommentBody({ title: "FYI", body: "Just a note." });
    expect(parseThreadSeverity(body)).toBeUndefined();
  });
});
