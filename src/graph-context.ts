// ─── Graph-backed Review Context ───────────────────────────────
//
// Gives the AI reviewer real code context that a unified diff can't carry:
//   (a) the full source of each changed function/symbol (not just the hunk),
//   (b) the directly-related files (imports in, imports out), and
//   (c) a fan-in / impact-radius count per changed file.
//
// The source of truth is the `code-review-graph` knowledge graph — a Tree-
// sitter-built structural index persisted as a plain SQLite file at
// `.code-review-graph/graph.db`. We query that file directly with the
// `better-sqlite3` driver the rest of the app already depends on, rather than
// going through the MCP server (which isn't reachable from the review server's
// Node process at runtime).
//
// EVERYTHING here is best-effort and non-fatal. A missing graph, an un-indexed
// path, a schema we don't recognise, or a failed head-file fetch all degrade to
// "no extra context" — never to a failed review. The graph reflects whatever
// commit it was last built against, so treat it as a hint, not ground truth.

import path from "node:path";
import fs from "node:fs";
import Database, { Database as DB } from "better-sqlite3";
import { logger } from "./logger.js";

const log = logger.child({ module: "graph-context" });

// ─── Public shapes ─────────────────────────────────────────────

/** One function/class/method the change touches, with its full line span. */
export interface ChangedSymbol {
  /** Bare symbol name, e.g. `handlePullRequest`. */
  name: string;
  /** Graph node kind: Function | Class | Test | … */
  kind: string;
  /** `<file>::<name>` graph identity. */
  qualifiedName: string;
  /** Repo-relative file the symbol lives in. */
  file: string;
  /** 1-based inclusive line range of the whole symbol body. */
  lineStart: number;
  lineEnd: number;
  /** Whole-symbol source, sliced from the PR head. Absent if unfetchable. */
  source?: string;
}

/** Graph-derived context for a single changed file. */
export interface FileGraphContext {
  /** Repo-relative path as it appears in the PR. */
  file: string;
  /** Whether the graph actually had this file indexed. */
  indexed: boolean;
  /** Changed functions/classes in the file (scoped to touched lines when known). */
  symbols: ChangedSymbol[];
  /** Repo-relative files this file imports FROM (direct dependencies). */
  dependencies: string[];
  /** Repo-relative files that import this file (direct dependents). */
  dependents: string[];
  /** Distinct other files that depend on this one (imports + cross-file calls). */
  fanIn: number;
  /** True when fanIn ≥ the high-fan-in threshold — a blast-radius flag. */
  highFanIn: boolean;
}

/** Full result of a graph-context build for one PR. */
export interface GraphContext {
  /** True when the graph DB was found and opened. */
  available: boolean;
  /** Per-file context, in the same order as the input files. */
  files: FileGraphContext[];
  /** Per-file fan-in counts, keyed by repo-relative path. Persisted on the
   *  review result so later passes (e.g. severity calibration) can reuse them. */
  fanInByFile: Record<string, number>;
}

export interface BuildGraphContextOptions {
  /** Changed files — relative path + unified-diff patch (used to scope symbols). */
  files: { path: string; patch?: string }[];
  /** Reads a file's whole contents at the PR head. Best-effort; may return null. */
  readHeadFile?: (relPath: string) => Promise<string | null>;
  /** Override the graph DB location (defaults to env or `.code-review-graph/graph.db`). */
  graphDbPath?: string;
  /** fanIn ≥ this marks a file high-impact. Default 5. */
  highFanInThreshold?: number;
  /** Hard cap on the rendered "Related context" section. Default ~12k chars. */
  maxRelatedChars?: number;
  /** Max changed symbols whose bodies we fetch+render per file. Default 6. */
  maxSymbolsPerFile?: number;
  /** Per-symbol body truncation, in chars. Default 2400. */
  maxSymbolChars?: number;
}

export interface GraphContextResult extends GraphContext {
  /** Rendered, budget-capped markdown section. `""` when there's nothing to add. */
  relatedContextMarkdown: string;
}

