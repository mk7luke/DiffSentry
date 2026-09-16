import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { minimatch } from "minimatch";
import { stripFences } from "./ai/parse.js";
import { AIProvider, GLOBAL_REPO, Learning, LearningOrigin } from "./types.js";
import { logger } from "./logger.js";

// Re-exported from its home beside the `Learning.repo` field it constrains, so
// this module stays the one import for everything about the learnings store.
export { GLOBAL_REPO };

/** Filename (at the store root) holding the global learnings array. GitHub
 * owner logins can't contain underscores, so this never shadows an owner dir. */
const GLOBAL_FILE = "__global__.json";

/** Owner/repo segments are interpolated into filesystem paths by the store,
 * so constrain them to the GitHub-legal character set and reject the
 * directory-traversal specials ("." / ".." / separators) before they ever
 * reach path.join. */
const REPO_SEGMENT_RE = /^[A-Za-z0-9._-]+$/;
export function validRepoSegment(s: string): boolean {
  return REPO_SEGMENT_RE.test(s) && s !== "." && s !== "..";
}

/** Keep only the provenance fields that carry something, so a learning taught
 *  where none is knowable is stored exactly as it was before the fields
 *  existed rather than gaining a row of `undefined`s. */
function compactOrigin(origin?: LearningOrigin): LearningOrigin {
  if (!origin) return {};
  const out: LearningOrigin = {};
  if (origin.author?.trim()) out.author = origin.author.trim();
  if (typeof origin.prNumber === "number" && Number.isFinite(origin.prNumber)) out.prNumber = origin.prNumber;
  if (origin.sourceFile?.trim()) out.sourceFile = origin.sourceFile.trim();
  if (origin.sourceRepo?.trim()) out.sourceRepo = origin.sourceRepo.trim();
  return out;
}

/** Apply an edit patch to a learning, returning the next value. Empty/blank
 * content is ignored (keeps the current); path === null | "" clears the glob. */
function applyPatch(
  current: Learning,
  patch: { content?: string; path?: string | null },
): Learning {
  const next: Learning = {
    ...current,
    content:
      typeof patch.content === "string" && patch.content.trim().length > 0
        ? patch.content.trim()
        : current.content,
  };
  if (patch.path === null || patch.path === "") {
    delete next.path;
  } else if (typeof patch.path === "string") {
    next.path = patch.path.trim();
  }
  return next;
}

export class LearningsStore {
  private baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  private filePath(repo: string): string {
    // repo is "owner/name" → store as {baseDir}/owner/name.json
    const [owner, name] = repo.split("/");
    if (!validRepoSegment(owner) || !validRepoSegment(name)) {
      throw new Error(`Invalid repository segment in learnings path: ${repo}`);
    }
    return path.join(this.baseDir, owner, `${name}.json`);
  }

  private globalFilePath(): string {
    return path.join(this.baseDir, GLOBAL_FILE);
  }

  async addLearning(
    repo: string,
    content: string,
    filePath?: string,
    origin?: LearningOrigin,
  ): Promise<Learning> {
    const learning: Learning = {
      id: crypto.randomUUID(),
      repo,
      content,
      createdAt: new Date().toISOString(),
      path: filePath,
      ...compactOrigin(origin),
    };

    const learnings = await this.getLearnings(repo);
    learnings.push(learning);
    await this.writeLearnings(repo, learnings);

    return learning;
  }

  async getLearnings(repo: string): Promise<Learning[]> {
    try {
      // filePath() throws on a segment that fails validation. That must stay
      // inside the try: this is the read path, and both callers reach it with
      // unvalidated input — the legacy GET /repo/:owner/:repo route passes
      // req.params straight through, and the reviewer calls it inside a
      // Promise.all where a throw would fail the whole review. Reads degrade
      // to "no learnings"; writeLearnings still throws, so a traversal path
      // can never be written.
      const fp = this.filePath(repo);
      const data = await fs.readFile(fp, "utf-8");
      const parsed: unknown = JSON.parse(data);
      // A hand-edited or corrupt file holding a JSON object (not an array)
      // must degrade to "no learnings", not crash downstream .filter() calls.
      return Array.isArray(parsed) ? (parsed as Learning[]) : [];
    } catch {
      return [];
    }
  }

