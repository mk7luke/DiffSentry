import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyTemplatePath, loadPrSeries, validatePrSeries, type PrDef } from "../../src/parity/fixture.js";
import { findPr } from "../../scripts/fixture-open-pr.js";

function def(over: Partial<PrDef> = {}): PrDef {
  return { dir: "01-a", title: "feat: a", body: "why", base: "main", branch: "feat/a", expects: ["walkthrough"], ...over };
}

const REAL_PR_SERIES_ROOT = "tests/e2e/reference/2026-09/fixture-repo/pr-series";

describe("validatePrSeries", () => {
  it("accepts a well-formed series", () => {
    expect(validatePrSeries([def(), def({ dir: "02-b", branch: "fix/b" })])).toEqual([]);
  });

  it("rejects a duplicate branch name", () => {
    expect(validatePrSeries([def(), def({ dir: "02-b" })]).join()).toMatch(/duplicate branch/i);
  });

  it("rejects an empty body, which would trip the description pre-merge check", () => {
    expect(validatePrSeries([def({ body: "" })]).join()).toMatch(/body/i);
  });

  it("rejects a PR that declares no expected surface", () => {
    expect(validatePrSeries([def({ expects: [] })]).join()).toMatch(/expects/i);
  });

  it("rejects a title ending in a period, which the repo's title check warns on", () => {
    expect(validatePrSeries([def({ title: "feat: a." })]).join()).toMatch(/title/i);
  });

  it("accepts a well-formed deletes entry", () => {
    expect(validatePrSeries([def({ deletes: ["src/old.ts"] })])).toEqual([]);
  });

  it("rejects an absolute path in deletes", () => {
    expect(validatePrSeries([def({ deletes: ["/etc/passwd"] })]).join()).toMatch(/deletes/i);
  });

  it("rejects a path-traversal segment in deletes", () => {
    expect(validatePrSeries([def({ deletes: ["../../etc/passwd"] })]).join()).toMatch(/deletes/i);
  });

  it("rejects an empty string in deletes", () => {
    expect(validatePrSeries([def({ deletes: [""] })]).join()).toMatch(/deletes/i);
  });
});

describe("applyTemplatePath", () => {
  it("strips a trailing .tmpl suffix", () => {
    expect(applyTemplatePath("package.json.tmpl")).toBe("package.json");
  });

  it("leaves a path without a .tmpl suffix untouched", () => {
    expect(applyTemplatePath("src/index.ts")).toBe("src/index.ts");
  });

  it("only strips a trailing .tmpl, not one mid-path", () => {
    expect(applyTemplatePath("a.tmpl/b.json")).toBe("a.tmpl/b.json");
  });
});

describe("the real pr-series fixture", () => {
  it("loads exactly ten entries and passes validation", () => {
    const defs = loadPrSeries(REAL_PR_SERIES_ROOT);
    expect(defs).toHaveLength(10);
    expect(validatePrSeries(defs)).toEqual([]);
  });

  it("marks PR 10 as not openable, since it records a follow-up action on PR 1 rather than a new PR", () => {
    const defs = loadPrSeries(REAL_PR_SERIES_ROOT);
    const ten = defs.find((d) => d.dir.startsWith("10-"));
    expect(ten?.open).toBe(false);
  });

  it("refuses to open PR 10 via findPr", () => {
    expect(() => findPr(REAL_PR_SERIES_ROOT, "10")).toThrow(/not meant to be opened|trial-runbook/i);
  });

  it("still finds an openable PR via findPr", () => {
    expect(findPr(REAL_PR_SERIES_ROOT, "01").dir).toBe("01-report-tags-search-export");
  });
});