const DEFAULTS = {
  highFanInThreshold: 5,
  maxRelatedChars: 12_000,
  maxSymbolsPerFile: 6,
  maxSymbolChars: 2_400,
};

// ─── DB location ───────────────────────────────────────────────

function resolveGraphDbPath(override?: string): string {
  if (override) return override;
  if (process.env.DIFFSENTRY_GRAPH_DB) return process.env.DIFFSENTRY_GRAPH_DB;
  return path.join(process.cwd(), ".code-review-graph", "graph.db");
}

// ─── Path normalisation ────────────────────────────────────────
//
// The graph stores ABSOLUTE paths from whatever machine built it. We don't know
// that machine's repo root, so we detect it as the longest common directory
// prefix of every indexed file and strip it. That makes every emitted path
// repo-relative and lets us match PR paths by exact equality (with a suffix
// fallback for safety).
//
// All root-detection, matching, and emitted paths are POSIX-normalised first:
// a graph indexed on Windows stores backslash paths, but GitHub PR paths are
// always forward-slash, so we collapse separators before comparing. (The RAW
// path is still used for the SQLite `file_path = ?` lookups — those must match
// the stored representation byte-for-byte.)

// detectRoot / relativize / normRel are internal path-normalisation helpers,
// exported ONLY so the unit tests can exercise them directly across POSIX and
// Windows path shapes. They are not a stable public API — callers outside this
// module should not depend on their exact slash/prefix behaviour, which may
// change to suit graph-path handling.

/** Collapse OS path separators to POSIX `/`. */
function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

export function detectRoot(absPaths: string[]): string {
  if (absPaths.length === 0) return "";
  const split = absPaths.map((p) => toPosix(p).split("/"));
  const first = split[0];
  let i = 0;
  for (; i < first.length; i++) {
    const seg = first[i];
    if (!split.every((parts) => parts[i] === seg)) break;
  }
  return first.slice(0, i).join("/");
}

/** Strip the detected root, returning a POSIX repo-relative path (root is
 *  already POSIX from detectRoot). */
export function relativize(abs: string, root: string): string {
  const p = toPosix(abs);
  if (root && p.startsWith(root + "/")) return p.slice(root.length + 1);
  return p;
}

/** Normalise a path (PR-relative or post-relativize) for map keys: POSIX
 *  separators, no leading `./` or `/`. */
