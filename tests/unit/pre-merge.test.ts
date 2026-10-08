import { describe, it, expect } from "vitest";
import {
  buildCheckPrompt,
  parseCheckResponse,
  runPreMergeChecks,
  formatCheckResults,
  getOverallStatus,
  describePreMergeStatus,
} from "../../src/pre-merge.js";
import type { CheckResult, PRContext } from "../../src/types.js";

const ctx = { title: "feat(x): add thing", description: "Adds the thing because we need it." } as PRContext;

describe("parseCheckResponse", () => {
  it("reads all three outcomes", () => {
    expect(parseCheckResponse('{"outcome":"pass","message":"ok"}').outcome).toBe("passed");
    expect(parseCheckResponse('{"outcome":"fail","message":"bad"}').outcome).toBe("failed");
    expect(parseCheckResponse('```json\n{"outcome":"inconclusive","message":"?"}\n```').outcome).toBe("inconclusive");
  });

  it("still accepts the legacy {passed} shape", () => {
    expect(parseCheckResponse('{"passed":false,"message":"x"}')).toEqual({ outcome: "failed", message: "x" });
  });

  it("won't fail a check on a reply that gives no reason", () => {
    expect(parseCheckResponse('{"outcome":"fail","message":"  "}').outcome).toBe("inconclusive");
    expect(parseCheckResponse('{"passed":false}').outcome).toBe("inconclusive");
  });

  it("treats an unreadable answer as inconclusive, not a silent pass", () => {
    expect(parseCheckResponse("sure, looks fine").outcome).toBe("inconclusive");
  });
});

describe("buildCheckPrompt", () => {
  it("names the files the model cannot see", () => {
    const p = buildCheckPrompt("alembic", "check ids", ["migrations/versions/a.py", "migrations/versions/a.py"]);
    expect(p).toContain("`migrations/versions/a.py`");
    expect(p.match(/migrations\/versions\/a\.py/g)).toHaveLength(1);
    expect(p).toContain("inconclusive");
  });

  it("omits the scope note when everything is visible", () => {
    expect(buildCheckPrompt("x", "y")).not.toContain("NOT shown");
  });
});

describe("pre-merge status", () => {
  const r = (name: string, mode: "warning" | "error", outcome: CheckResult["outcome"]): CheckResult => ({
    name,
    mode,
    outcome,
    message: `${name} msg`,
  });

  it("does not fail on an inconclusive error-mode check (the PR #361 case)", () => {
    const results = [r("alembic", "error", "inconclusive"), r("debug", "error", "inconclusive"), r("title", "warning", "passed")];
    expect(getOverallStatus(results)).toBe("pass");
    expect(describePreMergeStatus(results)).toBe("No failures (2 couldn't be verified)");
  });

  it("fails on an evidenced error-mode failure and names it", () => {
    const results = [r("alembic", "error", "failed"), r("title", "warning", "failed")];
    expect(getOverallStatus(results)).toBe("fail");
    expect(describePreMergeStatus(results)).toBe("Failed: alembic");
  });

  it("names warnings without failing", () => {
    const results = [r("title", "warning", "failed"), r("desc", "warning", "passed")];
    expect(getOverallStatus(results)).toBe("warning");
    expect(describePreMergeStatus(results)).toBe("Passed with 1 warning: title");
  });

  it("keeps the description within GitHub's 140-char limit", () => {
    const results = Array.from({ length: 20 }, (_, i) => r(`a-rather-long-check-name-${i}`, "error", "failed"));
    expect(describePreMergeStatus(results).length).toBeLessThanOrEqual(140);
  });

  it("renders inconclusive checks apart from failures and escapes table cells", () => {
    const body = formatCheckResults([
      r("alembic", "error", "inconclusive"),
      { name: "title", mode: "warning", outcome: "failed", message: "a | b\nc" },
    ]);
    expect(body).toContain("🚥 Pre-merge checks | ✅ 0 | ❌ 1 | ⚪ 1");
    expect(body).toContain("Couldn't verify (1)");
    expect(body).toContain("| title | ⚠️ Warning | a \\| b c |");
  });

  it("escapes backslashes before pipes, and escapes check names too", () => {
    const body = formatCheckResults([{ name: "odd|name", mode: "error", outcome: "failed", message: "x \\| y" }]);
    // message `x \| y` → `x \\\| y`: escaped backslash, then escaped pipe.
    expect(body).toContain("| odd\\|name | ❌ Blocks merge | x \\\\\\| y |");
  });
});

describe("runPreMergeChecks", () => {
  it("emits nothing for title/description checks set to off, even on a WIP title", async () => {
    const results = await runPreMergeChecks(
      { title: "WIP", description: "" } as PRContext,
      { title: { mode: "off" }, description: { mode: "off" } },
      async () => ({ outcome: "failed", message: "should not run" }),
    );
    expect(results).toEqual([]);
  });

  it("passes the check name and maps outcomes onto results", async () => {
    const seen: string[] = [];
    const results = await runPreMergeChecks(
      ctx,
      {
        title: { mode: "warning", requirements: "conventional" },
        custom_checks: [
          { name: "a", mode: "error", instructions: "A" },
          { name: "off", mode: "off", instructions: "skip" },
        ],
      },
      async (name) => {
        seen.push(name);
        return { outcome: name === "a" ? "inconclusive" : "passed", message: "m" };
      },
    );
    expect(seen.sort()).toEqual(["PR Title", "a"]);
    expect(results.map((x) => [x.name, x.outcome])).toEqual([
      ["PR Title", "passed"],
      ["a", "inconclusive"],
    ]);
  });
});
