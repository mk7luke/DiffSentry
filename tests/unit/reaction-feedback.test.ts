import { describe, it, expect, vi, beforeEach } from "vitest";

const bulkTriageFindings = vi.fn().mockReturnValue(1);
const recordEvent = vi.fn();

vi.mock("../../src/storage/dao.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/storage/dao.js")>();
  return {
    ...actual,
    getFindingIdsByFingerprint: (fp: string) => (fp === "deadbeef" || fp === "cafe1234" ? [1, 2] : []),
    bulkTriageFindings: (...args: unknown[]) => bulkTriageFindings(...args),
    recordEvent: (...args: unknown[]) => recordEvent(...args),
  };
});

const { applyReactionFeedback } = await import("../../src/feedback.js");

const base = { owner: "acme", repo: "app", number: 7, botName: "diffsentry" };

beforeEach(() => {
  bulkTriageFindings.mockClear();
  recordEvent.mockClear();
});

describe("reaction feedback", () => {
  it("dismisses the fingerprint a maintainer thumbed down", () => {
    const out = applyReactionFeedback({
      ...base,
      threads: [{ fingerprint: "deadbeef", path: "src/a.ts", down: ["luke"], up: [] }],
    });
    expect([...out.dismissed]).toEqual(["deadbeef"]);
    expect(out.affirmed.size).toBe(0);
    expect(bulkTriageFindings).toHaveBeenCalledTimes(1);
    expect(bulkTriageFindings.mock.calls[0][0]).toMatchObject({ ids: [1, 2], accepted: false, triagedBy: "luke" });
    expect(recordEvent).toHaveBeenCalledTimes(1);
  });

  it("accepts the fingerprint a maintainer thumbed up", () => {
    const out = applyReactionFeedback({
      ...base,
      threads: [{ fingerprint: "deadbeef", path: "src/a.ts", down: [], up: ["luke"] }],
    });
    expect([...out.affirmed]).toEqual(["deadbeef"]);
    expect(out.dismissed.size).toBe(0);
    expect(bulkTriageFindings.mock.calls[0][0]).toMatchObject({ accepted: true });
  });

  // Two maintainers disagreeing is not a mandate. Picking a side here would
  // retire a whole finding class on a coin flip.
  it("leaves a thread carrying both reactions untouched", () => {
    const out = applyReactionFeedback({
      ...base,
      threads: [{ fingerprint: "deadbeef", path: "src/a.ts", down: ["luke"], up: ["sam"] }],
    });
    expect(out.dismissed.size).toBe(0);
    expect(out.affirmed.size).toBe(0);
    expect(bulkTriageFindings).not.toHaveBeenCalled();
  });

  // Same disagreement, spread across two threads on the same finding class.
  it("cancels a fingerprint that two threads disagree about", () => {
    const out = applyReactionFeedback({
      ...base,
      threads: [
        { fingerprint: "deadbeef", path: "src/a.ts", down: ["luke"], up: [] },
        { fingerprint: "deadbeef", path: "src/b.ts", down: [], up: ["sam"] },
      ],
    });
    expect(out.dismissed.size).toBe(0);
    expect(out.affirmed.size).toBe(0);
    expect(bulkTriageFindings).not.toHaveBeenCalled();
  });

  // GraphQL spells our own login `diffsentry`, REST spells it `diffsentry[bot]`.
  // Either way it is us, and our own reaction is not feedback.
  it("ignores our own reactions in both login spellings", () => {
    const out = applyReactionFeedback({
      ...base,
      threads: [
        { fingerprint: "deadbeef", path: "src/a.ts", down: ["diffsentry"], up: [] },
        { fingerprint: "cafe1234", path: "src/b.ts", down: ["DiffSentry[bot]"], up: [] },
      ],
    });
    expect(out.dismissed.size).toBe(0);
    expect(bulkTriageFindings).not.toHaveBeenCalled();
  });

  it("records no event when no finding row matched the fingerprint", () => {
    const out = applyReactionFeedback({
      ...base,
      threads: [{ fingerprint: "0000ffff", path: "src/a.ts", down: ["luke"], up: [] }],
    });
    expect([...out.dismissed]).toEqual(["0000ffff"]);
    expect(bulkTriageFindings).not.toHaveBeenCalled();
    expect(recordEvent).not.toHaveBeenCalled();
  });
});