export function normRel(p: string): string {
  return toPosix(p).replace(/^\.?\//, "");
}

// ─── Diff parsing ──────────────────────────────────────────────

/**
 * New-side line numbers a unified-diff patch touches — the FULL new-side span of
 * every hunk (context + additions), not just the `+` lines. Used to scope
 * "changed symbols" to the functions a hunk overlaps. Marking the whole span
 * keeps scoping accurate for modification-only and deletion-heavy hunks (where
 * the change is bracketed by context lines), instead of degrading to "all
 * symbols in the file". Returns an empty set when the patch is missing or has no
 * parseable hunk header — the caller then includes all symbols.
 */
export function changedLinesFromPatch(patch?: string): Set<number> {
  const lines = new Set<number>();
  if (!patch) return lines;
  for (const raw of patch.split("\n")) {
    // Hunk header: @@ -<oldStart>[,<oldCount>] +<newStart>[,<newCount>] @@
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(raw);
    if (!hunk) continue;
    const newStart = parseInt(hunk[1], 10);
    const newCount = hunk[2] === undefined ? 1 : parseInt(hunk[2], 10);
    if (newCount <= 0) {
      // Pure deletion — no new-side line survives in this hunk. Attribute the
      // change to the line at the deletion point so scoping still localizes to
      // the affected symbol instead of falling back to the whole file.
      if (newStart >= 1) lines.add(newStart);
      continue;
    }
    for (let i = 0; i < newCount; i++) lines.add(newStart + i);
  }
  return lines;
}

function overlaps(changed: Set<number>, start: number, end: number): boolean {
  if (changed.size === 0) return true; // unknown → don't filter
  for (const ln of changed) if (ln >= start && ln <= end) return true;
  return false;
}

// ─── Core graph query (synchronous; better-sqlite3 is sync) ─────

interface RawNode {
  kind: string;
  name: string;
  qualified_name: string;
  file_path: string;
  line_start: number | null;
  line_end: number | null;
}

interface RawEdge {
  kind: string;
  source_qualified: string;
  target_qualified: string;
}

/**
 * Pure-SQLite half: derive symbols + dependents/dependencies + fan-in for the
 * changed files. No source bodies yet (the graph stores line ranges, not text)
 * — those get filled in by the async fetch step. Never throws.
 */
export function queryGraph(
  files: { path: string; patch?: string }[],
  opts: { graphDbPath?: string; highFanInThreshold?: number } = {},
): GraphContext {
  const empty: GraphContext = { available: false, files: [], fanInByFile: {} };
  const dbPath = resolveGraphDbPath(opts.graphDbPath);
  const threshold = opts.highFanInThreshold ?? DEFAULTS.highFanInThreshold;

  if (!fs.existsSync(dbPath)) {
    log.debug({ dbPath }, "graph DB not found; skipping graph context");
    return empty;
  }

  let db: DB | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });

    // 1. Build the abs↔rel file map from indexed File nodes. Restricting to
    //    kind='File' reads one row per file instead of scanning every symbol-
    //    bearing node — coverage-equivalent (every symbol's file has a File
    //    node) but far less IO on large graphs.
    const fileRows = db
      .prepare("SELECT DISTINCT file_path FROM nodes WHERE kind = 'File'")
      .all() as { file_path: string }[];
    const absPaths = fileRows.map((r) => r.file_path);
    const root = detectRoot(absPaths);

    const relToAbs = new Map<string, string>();
    for (const abs of absPaths) relToAbs.set(normRel(relativize(abs, root)), abs);

    // Resolve each PR file to its absolute graph path (exact, then suffix).
    const resolved = new Map<string, string>(); // relPR -> abs (or "" if unindexed)
    for (const f of files) {
      const rel = normRel(f.path);
      let abs = relToAbs.get(rel);
      if (!abs) {
        // Suffix fallback: compare POSIX-normalised forms but keep the RAW
        // path (it's the key the SQLite queries match on).
        const hit = absPaths.find((a) => {
          const p = toPosix(a);
          return p.endsWith("/" + rel) || p === rel;
        });
        abs = hit;
      }
      resolved.set(rel, abs ?? "");
    }

    // 2. Pull symbols (Function/Class/Test) for every indexed changed file.
    const symStmt = db.prepare(
      "SELECT kind, name, qualified_name, file_path, line_start, line_end " +
        "FROM nodes WHERE file_path = ? AND kind IN ('Function','Class','Test','Method')",
    );
    // 3. Edge stmts: who imports me / who do I import / who calls into me.
    const importsOutStmt = db.prepare(
      "SELECT DISTINCT target_qualified FROM edges WHERE kind = 'IMPORTS_FROM' AND source_qualified = ?",
    );
    const importsInStmt = db.prepare(
      "SELECT DISTINCT source_qualified FROM edges WHERE kind = 'IMPORTS_FROM' AND target_qualified = ?",
    );
    const callsInStmt = db.prepare(
      "SELECT DISTINCT source_qualified FROM edges WHERE kind = 'CALLS' AND target_qualified = ?",
    );

    const out: FileGraphContext[] = [];
    const fanInByFile: Record<string, number> = {};

    for (const f of files) {
      const rel = normRel(f.path);
      const abs = resolved.get(rel) || "";
      if (!abs) {
        out.push({ file: rel, indexed: false, symbols: [], dependencies: [], dependents: [], fanIn: 0, highFanIn: false });
        continue;
      }

      const changed = changedLinesFromPatch(f.patch);

      // Symbols overlapping the changed lines.
      const symRows = symStmt.all(abs) as RawNode[];
      const overlapping: ChangedSymbol[] = symRows
        .filter((s) => s.line_start != null && s.line_end != null && overlaps(changed, s.line_start!, s.line_end!))
        .map((s) => ({
          name: s.name,
          kind: s.kind,
          qualifiedName: s.qualified_name,
          file: rel,
          lineStart: s.line_start!,
          lineEnd: s.line_end!,
        }));

      // Drop container symbols (e.g. a class) when a more specific overlapping
      // symbol nested inside them (e.g. a changed method) is also selected — the
      // container's source would otherwise re-print the inner body and burn
      // prompt budget. Keep the innermost. (`qualified_name` is unique in the
      // graph, so this can't ever see exact duplicates; it guards range nesting,
      // which the live graph does produce — classes indexed alongside their
      // methods.)
      const symbols: ChangedSymbol[] = overlapping
        .filter(
          (s) =>
            !overlapping.some(
              (o) =>
                o.qualifiedName !== s.qualifiedName &&
                o.lineStart >= s.lineStart &&
                o.lineEnd <= s.lineEnd &&
                o.lineEnd - o.lineStart < s.lineEnd - s.lineStart,
            ),
        )
        .sort((a, b) => a.lineStart - b.lineStart);

      // Dependencies: files THIS file imports from. Endpoints are run through
      // symbolFileOf() first — IMPORTS_FROM endpoints are bare file paths today,
      // but normalising defensively (a no-op for bare paths) keeps this correct
      // if the graph ever emits symbol-qualified import endpoints, and matches
      // the CALLS handling. Sorted so the rendered "Imports:" list is
      // deterministic regardless of SQLite row order.
      const depAbs = (importsOutStmt.all(abs) as { target_qualified: string }[]).map((r) => symbolFileOf(r.target_qualified));
      const dependencies = uniq(depAbs.map((a) => normRel(relativize(a, root))).filter((d) => d !== rel)).sort();

      // Dependents: files that import THIS file (fan-in via imports). Same
      // symbolFileOf normalisation + sort.
      const dependentAbs = (importsInStmt.all(abs) as { source_qualified: string }[]).map((r) => symbolFileOf(r.source_qualified));
      const dependents = uniq(dependentAbs.map((a) => normRel(relativize(a, root))).filter((d) => d !== rel)).sort();

      // Cross-file callers: any file with a CALLS edge into one of our symbols.
      // The caller is the source SYMBOL's file, parsed from its `<file>::<name>`
      // identity — not the edge's `file_path` column. The two coincide for CALLS
      // edges today, but `source_qualified` is the definitive caller, so deriving
      // from it keeps fan-in correct regardless of what `file_path` records.
      const callerFiles = new Set<string>();
      for (const s of symRows) {
        const callRows = callsInStmt.all(s.qualified_name) as { source_qualified: string }[];
        for (const cr of callRows) {
          const callerAbs = symbolFileOf(cr.source_qualified);
          if (!callerAbs) continue;
          const crel = normRel(relativize(callerAbs, root));
          if (crel && crel !== rel) callerFiles.add(crel);
        }
      }

      // Fan-in = distinct other files depending on this one (imports ∪ calls).
      const impactFiles = new Set<string>([...dependents, ...callerFiles]);
      const fanIn = impactFiles.size;

      fanInByFile[rel] = fanIn;
      out.push({
        file: rel,
        indexed: true,
        symbols,
        dependencies,
        dependents,
        fanIn,
        highFanIn: fanIn >= threshold,
      });
    }

    return { available: true, files: out, fanInByFile };
  } catch (err) {
    log.warn({ err }, "graph query failed; continuing without graph context");
    return empty;
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  }
}

