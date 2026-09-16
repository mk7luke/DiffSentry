import { describe, it, expect } from "vitest";
import { AI_DISCLOSURE, withAiDisclosure } from "../../src/github.js";
import { DIFFSENTRY_COMMENT_FOOTER } from "../../src/thread-severity.js";

describe("AI disclosure on conversational replies", () => {
  it("appends the disclosure to a plain prose reply", () => {
    expect(withAiDisclosure("Thanks — the new mutex preserves write ordering.")).toBe(
      `Thanks — the new mutex preserves write ordering.\n\n${AI_DISCLOSURE}`,
    );
  });

  it("keeps the auto-generated marker last", () => {
    const body = `Review triggered.\n\n${DIFFSENTRY_COMMENT_FOOTER}`;
    const out = withAiDisclosure(body);
    expect(out).toBe(`Review triggered.\n\n${AI_DISCLOSURE}\n\n${DIFFSENTRY_COMMENT_FOOTER}`);
    expect(out.indexOf(AI_DISCLOSURE)).toBeLessThan(out.indexOf(DIFFSENTRY_COMMENT_FOOTER));
  });

  it("never states the disclosure twice", () => {
    const once = withAiDisclosure("Answer.");
    expect(withAiDisclosure(once)).toBe(once);
    expect(once.split(AI_DISCLOSURE)).toHaveLength(2);
  });

  it("matches the captured wording and italic formatting", () => {
    expect(AI_DISCLOSURE).toBe("_You are interacting with an AI system._");
  });

  it("leaves an already-correctly-placed disclosure unchanged", () => {
    const body = `Thanks for the report.\n\n${AI_DISCLOSURE}`;
    expect(withAiDisclosure(body)).toBe(body);
  });

  it("leaves the disclosure unchanged when it already precedes the auto-generated marker", () => {
    const body = `Thanks for the report.\n\n${AI_DISCLOSURE}\n\n${DIFFSENTRY_COMMENT_FOOTER}`;
    expect(withAiDisclosure(body)).toBe(body);
  });

  it("still appends the real footer when the disclosure text is only quoted mid-body", () => {
    // Regression: `body.includes(AI_DISCLOSURE)` let any reply that merely
    // quotes or discusses the disclosure text suppress the real footer. Only a
    // trailing (or marker-preceding) disclosure counts as "already present".
    const body = `You said "${AI_DISCLOSURE}" earlier, but here's a follow-up answer.`;
    const out = withAiDisclosure(body);
    expect(out).toBe(`${body}\n\n${AI_DISCLOSURE}`);
    expect(out.split(AI_DISCLOSURE)).toHaveLength(3);
  });

  it("still appends the disclosure ahead of the marker when the text is only quoted mid-body", () => {
    const body = `Quoting the disclosure "${AI_DISCLOSURE}" for context.\n\n${DIFFSENTRY_COMMENT_FOOTER}`;
    const out = withAiDisclosure(body);
    expect(out.endsWith(`\n\n${AI_DISCLOSURE}\n\n${DIFFSENTRY_COMMENT_FOOTER}`)).toBe(true);
    expect(out.split(AI_DISCLOSURE)).toHaveLength(3);
  });
});
