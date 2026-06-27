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
  detectRoot,
  relativize,
  normRel,
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

  // widget.ts: a Class (1-50) that fully contains a method/Function (render,
  // 10-20) — mirrors the live graph (classes indexed alongside their methods),
  // used to exercise container/nesting dedup.
  node.run("File", "widget.ts", abs("src/widget.ts"), abs("src/widget.ts"), null, null);
  node.run("Class", "Widget", `${abs("src/widget.ts")}::Widget`, abs("src/widget.ts"), 1, 50);
  node.run("Function", "render", `${abs("src/widget.ts")}::render`, abs("src/widget.ts"), 10, 20);

  const edge = db.prepare(
    "INSERT INTO edges (kind,source_qualified,target_qualified,file_path) VALUES (?,?,?,?)",
  );
  // a, b, c all import util.ts  → util fan-in (imports) = 3
  for (const dep of ["src/a.ts", "src/b.ts", "src/c.ts"]) {
    edge.run("IMPORTS_FROM", abs(dep), abs("src/util.ts"), abs(dep));
  }
  // d.ts CALLS util.foo. The edge's file_path is deliberately set to the TARGET
  // file (util.ts), NOT the caller — so fan-in must recover the caller from
  // source_qualified ("<d.ts>::run"). If the query regressed to reading
  // file_path it would resolve the caller as util.ts (self), drop it, and the
  // fan-in below would be 3 instead of 4.
  edge.run("CALLS", `${abs("src/d.ts")}::run`, `${abs("src/util.ts")}::foo`, abs("src/util.ts"));
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
  it("marks the full new-side hunk span (context + additions)", () => {
    // New side: start 12, count 4 → lines 12..15 are all touched.
    const patch = "@@ -10,3 +12,4 @@\n ctx\n+added1\n+added2\n ctx2\n";
    const lines = changedLinesFromPatch(patch);
    expect([...lines].sort((a, b) => a - b)).toEqual([12, 13, 14, 15]);
  });

  it("scopes deletion-only hunks to their surviving new-side context", () => {
    // One line removed between two context lines: new side start 10, count 2.
    // The '+'-only logic would have returned an empty set (→ whole-file
    // fallback); the span logic localizes to lines 10-11.
    const patch = "@@ -10,3 +10,2 @@\n ctx1\n-removed\n ctx2\n";
    expect([...changedLinesFromPatch(patch)].sort((a, b) => a - b)).toEqual([10, 11]);
  });

  it("covers replacement hunks across the whole new span", () => {
    const patch = "@@ -5,2 +5,2 @@\n-old\n+new\n ctx\n";
    expect([...changedLinesFromPatch(patch)].sort((a, b) => a - b)).toEqual([5, 6]);
  });

  it("localizes a pure deletion (new count 0) to the deletion point", () => {
    const patch = "@@ -8,3 +7,0 @@\n-a\n-b\n-c\n";
    expect([...changedLinesFromPatch(patch)]).toEqual([7]);
  });

  it("handles a hunk header with omitted new count (implicit 1)", () => {
    const patch = "@@ -4 +4 @@\n-old\n+new\n";
    expect([...changedLinesFromPatch(patch)]).toEqual([4]);
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
    // imported by a, b, c (3) + called from d.ts (1) → fan-in 4. The caller
    // d.ts is recoverable ONLY from source_qualified (the edge's file_path was
    // set to util.ts), so 4 proves fan-in parses the caller identity correctly.
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

  it("drops a container symbol when a nested symbol overlaps the change", () => {
    // Change at lines 10-13 overlaps both Widget (1-50) and render (10-20);
    // the enclosing class is dropped so its 50-line body doesn't re-print render.
    const ctx = queryGraph(
      [{ path: "src/widget.ts", patch: "@@ -10,3 +10,4 @@\n a\n+b\n c\n d\n" }],
      { graphDbPath: dbPath },
    );
    expect(ctx.files[0].symbols.map((s) => s.name)).toEqual(["render"]);
  });

  it("keeps the container when only its non-nested lines change", () => {
    // Change at lines 1-3 is outside render (10-20); only Widget overlaps.
    const ctx = queryGraph(
      [{ path: "src/widget.ts", patch: "@@ -1,2 +1,3 @@\n a\n+b\n c\n" }],
      { graphDbPath: dbPath },
    );
    expect(ctx.files[0].symbols.map((s) => s.name)).toEqual(["Widget"]);
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

  it("normalises CRLF head files so symbol bodies carry no stray \\r", async () => {
    const crlf = ["l1", "l2", "l3", "l4", "l5"].join("\r\n");
    const res = await buildGraphContext({
      files: [{ path: "src/util.ts", patch: "@@ -1,2 +1,3 @@\n a\n+b\n c\n" }],
      readHeadFile: async () => crlf,
      graphDbPath: dbPath,
    });
    const foo = res.files[0].symbols.find((s) => s.name === "foo");
    expect(foo?.source).toBeDefined();
    expect(foo?.source).not.toContain("\r");
    expect(foo?.source).toBe("l1\nl2\nl3\nl4\nl5");
  });

  it("renders nothing when graph is unavailable", () => {
    expect(renderRelatedContext({ available: false, files: [], fanInByFile: {} })).toBe("");
  });

  it("selects an extension-appropriate fence language", () => {
    const md = renderRelatedContext({
      available: true,
      fanInByFile: {},
      files: [
        {
          file: "config/app.yaml",
          indexed: true,
          symbols: [
            {
              name: "cfg",
              kind: "Function",
              qualifiedName: "config/app.yaml::cfg",
              file: "config/app.yaml",
              lineStart: 1,
              lineEnd: 1,
              source: "key: value",
            },
          ],
          dependencies: [],
          dependents: [],
          fanIn: 0,
          highFanIn: false,
        },
      ],
    });
    expect(md).toContain("```yaml");
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

// A graph indexed on Windows stores backslash absolute paths, but GitHub PR
// paths are always forward-slash. queryGraph must still resolve them and emit
// forward-slash repo-relative paths.
describe("queryGraph — Windows / backslash graph paths", () => {
  let winDbPath: string;
  const WROOT = "C:\\proj";
  const wabs = (p: string) => `${WROOT}\\${p.replace(/\//g, "\\")}`;

  beforeAll(() => {
    winDbPath = path.join(os.tmpdir(), `gc-win-${Date.now()}.db`);
    const db = new Database(winDbPath);
    db.exec(`
      CREATE TABLE nodes (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL,
        name TEXT NOT NULL, qualified_name TEXT NOT NULL UNIQUE, file_path TEXT NOT NULL,
        line_start INTEGER, line_end INTEGER, updated_at REAL NOT NULL DEFAULT 0);
      CREATE TABLE edges (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL,
        source_qualified TEXT NOT NULL, target_qualified TEXT NOT NULL, file_path TEXT NOT NULL,
        line INTEGER DEFAULT 0, updated_at REAL NOT NULL DEFAULT 0);
    `);
    const node = db.prepare(
      "INSERT INTO nodes (kind,name,qualified_name,file_path,line_start,line_end) VALUES (?,?,?,?,?,?)",
    );
    for (const f of ["src/util.ts", "src/a.ts", "scripts/tool.ts"]) {
      node.run("File", path.basename(f), wabs(f), wabs(f), null, null);
    }
    node.run("Function", "foo", `${wabs("src/util.ts")}::foo`, wabs("src/util.ts"), 1, 5);
    // a.ts imports util.ts → util.ts has a dependent
    db.prepare("INSERT INTO edges (kind,source_qualified,target_qualified,file_path) VALUES (?,?,?,?)").run(
      "IMPORTS_FROM",
      wabs("src/a.ts"),
      wabs("src/util.ts"),
      wabs("src/a.ts"),
    );
    db.close();
  });

  afterAll(() => {
    try {
      fs.unlinkSync(winDbPath);
    } catch {
      /* ignore */
    }
  });

  it("resolves a forward-slash PR path against a backslash-indexed graph", () => {
    const ctx = queryGraph(
      [{ path: "src/util.ts", patch: "@@ -1,2 +1,3 @@\n a\n+b\n c\n" }],
      { graphDbPath: winDbPath },
    );
    expect(ctx.available).toBe(true);
    const util = ctx.files[0];
    expect(util.indexed).toBe(true);
    expect(util.symbols.map((s) => s.name)).toEqual(["foo"]);
    // Emitted dependent path is forward-slash, not "C:\proj\src\a.ts".
    expect(util.dependents).toEqual(["src/a.ts"]);
    expect(util.fanIn).toBe(1);
    expect(ctx.fanInByFile["src/util.ts"]).toBe(1);
  });
});

describe("detectRoot / relativize — POSIX and Windows path shapes", () => {
  it("preserves the leading slash for a Unix-style common root and strips it cleanly", () => {
    const paths = [
      "/Users/luke/proj/src/a.ts",
      "/Users/luke/proj/src/b.ts",
      "/Users/luke/proj/scripts/t.ts",
    ];
    const root = detectRoot(paths);
    expect(root).toBe("/Users/luke/proj");
    expect(paths.map((p) => normRel(relativize(p, root)))).toEqual([
      "src/a.ts",
      "src/b.ts",
      "scripts/t.ts",
    ]);
  });

  it("detects a drive-qualified common root for Windows (backslash) paths", () => {
    const paths = ["C:\\proj\\src\\a.ts", "C:\\proj\\src\\b.ts", "C:\\proj\\scripts\\t.ts"];
    const root = detectRoot(paths);
    expect(root).toBe("C:/proj");
    expect(paths.map((p) => normRel(relativize(p, root)))).toEqual([
      "src/a.ts",
      "src/b.ts",
      "scripts/t.ts",
    ]);
  });

  it("still yields correct relative paths when files diverge at the root", () => {
    // Common prefix is just the filesystem/drive root; relativize+normRel must
    // still produce clean repo-relative paths.
    const posix = ["/a/x.ts", "/b/y.ts"];
    expect(posix.map((p) => normRel(relativize(p, detectRoot(posix))))).toEqual(["a/x.ts", "b/y.ts"]);
    const win = ["C:\\a\\x.ts", "C:\\b\\y.ts"];
    expect(win.map((p) => normRel(relativize(p, detectRoot(win))))).toEqual(["a/x.ts", "b/y.ts"]);
  });

  it("relativize leaves non-matching paths POSIX-normalised", () => {
    expect(relativize("D:\\other\\f.ts", "C:/proj")).toBe("D:/other/f.ts");
  });

  it("does not strip a sibling directory that merely shares a textual prefix", () => {
    // /a/foobar is NOT under /a/foo; the `root + "/"` check is segment-aware
    // and must reject it (returning the full path), not slice it to "bar/x.ts".
    expect(normRel(relativize("/a/foobar/x.ts", "/a/foo"))).toBe("a/foobar/x.ts");
    expect(normRel(relativize("/a/foo/x.ts", "/a/foo"))).toBe("x.ts");
    // detectRoot only returns whole shared segments, so a non-boundary prefix
    // can't even arise: the common root of these two is /a, not /a/foo.
    expect(detectRoot(["/a/foo/x.ts", "/a/foobar/y.ts"])).toBe("/a");
  });
});

describe("renderRelatedContext — ordering determinism", () => {
  it("breaks fanIn/symbol-count ties by file path, independent of input order", () => {
    const mk = (file: string) => ({
      file,
      indexed: true,
      symbols: [],
      dependencies: [],
      dependents: ["x.ts"],
      fanIn: 1,
      highFanIn: false,
    });
    // Input deliberately out of alphabetical order with identical rank.
    const md = renderRelatedContext({
      available: true,
      fanInByFile: {},
      files: [mk("src/zebra.ts"), mk("src/alpha.ts"), mk("src/mango.ts")],
    });
    const order = ["src/alpha.ts", "src/mango.ts", "src/zebra.ts"].map((f) => md.indexOf(f));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b)); // appear in alpha order
  });
});