function uniq(xs: string[]): string[] {
  return Array.from(new Set(xs));
}

/** The file portion of a `<file>::<symbol>` qualified name. Returns the whole
 *  string when there is no `::` separator (e.g. a File-node identity). */
function symbolFileOf(qualified: string): string {
  const idx = qualified.indexOf("::");
  return idx === -1 ? qualified : qualified.slice(0, idx);
}

// ─── Whole-function body fetching ──────────────────────────────

/**
 * Fill in `symbol.source` by slicing each symbol's line range out of its file's
 * head-revision contents. Files are read once each, in parallel, via the
 * injected `readHeadFile` (so this module stays decoupled from GitHub and is
 * trivially testable). Best-effort: a file that won't read leaves its symbols
 * body-less, and the renderer simply omits the code block.
 */
export async function fillSymbolSources(
  ctx: GraphContext,
  readHeadFile: (relPath: string) => Promise<string | null>,
  maxSymbolChars: number = DEFAULTS.maxSymbolChars,
): Promise<void> {
  const filesNeedingSource = ctx.files.filter((f) => f.symbols.length > 0);
  const contents = new Map<string, string | null>();

  await Promise.all(
    uniq(filesNeedingSource.map((f) => f.file)).map(async (rel) => {
      try {
        contents.set(rel, await readHeadFile(rel));
      } catch (err) {
        log.debug({ err, file: rel }, "head-file read failed");
        contents.set(rel, null);
      }
    }),
  );

  for (const f of filesNeedingSource) {
    const text = contents.get(f.file);
    if (!text) continue;
    // Normalise CRLF / lone-CR to LF before slicing: a CRLF head file would
    // otherwise leave a trailing \r on every line, leaking into the rendered
    // fence and inflating the char budget. Line numbers are graph-derived, so
    // consistent splitting matters.
    const lines = text.replace(/\r\n?/g, "\n").split("\n");
    for (const s of f.symbols) {
      // line_start/line_end are 1-based inclusive.
      const slice = lines.slice(s.lineStart - 1, s.lineEnd).join("\n");
      if (!slice.trim()) continue;
      s.source = slice.length > maxSymbolChars ? slice.slice(0, maxSymbolChars) + "\n// … (truncated)" : slice;
    }
  }
}