describe("PR 09's manifest ships as a template", () => {
  // dependency-review-action flags any file named `package.json` by path,
  // regardless of whether it's installed — see applyTemplatePath in
  // src/parity/fixture.ts. PR 09 deliberately plants a vulnerable lodash
  // pin, so its manifest must live in files/ as package.json.tmpl, never
  // as a literal package.json.
  const filesDir = path.join(REAL_PR_SERIES_ROOT, "09-layered-refactor-archive", "files");

  it("has no literal package.json in its files/ tree", () => {
    expect(fs.existsSync(path.join(filesDir, "package.json"))).toBe(false);
  });

  it("ships the manifest as package.json.tmpl", () => {
    expect(fs.existsSync(path.join(filesDir, "package.json.tmpl"))).toBe(true);
  });

  it("applying the files/ tree produces package.json, not package.json.tmpl", () => {
    const destDir = fs.mkdtempSync(path.join(os.tmpdir(), "diffsentry-fixture-apply-"));
    try {
      // Mirrors copyFilesTree's walk in scripts/fixture-open-pr.ts: recurse
      // the files/ tree, mapping each relative path through
      // applyTemplatePath before writing it into the destination checkout.
      const walk = (srcDir: string, relDir: string): void => {
        for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
          const rel = path.join(relDir, entry.name);
          if (entry.isDirectory()) {
            walk(path.join(srcDir, entry.name), rel);
            continue;
          }
          const destRel = applyTemplatePath(rel);
          const dest = path.join(destDir, destRel);
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.copyFileSync(path.join(srcDir, entry.name), dest);
        }
      };
      walk(filesDir, "");

      expect(fs.existsSync(path.join(destDir, "package.json"))).toBe(true);
      expect(fs.existsSync(path.join(destDir, "package.json.tmpl"))).toBe(false);

      const applied = JSON.parse(fs.readFileSync(path.join(destDir, "package.json"), "utf8"));
      expect(applied.dependencies?.lodash).toBe("4.17.15");
    } finally {
      fs.rmSync(destDir, { recursive: true, force: true });
    }
  });
});

describe("PR 09 does not declare a deletes entry for src/worker.ts", () => {
  // Investigated after a review finding noted that overlay-only copying
  // (files/ over the checkout, see copyFilesTree in
  // scripts/fixture-open-pr.ts) leaves a base file in place if a PR's
  // scenario means to remove it, and flagged PR 09 as a suspect: it ships
  // src/retention.ts and adds test/worker.test.ts without shipping
  // src/worker.ts, which looks superseded at a glance.
  //
  // It is not. Evidence, all within PR 09's own files/ tree:
  //   - files/README.md's "Layout" section lists `src/worker.ts` as a
  //     surviving module ("the pruning worker, run on a timer by
  //     src/index.ts") alongside the new src/routes/ and src/archive/.
  //   - files/src/index.ts still imports runWorker from "./worker.js" and
  //     schedules it on a timer, unchanged from the seed.
  //   - files/test/worker.test.ts imports runWorker from "../src/worker.js"
  //     and exercises it end-to-end — it is a new test for the unmodified
  //     seed file, not a replacement test for something that moved.
  //   - Applying PR 09's overlay onto the seed and type-checking the result
  //     produces no missing-module error for worker.ts or its import in
  //     index.ts/test/worker.test.ts (only unrelated "no @types/node
  //     installed in this scratch check" noise).
  // The refactor moved request routing and pulled the retention predicate
  // into src/retention.ts, but the worker that calls Store.prune on a timer
  // was left alone. So PR 09 correctly declares no `deletes` entries; a
  // `deletes: ["src/worker.ts"]` entry here would be wrong and would break
  // the PR by removing a file src/index.ts still imports.
  const pr09 = loadPrSeries(REAL_PR_SERIES_ROOT).find((d) => d.dir.startsWith("09-"));

  it("PR 09 exists in the series", () => {
    expect(pr09).toBeDefined();
  });

  it("declares no deletes", () => {
    expect(pr09?.deletes ?? []).toEqual([]);
  });

  it("still ships src/index.ts importing from ./worker.js, confirming worker.ts stays live", () => {
    const indexTs = fs.readFileSync(
      path.join(REAL_PR_SERIES_ROOT, "09-layered-refactor-archive", "files", "src", "index.ts"),
      "utf8",
    );
    expect(indexTs).toContain("./worker.js");
  });
});

describe("none of the other PRs in the series need a deletes entry", () => {
  // Checked every PR's files/ tree against the seed's file list (src/,
  // test/, ingest/, docs/, .github/workflows/): PRs 1, 2, 7, 8 modify
  // existing files in place; PRs 3, 4, 6 add or modify without removing
  // anything the base still needs; PR 5 modifies docs/getting-started.md
  // in place; PR 10 isn't opened as a PR at all (open: false). None of them
  // omit a base file the way PR 09 was suspected (wrongly, see above) of
  // omitting src/worker.ts.
  it("no PR other than 09 declares deletes, and 09 declares none", () => {
    const defs = loadPrSeries(REAL_PR_SERIES_ROOT);
    for (const d of defs) {
      expect(d.deletes ?? [], `${d.dir} should not declare deletes`).toEqual([]);
    }
  });
});