  async getRelevantLearnings(
    repo: string,
    filenames: string[],
  ): Promise<Learning[]> {
    // Cross-repo (global) learnings apply to every repo; merge them ahead of
    // the per-repo set so they read first in the prompt. When no global file
    // exists this is a no-op and behaviour is identical to a repo-only store.
    const [repoLearnings, globalLearnings] = await Promise.all([
      this.getLearnings(repo),
      this.getGlobalLearnings(),
    ]);
    const all = [...globalLearnings, ...repoLearnings];

    return all.filter((learning) => {
      // Path-less learnings (repo-wide or truly global) are always relevant
      if (!learning.path) return true;

      // Path-scoped learnings match if their glob matches any reviewed file
      return filenames.some((filename) =>
        minimatch(filename, learning.path!, { matchBase: true }),
      );
    });
  }

  async removeLearning(repo: string, id: string): Promise<boolean> {
    const learnings = await this.getLearnings(repo);
    const filtered = learnings.filter((l) => l.id !== id);

    if (filtered.length === learnings.length) return false;

    await this.writeLearnings(repo, filtered);
    return true;
  }

  async updateLearning(
    repo: string,
    id: string,
    patch: { content?: string; path?: string | null },
  ): Promise<Learning | null> {
    const learnings = await this.getLearnings(repo);
    const idx = learnings.findIndex((l) => l.id === id);
    if (idx < 0) return null;

    learnings[idx] = applyPatch(learnings[idx], patch);
    await this.writeLearnings(repo, learnings);
    return learnings[idx];
  }

  // ─── Global (cross-repo) learnings ────────────────────────────────
  // Stored in a single flat file at the store root and consumed by every
  // review via getRelevantLearnings. Mirror the per-repo API one-for-one.

  async getGlobalLearnings(): Promise<Learning[]> {
    try {
      const data = await fs.readFile(this.globalFilePath(), "utf-8");
      const parsed = JSON.parse(data);
      return Array.isArray(parsed) ? (parsed as Learning[]) : [];
    } catch {
      return [];
    }
  }

  async addGlobalLearning(content: string, filePath?: string, origin?: LearningOrigin): Promise<Learning> {
    const learning: Learning = {
      id: crypto.randomUUID(),
      repo: GLOBAL_REPO,
      content,
      createdAt: new Date().toISOString(),
      path: filePath,
      ...compactOrigin(origin),
    };
    const learnings = await this.getGlobalLearnings();
    learnings.push(learning);
    await this.writeGlobalLearnings(learnings);
    return learning;
  }

  async removeGlobalLearning(id: string): Promise<boolean> {
    const learnings = await this.getGlobalLearnings();
    const filtered = learnings.filter((l) => l.id !== id);
    if (filtered.length === learnings.length) return false;
    await this.writeGlobalLearnings(filtered);
    return true;
  }

  async updateGlobalLearning(
    id: string,
    patch: { content?: string; path?: string | null },
  ): Promise<Learning | null> {
    const learnings = await this.getGlobalLearnings();
    const idx = learnings.findIndex((l) => l.id === id);
    if (idx < 0) return null;
    learnings[idx] = applyPatch(learnings[idx], patch);
    await this.writeGlobalLearnings(learnings);
    return learnings[idx];
  }