// ─── Rendering (token-budgeted) ────────────────────────────────

/** Markdown fence language for a file extension. The graph can index many
 *  languages, so this covers the common ones; unknown extensions intentionally
 *  fall back to a plain (language-less) fence rather than guessing. */
function langForFile(file: string): string {
  const ext = path.extname(file).toLowerCase();
  switch (ext) {
    case ".ts":
    case ".tsx":
      return "ts";
    case ".js":
    case ".jsx":
      return "js";
    case ".py":
      return "py";
    case ".go":
      return "go";
    case ".rs":
      return "rust";
    case ".java":
      return "java";
    case ".rb":
      return "ruby";
    case ".php":
      return "php";
    case ".c":
    case ".h":
      return "c";
    case ".cpp":
    case ".cc":
    case ".hpp":
      return "cpp";
    case ".cs":
      return "csharp";
    case ".kt":
      return "kotlin";
    case ".swift":
      return "swift";
    case ".sh":
    case ".bash":
      return "bash";
    case ".json":
      return "json";
    case ".yml":
    case ".yaml":
      return "yaml";
    case ".md":
      return "markdown";
    default:
      return "";
  }
}

function compactList(items: string[], max: number): string {
  if (items.length === 0) return "_none_";
  const shown = items.slice(0, max).map((i) => `\`${i}\``).join(", ");
  const extra = items.length - max;
  return extra > 0 ? `${shown} (+${extra} more)` : shown;
}

/**
 * Render a bounded "Related context" markdown section. Files are ordered
 * high-fan-in first (most blast radius = most worth the reviewer's context
 * budget), and we stop emitting whole-symbol bodies once `maxRelatedChars` is
 * hit — large PRs degrade to a compact dependency map rather than blowing the
 * model's context window. Returns `""` when there's nothing useful to add.
 */
