import { describe, it, expect } from "vitest";
import { formatWalkthroughInner } from "../../src/walkthrough.js";
import { parseWalkthroughResponse } from "../../src/ai/parse.js";
import type { WalkthroughResult, WalkthroughConfig } from "../../src/types.js";

const CONFIG: WalkthroughConfig = { changed_files_summary: true };

function result(cohorts: WalkthroughResult["cohorts"]): WalkthroughResult {
  return { summary: "s", fileDescriptions: [], cohorts };
}

/** Every `|Layer / File(s)|Summary|` header line in the rendered walkthrough. */
function tableCount(md: string): number {
  return md.split("\n").filter((l) => l === "|Layer / File(s)|Summary|").length;
}

describe("themed changes tables", () => {
  it("uses the Layer header, not Cohort", () => {
    const md = formatWalkthroughInner(
      result([{ label: "Guard", files: ["src/a.ts"], summary: "Guarded." }]),
      CONFIG,
    );
    expect(md).toContain("|Layer / File(s)|Summary|");
    expect(md).not.toContain("Cohort / File(s)");
  });

  it("splits into one table per theme, each under a bold theme line", () => {
    const md = formatWalkthroughInner(
      result([
        { theme: "Ride timing", label: "Ticket contracts", files: ["a.ts"], summary: "A." },
        { theme: "Ride timing", label: "Recorder lifecycle", files: ["b.ts"], summary: "B." },
        { theme: "Storage tests", label: "S3 readiness", files: ["c.ts"], summary: "C." },
      ]),
      CONFIG,
    );
    expect(tableCount(md)).toBe(2);
    expect(md).toContain("**Ride timing**\n\n|Layer / File(s)|Summary|");
    expect(md).toContain("**Storage tests**\n\n|Layer / File(s)|Summary|");
    // Cohorts stay rows of their theme's table, as in the corpus.
    expect(md).toContain("|**Ticket contracts** <br> `a.ts`|A.|");
  });

  it("keeps the model's ordering rather than sorting themes", () => {
    const md = formatWalkthroughInner(
      result([
        { theme: "Zebra", label: "L1", files: ["a"], summary: "A." },
        { theme: "Alpha", label: "L2", files: ["b"], summary: "B." },
      ]),
      CONFIG,
    );
    expect(md.indexOf("**Zebra**")).toBeLessThan(md.indexOf("**Alpha**"));
  });

  it("emits one untitled table when no cohort carries a theme", () => {
    const md = formatWalkthroughInner(
      result([
        { label: "L1", files: ["a"], summary: "A." },
        { label: "L2", files: ["b"], summary: "B." },
      ]),
      CONFIG,
    );
    expect(tableCount(md)).toBe(1);
    expect(md).toContain("### Changes\n\n|Layer / File(s)|Summary|");
    expect(md).not.toContain("undefined");
  });

  it("drops a blank or non-string theme instead of rendering an empty heading", () => {
    const parsed = parseWalkthroughResponse(
      JSON.stringify({
        summary: "s",
        fileDescriptions: [],
        cohorts: [
          { theme: "   ", label: "L1", files: ["a"], summary: "A." },
          { theme: 7, label: "L2", files: ["b"], summary: "B." },
        ],
      }),
    );
    expect(parsed.cohorts?.[0].theme).toBeUndefined();
    expect(parsed.cohorts?.[1].theme).toBeUndefined();
    const md = formatWalkthroughInner(parsed, CONFIG);
    expect(tableCount(md)).toBe(1);
    expect(md).not.toContain("****");
  });

  it("bounds an over-long theme rather than rendering an essay as a heading", () => {
    const parsed = parseWalkthroughResponse(
      JSON.stringify({
        summary: "s",
        fileDescriptions: [],
        cohorts: [{ theme: "x".repeat(300), label: "L1", files: ["a"], summary: "A." }],
      }),
    );
    expect(parsed.cohorts?.[0].theme).toHaveLength(80);
  });

  it("demotes the Changes heading to ###", () => {
    const md = formatWalkthroughInner(
      result([{ label: "L", files: ["a"], summary: "A." }]),
      CONFIG,
    );
    expect(md.split("\n")).toContain("### Changes");
    expect(md.split("\n")).not.toContain("## Changes");
  });
});
