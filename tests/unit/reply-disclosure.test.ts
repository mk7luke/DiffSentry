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
});