export function renderRelatedContext(
  ctx: GraphContext,
  opts: { maxRelatedChars?: number; maxSymbolsPerFile?: number } = {},
): string {
  if (!ctx.available) return "";
  const maxChars = opts.maxRelatedChars ?? DEFAULTS.maxRelatedChars;
  const maxSymbols = opts.maxSymbolsPerFile ?? DEFAULTS.maxSymbolsPerFile;

  const indexed = ctx.files.filter(
    (f) => f.indexed && (f.symbols.length > 0 || f.dependents.length > 0 || f.dependencies.length > 0),
  );
  if (indexed.length === 0) return "";

  // High-impact files first; ties broken by symbol count, then by path so the
  // rendered order is fully deterministic regardless of input file order.
  const ordered = [...indexed].sort(
    (a, b) => b.fanIn - a.fanIn || b.symbols.length - a.symbols.length || a.file.localeCompare(b.file),
  );

  const header =
    "## Related context (from code graph)\n\n" +
    "> Auto-extracted whole-symbol bodies and cross-file impact for the changed code, drawn from the repository's structural graph. " +
    "Use it to reason **beyond** the diff hunks (e.g. callers you'd break, the full body of a partially-shown function). " +
    "Review only the diffs above — this section is reference context, not part of the change.\n";

  const parts: string[] = [header];
  let used = header.length;
  let bodiesBudgetHit = false;

  for (const f of ordered) {
    const flag = f.highFanIn ? ` ⚠️ **high fan-in (${f.fanIn})**` : f.fanIn > 0 ? ` · fan-in ${f.fanIn}` : "";
    let block = `\n### \`${f.file}\`${flag}\n`;
    block += `- Imports: ${compactList(f.dependencies, 12)}\n`;
    block += `- Imported by: ${compactList(f.dependents, 12)}\n`;

    const bodies: string[] = [];
    if (!bodiesBudgetHit) {
      for (const s of f.symbols.slice(0, maxSymbols)) {
        if (!s.source) continue;
        const lang = langForFile(f.file);
        const fenced = `\n**\`${s.name}\`** (lines ${s.lineStart}–${s.lineEnd}):\n\`\`\`${lang}\n${s.source}\n\`\`\`\n`;
        if (used + block.length + bodies.join("").length + fenced.length > maxChars) {
          bodiesBudgetHit = true;
          break;
        }
        bodies.push(fenced);
      }
    }

    if (bodies.length > 0) block += "\nChanged symbols:\n" + bodies.join("");

    // Always allow the (small) dependency map even when bodies are budgeted out,
    // until we blow the cap on metadata alone.
    if (used + block.length > maxChars) {
      parts.push("\n_…related context truncated to fit the review budget._\n");
      break;
    }
    parts.push(block);
    used += block.length;
  }

  return parts.join("");
}

// ─── Orchestrator (the one call reviewer.ts makes) ─────────────

/**
 * Build the complete graph-backed review context for a PR: query the graph,
 * fetch whole-function bodies from the head, and render a budget-capped section.
 * Wrapped end-to-end so it can never break a review — any failure yields empty,
 * behaviour-preserving output (no section, no fan-in data).
 */
export async function buildGraphContext(opts: BuildGraphContextOptions): Promise<GraphContextResult> {
  const emptyResult: GraphContextResult = {
    available: false,
    files: [],
    fanInByFile: {},
    relatedContextMarkdown: "",
  };

  try {
    const ctx = queryGraph(opts.files, {
      graphDbPath: opts.graphDbPath,
      highFanInThreshold: opts.highFanInThreshold,
    });
    if (!ctx.available) return emptyResult;

    if (opts.readHeadFile) {
      await fillSymbolSources(ctx, opts.readHeadFile, opts.maxSymbolChars);
    }

    const relatedContextMarkdown = renderRelatedContext(ctx, {
      maxRelatedChars: opts.maxRelatedChars,
      maxSymbolsPerFile: opts.maxSymbolsPerFile,
    });

    return { ...ctx, relatedContextMarkdown };
  } catch (err) {
    log.warn({ err }, "buildGraphContext failed; review proceeds without graph context");
    return emptyResult;
  }
}
