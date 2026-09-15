import { describe, it, expect } from "vitest";
import { buildReviewComment, renderInlineCommentBody } from "../../src/ai/parse.js";

/** The metadata header is the first line of a rendered finding. */
function header(body: string): string {
  return body.split("\n")[0];
}

describe("inline finding header", () => {
  it("renders four axes, widest context first", () => {
    const body = renderInlineCommentBody({
      body: "b",
      title: "Guard the nullable branch.",
      category: "functional_correctness",
      type: "issue",
      severity: "major",
      effort: "quick_win",
    });
    expect(header(body)).toBe(
      "_🎯 Functional Correctness_ | _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_",
    );
  });

  it("degrades to the old two-part header when both new axes are absent", () => {
    const body = renderInlineCommentBody({ body: "b", type: "issue", severity: "minor" });
    expect(header(body)).toBe("_⚠️ Potential issue_ | _🟡 Minor_");
  });

  it("drops just the missing axis rather than leaving a gap", () => {
    const only = renderInlineCommentBody({ body: "b", category: "security_privacy" });
    expect(header(only)).toBe("_🔒 Security & Privacy_");

    const noType = renderInlineCommentBody({
      body: "b",
      category: "maintainability",
      severity: "trivial",
      effort: "low_value",
    });
    expect(header(noType)).toBe(
      "_📐 Maintainability & Code Quality_ | _🔵 Trivial_ | _💤 Low value_",
    );
  });

  it("uses a blue dot for trivial, not a green one", () => {
    const body = renderInlineCommentBody({ body: "b", severity: "trivial" });
    expect(header(body)).toBe("_🔵 Trivial_");
    expect(body).not.toContain("🟢");
  });

  it("renders every category and effort value the corpus records", () => {
    const categories = {
      functional_correctness: "_🎯 Functional Correctness_",
      stability_availability: "_🩺 Stability & Availability_",
      security_privacy: "_🔒 Security & Privacy_",
      data_integrity: "_🗄️ Data Integrity & Integration_",
      performance_scalability: "_🚀 Performance & Scalability_",
      maintainability: "_📐 Maintainability & Code Quality_",
    } as const;
    for (const [value, rendered] of Object.entries(categories)) {
      const body = renderInlineCommentBody({ body: "b", category: value as never });
      expect(header(body)).toBe(rendered);
    }

    const efforts = {
      quick_win: "_⚡ Quick win_",
      heavy_lift: "_🏗️ Heavy lift_",
      low_value: "_💤 Low value_",
    } as const;
    for (const [value, rendered] of Object.entries(efforts)) {
      const body = renderInlineCommentBody({ body: "b", effort: value as never });
      expect(header(body)).toBe(rendered);
    }
  });
});

describe("parse: category and effort from model JSON", () => {
  const anchor = { path: "src/a.ts", line: 7, prLevel: false };

  it("keeps recognised values and renders them", () => {
    const c = buildReviewComment(
      {
        body: "b",
        title: "t",
        type: "security",
        severity: "critical",
        category: "security_privacy",
        effort: "heavy_lift",
      },
      anchor,
    );
    expect(c.category).toBe("security_privacy");
    expect(c.effort).toBe("heavy_lift");
    // The `security` type is dropped: it repeats the category's glyph and says
    // less than the category does.
    expect(header(c.body)).toBe("_🔒 Security & Privacy_ | _🔴 Critical_ | _🏗️ Heavy lift_");
  });

  it("keeps a security type when no category outranks it", () => {
    const c = buildReviewComment({ body: "b", title: "t", type: "security", severity: "critical" }, anchor);
    expect(header(c.body)).toBe("_🔒 Security_ | _🔴 Critical_");
  });

  it("keeps a non-colliding type alongside the security category", () => {
    const c = buildReviewComment(
      { body: "b", title: "t", type: "issue", severity: "major", category: "security_privacy", effort: "quick_win" },
      anchor,
    );
    expect(header(c.body)).toBe(
      "_🔒 Security & Privacy_ | _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_",
    );
  });

  it("drops values outside the enum instead of rendering them", () => {
    const c = buildReviewComment(
      { body: "b", title: "t", type: "issue", severity: "minor", category: "vibes", effort: "" },
      anchor,
    );
    expect(c.category).toBeUndefined();
    expect(c.effort).toBeUndefined();
    expect(header(c.body)).toBe("_⚠️ Potential issue_ | _🟡 Minor_");
    expect(c.body).not.toContain("undefined");
    expect(c.body).not.toContain("vibes");
  });

  it("degrades gracefully when a model omits the axes entirely", () => {
    const c = buildReviewComment({ body: "b", title: "t", type: "nitpick", severity: "trivial" }, anchor);
    expect(header(c.body)).toBe("_🧹 Nitpick_ | _🔵 Trivial_");
    expect(c.body).not.toContain("undefined");
  });
});