  /**
   * Move a per-repo learning into the global set. The repo entry is removed and
   * a fresh global entry (new id + timestamp) is created with the same content
   * and path. Returns the new global learning, or null if the source is gone.
   *
   * Provenance travels with it. Widening a learning's scope is exactly the
   * moment it most needs to stay traceable — it now speaks for every repo, and
   * it is answerable to the same conversation it always was.
   */
  async promoteToGlobal(repo: string, id: string): Promise<Learning | null> {
    const learnings = await this.getLearnings(repo);
    const idx = learnings.findIndex((l) => l.id === id);
    if (idx < 0) return null;
    const [src] = learnings.splice(idx, 1);
    await this.writeLearnings(repo, learnings);
    return this.addGlobalLearning(src.content, src.path, {
      author: src.author,
      prNumber: src.prNumber,
      // The repo the note was left on. `repo` on a global learning is the "*"
      // sentinel, so without this the trail back to the PR is broken.
      sourceFile: src.sourceFile,
      sourceRepo: src.sourceRepo ?? src.repo,
    });
  }

  /**
   * Enumerate every per-repo learning file under the store root. Best-effort:
   * a missing root or unreadable directory yields an empty list rather than
   * throwing. The global file at the root is skipped (it isn't an owner dir).
   */
  async listAllRepos(): Promise<{ owner: string; repo: string; learnings: Learning[] }[]> {
    let owners: import("fs").Dirent[];
    try {
      owners = await fs.readdir(this.baseDir, { withFileTypes: true });
    } catch {
      return [];
    }
    const out: { owner: string; repo: string; learnings: Learning[] }[] = [];
    for (const owner of owners) {
      if (!owner.isDirectory()) continue;
      let files: string[];
      try {
        files = await fs.readdir(path.join(this.baseDir, owner.name));
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        const repo = file.slice(0, -".json".length);
        const learnings = await this.getLearnings(`${owner.name}/${repo}`);
        if (learnings.length > 0) out.push({ owner: owner.name, repo, learnings });
      }
    }
    return out;
  }

  private async writeGlobalLearnings(learnings: Learning[]): Promise<void> {
    const fp = this.globalFilePath();
    await fs.mkdir(path.dirname(fp), { recursive: true });
    await fs.writeFile(fp, JSON.stringify(learnings, null, 2), "utf-8");
  }

  formatForPrompt(learnings: Learning[]): string {
    if (learnings.length === 0) return "";

    const items = learnings
      .map((l, i) => `${i + 1}. ${l.content}`)
      .join("\n");

    return `## Repository Learnings\n\nThe team has provided these preferences:\n${items}`;
  }

  private async writeLearnings(
    repo: string,
    learnings: Learning[],
  ): Promise<void> {
    const fp = this.filePath(repo);
    await fs.mkdir(path.dirname(fp), { recursive: true });
    await fs.writeFile(fp, JSON.stringify(learnings, null, 2), "utf-8");
  }
}

// ─── Synthesis ────────────────────────────────────────────────────

export interface FindingContext {
  /** File path the parent finding lives on (when known). */
  file?: string;
  /** Markdown body of the bot finding the user replied to. */
  findingBody?: string;
  /** Best-effort title pulled from the finding body. */
  findingTitle?: string;
  /** Detected rule id if we can pull one out (e.g. "onclick-non-interactive"). */
  rule?: string;
  // ─── Provenance ──────────────────────────────────────────────
  // Carried alongside the synthesis inputs because this walk is the only place
  // that reads the thread, and a second fetch to answer "who said this, where"
  // would cost an API call to learn what we already had in hand.
  /** Login of the maintainer whose note triggered the learning. */
  noteAuthor?: string;
  /** Where the bot finding sat, as `path:line` or `path:start-end`. */
  findingLocation?: string;
}

export interface SynthesizedLearning {
  content: string;
  path?: string;
}

/**
 * Where a review comment sits, as the `File:` line of a learning's provenance:
 * `path:line`, or `path:start-end` when the finding spans a range.
 *
 * The range form matters more than it looks. A learning taught against a
 * multi-line finding is usually about the shape of that whole block, and a
 * reader sent to its first line alone has to guess how far the point extends.
 */
export function formatFindingLocation(
  path: string | null | undefined,
  startLine: number | null | undefined,
  line: number | null | undefined,
): string | undefined {
  if (!path) return undefined;
  if (typeof line !== "number") return path;
  if (typeof startLine === "number" && startLine !== line) return `${path}:${startLine}-${line}`;
  return `${path}:${line}`;
}

