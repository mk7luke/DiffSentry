import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import {
  queryGraph,
  buildGraphContext,
  changedLinesFromPatch,
  renderRelatedContext,
} from "../../src/graph-context.js";

// A tiny structural graph fixture mirroring the real code-review-graph schema
// (subset). Absolute paths under a fake root prove the path-relativisation +
// fan-in math without depending on the gitignored production graph.db.
const ROOT = "/tmp/fakeproj";
let dbPath: string;

function abs(p: string) {
  return `${ROOT}/${p}`;
}

beforeAll(() => {
  dbPath = path.join(os.tmpdir(), `gc-fixture-${Date.now()}.db`);
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE nodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL, name TEXT NOT NULL, qualified_name TEXT NOT NULL UNIQUE,
      file_path TEXT NOT NULL, line_start INTEGER, line_end INTEGER, updated_at REAL NOT NULL DEFAULT 0
    );
    CREATE TABLE edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL, source_qualified TEXT NOT NULL, target_qualified TEXT NOT NULL,
      file_path TEXT NOT NULL, line INTEGER DEFAULT 0, updated_at REAL NOT NULL DEFAULT 0
    );
  `);

  const node = db.prepare(
    "INSERT INTO nodes (kind,name,qualified_name,file_path,line_start,line_end) VALUES (?,?,?,?,?,?)",
  );
  // File nodes — spanning two top-level dirs (src/, scripts/) so the detected
  // repo root is /tmp/fakeproj, exactly as a real multi-dir graph would yield.
  for (const f of ["src/util.ts", "src/a.ts", "src/b.ts", "src/c.ts", "scripts/tool.ts"]) {
    node.run("File", path.basename(f), abs(f), abs(f), null, null);
  }
  // Two functions in util.ts: foo (lines 1-5), bar (lines 10-20)
  node.run("Function", "foo", `${abs("src/util.ts")}::foo`, abs("src/util.ts"), 1, 5);
  node.run("Function", "bar", `${abs("src/util.ts")}::bar`, abs("src/util.ts"), 10, 20);

  const edge = db.prepare(
    "INSERT INTO edges (kind,source_qualified,target_qualified,file_path) VALUES (?,?,?,?)",
  );
  // a, b, c all import util.ts  → util fan-in (imports) = 3
  for (const dep of ["src/a.ts", "src/b.ts", "src/c.ts"]) {
    edge.run("IMPORTS_FROM", abs(dep), abs("src/util.ts"), abs(dep));
  }
  // util.ts imports nothing here; a.ts also CALLS util.foo from a 4th file d.ts
  edge.run("CALLS", `${abs("src/d.ts")}::run`, `${abs("src/util.ts")}::foo`, abs("src/d.ts"));
  db.close();
});

afterAll(() => {
  try {
    fs.unlinkSync(dbPath);
  } catch {
    /* ignore */
  }
});

describe("changedLinesFromPatch", () => {
  it("extracts new-side added line numbers from a unified diff", () => {
    // New side starts at 12: " ctx"=12, "+added1"=13, "+added2"=14, " ctx2"=15.
    // Only the added (+) lines are reported — they are what actually changed.
    const patch = "@@ -10,3 +12,4 @@\n ctx\n+added1\n+added2\n ctx2\n";
    const lines = changedLinesFromPatch(patch);
    expect([...lines].sort((a, b) => a - b)).toEqual([13, 14]);
  });

  it("returns empty set for missing/blank patch", () => {
    expect(changedLinesFromPatch(undefined).size).toBe(0);
    expect(changedLinesFromPatch("").size).toBe(0);
  });
});

describe("queryGraph", () => {
  it("derives symbols, dependents, dependencies and fan-in", () => {
    const ctx = queryGraph(
      [{ path: "src/util.ts", patch: "@@ -1,2 +1,3 @@\n a\n+b\n c\n" }],
      { graphDbPath: dbPath, highFanInThreshold: 3 },
    );
    expect(ctx.available).toBe(true);
    const util = ctx.files[0];
    expect(util.indexed).toBe(true);
    // patch touches lines 1-3 → only foo (1-5) overlaps, not bar (10-20)
    expect(util.symbols.map((s) => s.name)).toEqual(["foo"]);
    // imported by a, b, c (3) + called from d.ts (1) → fan-in 4
    expect(util.fanIn).toBe(4);
    expect(util.highFanIn).toBe(true);
    expect(util.dependents.sort()).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
    expect(ctx.fanInByFile["src/util.ts"]).toBe(4);
  });

  it("marks unindexed files gracefully", () => {
    const ctx = queryGraph([{ path: "src/brand-new.ts" }], { graphDbPath: dbPath });
    expect(ctx.available).toBe(true);
    expect(ctx.files[0].indexed).toBe(false);
    expect(ctx.files[0].symbols).toHaveLength(0);
  });

  it("returns unavailable (never throws) when the DB is missing", () => {
    const ctx = queryGraph([{ path: "src/util.ts" }], { graphDbPath: "/no/such/graph.db" });
    expect(ctx.available).toBe(false);
    expect(ctx.files).toHaveLength(0);
  });

  it("includes all symbols when no patch scopes the change", () => {
    const ctx = queryGraph([{ path: "src/util.ts" }], { graphDbPath: dbPath });
    expect(ctx.files[0].symbols.map((s) => s.name).sort()).toEqual(["bar", "foo"]);
  });
});

describe("buildGraphContext + rendering", () => {
  it("fills whole-function bodies and renders a budgeted section", async () => {
    const fakeSource = Array.from({ length: 25 }, (_, i) => `line${i + 1}`).join("\n");
    const res = await buildGraphContext({
      files: [{ path: "src/util.ts", patch: "@@ -1,2 +1,6 @@\n a\n+b\n+c\n+d\n+e\n f\n" }],
      readHeadFile: async () => fakeSource,
      graphDbPath: dbPath,
      highFanInThreshold: 3,
    });
    expect(res.available).toBe(true);
    expect(res.fanInByFile["src/util.ts"]).toBe(4);
    // foo (1-5) sliced from the fake source
    const foo = res.files[0].symbols.find((s) => s.name === "foo");
    expect(foo?.source).toContain("line1");
    expect(foo?.source).toContain("line5");
    expect(res.relatedContextMarkdown).toContain("Related context");
    expect(res.relatedContextMarkdown).toContain("high fan-in (4)");
  });

  it("renders nothing when graph is unavailable", () => {
    expect(renderRelatedContext({ available: false, files: [], fanInByFile: {} })).toBe("");
  });

  it("respects the maxRelatedChars budget", async () => {
    const big = Array.from({ length: 500 }, (_, i) => `verbose_line_${i}`).join("\n");
    const res = await buildGraphContext({
      files: [{ path: "src/util.ts" }],
      readHeadFile: async () => big,
      graphDbPath: dbPath,
      maxRelatedChars: 800,
    });
    // header alone is ~600 chars; with an 800 cap the giant body must be dropped
    expect(res.relatedContextMarkdown.length).toBeLessThan(1600);
  });
});
