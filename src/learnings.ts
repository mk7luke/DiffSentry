import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { minimatch } from "minimatch";
import { AIProvider, Learning } from "./types.js";
import { logger } from "./logger.js";

export class LearningsStore {
  private baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  private filePath(repo: string): string {
    // repo is "owner/name" → store as {baseDir}/owner/name.json
    const [owner, name] = repo.split("/");
    return path.join(this.baseDir, owner, `${name}.json`);
  }

  async addLearning(
    repo: string,
    content: string,
    filePath?: string,
  ): Promise<Learning> {
    const learning: Learning = {
      id: crypto.randomUUID(),
      repo,
      content,
      createdAt: new Date().toISOString(),
      path: filePath,
    };

    const learnings = await this.getLearnings(repo);
    learnings.push(learning);
    await this.writeLearnings(repo, learnings);

    return learning;
  }

  async getLearnings(repo: string): Promise<Learning[]> {
    const fp = this.filePath(repo);
    try {
      const data = await fs.readFile(fp, "utf-8");
      return JSON.parse(data) as Learning[];
    } catch {
      return [];
    }
  }

  async getRelevantLearnings(
    repo: string,
    filenames: string[],
  ): Promise<Learning[]> {
    const all = await this.getLearnings(repo);

    return all.filter((learning) => {
      // Global learnings (no path) are always relevant
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

    const current = learnings[idx];
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

    learnings[idx] = next;
    await this.writeLearnings(repo, learnings);
    return next;
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
}

export interface SynthesizedLearning {
  content: string;
  path?: string;
}

const SYNTHESIS_SYSTEM = `You convert a maintainer's short reaction to a code-review finding into a durable "learning" that an AI code reviewer should obey on future PRs.

The maintainer is replying to a specific finding. Their note is short and may be terse ("not relevant", "we always do X here"). Your job is to turn that into a self-contained instruction the reviewer can apply later, even when this PR is forgotten.

Output STRICT JSON: {"content": string, "path": string | null}.

- "content": one or two sentences, imperative voice, naming the rule/category being suppressed or the convention being asserted. Include enough about WHY so future-you can decide whether the learning still applies. NEVER quote the maintainer verbatim — synthesize.
- "path": a glob (e.g. "static/sales-app/**/*.js") if the maintainer's intent is clearly scoped to a directory or file family; otherwise null for repo-wide.

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
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
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