const SYNTHESIS_SYSTEM = `You convert a maintainer's short reaction to a code-review finding into a durable "learning" that an AI code reviewer should obey on future PRs.

The maintainer is replying to a specific finding. Their note is short and may be terse ("not relevant", "we always do X here"). Your job is to turn that into a self-contained instruction the reviewer can apply later, even when this PR is forgotten.

Output STRICT JSON: {"content": string, "path": string | null}.

- "content": one or two sentences, imperative voice, naming the rule/category being suppressed or the convention being asserted. Include enough about WHY so future-you can decide whether the learning still applies. NEVER quote the maintainer verbatim — synthesize.
- "path": DEFAULT TO null (repo-wide). Only set a glob when the maintainer's NOTE itself explicitly names a path, directory, or file family (e.g., "in the sales-app", "for *.test.ts files", "only in static/"). The fact that the finding happens to live on a particular file is NOT evidence the rule is path-scoped — most "not relevant" / "we always do X" notes describe a repo-wide convention. When in doubt, return null. If you do set a glob, prefer the broadest reasonable scope (a directory's "**" rather than a single file path) so future PRs touching siblings still match.

Do not invent rules the maintainer didn't endorse. If their note is ambiguous, capture the conservative interpretation and say so.`;

export async function synthesizeLearning(
  ai: AIProvider,
  rawNote: string,
  finding: FindingContext,
): Promise<SynthesizedLearning> {
  const fallback: SynthesizedLearning = { content: rawNote.trim() };
  if (!rawNote.trim()) return fallback;

  const findingBlock = [
    finding.findingTitle ? `Title: ${finding.findingTitle}` : "",
    finding.rule ? `Rule: ${finding.rule}` : "",
    finding.file ? `File: ${finding.file}` : "",
    finding.findingBody ? `Body:\n${finding.findingBody}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const user = `Maintainer note: """${rawNote.trim()}"""\n\nFinding the note replied to:\n${findingBlock || "(no finding context — treat as a repo-wide note)"}`;

  try {
    const raw = await ai.complete(SYNTHESIS_SYSTEM, user, { json: true, maxTokens: 400 });
    const parsed = parseSynthesisJSON(raw);
    if (!parsed) return fallback;
    return parsed;
  } catch (err) {
    logger.warn({ err }, "Learning synthesis failed; falling back to raw note");
    return fallback;
  }
}

function parseSynthesisJSON(raw: string): SynthesizedLearning | null {
  if (!raw) return null;
  // Strip ```json fences if any provider wrapped it.
  const cleaned = stripFences(raw);
  try {
    const obj = JSON.parse(cleaned) as { content?: unknown; path?: unknown };
    const content = typeof obj.content === "string" ? obj.content.trim() : "";
    if (!content) return null;
    const out: SynthesizedLearning = { content };
    if (typeof obj.path === "string" && obj.path.trim().length > 0) {
      out.path = obj.path.trim();
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * Pull the rule slug + title out of a DiffSentry finding body. Best-effort —
 * returns whatever it can find without throwing.
 */
export function extractFindingMeta(body: string | undefined | null): {
  title?: string;
  rule?: string;
} {
  if (!body) return {};
  const out: { title?: string; rule?: string } = {};

  // Title is usually the first bold line after the severity badges.
  const titleMatch = body.match(/^\s*\*\*([^*\n]+)\*\*\s*$/m);
  if (titleMatch) out.title = titleMatch[1].trim();

  // Rule slug appears as `rule:xxx` or via the pattern footer.
  const ruleMatch =
    body.match(/`rule:([a-z0-9][a-z0-9_-]*)`/i) ||
    body.match(/built-in pattern check[^\n]*?`reviews\.([a-z0-9_.-]+)`/i);
  if (ruleMatch) out.rule = ruleMatch[1];

  return out;
}
