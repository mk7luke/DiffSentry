import type { Request, Response, Router } from "express";
import { minimatch } from "minimatch";
import type { Role } from "../dashboard/roles.js";
import { getActor, type Actor } from "../dashboard/roles.js";
import type { CsrfRuntime } from "../dashboard/auth.js";
import type { LearningsStore } from "../learnings.js";
import type { Learning } from "../types.js";
import { insertAuditLog } from "../storage/dao.js";
import { bus } from "../realtime/bus.js";
import { logger } from "../logger.js";

// ─────────────────────────────────────────────────────────────────────────────
// Learnings management — CRUD over the @bot learnings the reviewer consumes.
//
// Storage stays in the JSON files owned by LearningsStore (the engine reads the
// same files at review time), so every write here lands in a format reviews
// still understand. Global learnings live in a single root file and apply to
// every repo via getRelevantLearnings.
//
// Each mutating endpoint follows the command-center write contract, identical
// to /roles and the PR command actions: requireRole('author') + CSRF verify,
// then an audit_log row + a 'learning.changed' bus event for live dashboards.
// ─────────────────────────────────────────────────────────────────────────────

export interface LearningDeps {
  learnings: LearningsStore;
  requireRole: (role: Role) => import("express").RequestHandler;
  csrf: CsrfRuntime;
}

// Explicit param shapes so req.params.* is `string` (Express 5's default
// generic widens to string | string[]), mirroring actions.ts.
type IdParams = { id: string };
type RepoParams = { owner: string; repo: string };
type RepoIdParams = { owner: string; repo: string; id: string };

type ErrorCode = "forbidden" | "not_found" | "bad_request" | "internal";

function sendData(res: Response, data: unknown, status = 200): void {
  res.status(status).json({ data });
}

function sendError(res: Response, status: number, code: ErrorCode, message: string): void {
  res.status(status).json({ error: { code, message } });
}

// owner/repo path segments are interpolated into a filesystem path by the
// store, so constrain them to the GitHub-legal character set and reject the
// directory-traversal specials before they ever reach path.join.
const SEGMENT_RE = /^[A-Za-z0-9._-]+$/;
function validSegment(s: string): boolean {
  return SEGMENT_RE.test(s) && s !== "." && s !== "..";
}

const MAX_CONTENT = 4000;
const MAX_PATH = 500;
const MAX_BULK = 200;

/** Validate + normalize a {content, path} write body. Returns an error string
 * (for a 400) or the cleaned fields. `content` is required unless `partial`. */
function parseBody(
  body: unknown,
  opts: { partial?: boolean } = {},
): { error: string } | { content?: string; path?: string | null } {
  const b = (body ?? {}) as Record<string, unknown>;
  const out: { content?: string; path?: string | null } = {};

  if (b.content !== undefined) {
    if (typeof b.content !== "string" || b.content.trim().length === 0) {
      return { error: "'content' must be a non-empty string." };
    }
    if (b.content.length > MAX_CONTENT) {
      return { error: `'content' must be at most ${MAX_CONTENT} characters.` };
    }
    out.content = b.content.trim();
  } else if (!opts.partial) {
    return { error: "'content' is required." };
  }

  if (b.path !== undefined && b.path !== null) {
    if (typeof b.path !== "string") return { error: "'path' must be a string or null." };
    if (b.path.length > MAX_PATH) return { error: `'path' must be at most ${MAX_PATH} characters.` };
    out.path = b.path.trim();
  } else if (b.path === null) {
    out.path = null;
  }

  return out;
}

interface ChangeMeta {
  scope: "global" | "repo";
  owner?: string;
  repo?: string;
  action: string;
  id?: string;
  count?: number;
}

/** Audit-log + bus-publish a completed learning change. Best-effort. */
function recordChange(actor: Actor | null, meta: ChangeMeta): void {
  insertAuditLog({
    actorLogin: actor?.login ?? null,
    actorRole: actor?.role ?? null,
    action: `learning.${meta.action}`,
    targetType: "learning",
    targetRef: meta.scope === "global" ? "global" : `${meta.owner}/${meta.repo}`,
    payload: { id: meta.id, count: meta.count },
    result: "ok",
  });
  bus.publish("learning.changed", {
    scope: meta.scope,
    owner: meta.owner,
    repo: meta.repo,
    action: meta.action,
    id: meta.id,
    count: meta.count,
    actor: actor?.login ?? null,
    role: actor?.role ?? null,
  });
}

// ─── Dedupe suggestions ──────────────────────────────────────────────────────
// Group near-identical learnings (Jaccard token overlap ≥ threshold) so the UI
// can suggest merges. Deterministic greedy clustering over a flat, ordered list.

export interface FlatLearning {
  scope: "global" | "repo";
  owner?: string;
  repo?: string;
  id: string;
  content: string;
  path?: string;
}

export interface DuplicateGroup {
  members: FlatLearning[];
}

const DUP_THRESHOLD = 0.8;

function tokenize(content: string): Set<string> {
  return new Set(
    content
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .split(" ")
      .filter(Boolean),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function computeDuplicates(flat: FlatLearning[]): DuplicateGroup[] {
  const tokens = flat.map((f) => tokenize(f.content));
  const used = new Array<boolean>(flat.length).fill(false);
  const groups: DuplicateGroup[] = [];
  for (let i = 0; i < flat.length; i += 1) {
    if (used[i]) continue;
    const members: FlatLearning[] = [flat[i]];
    used[i] = true;
    for (let j = i + 1; j < flat.length; j += 1) {
      if (used[j]) continue;
      if (jaccard(tokens[i], tokens[j]) >= DUP_THRESHOLD) {
        members.push(flat[j]);
        used[j] = true;
      }
    }
    if (members.length > 1) groups.push({ members });
  }
  return groups;
}

function flatten(global: Learning[], repos: { owner: string; repo: string; learnings: Learning[] }[]): FlatLearning[] {
  const out: FlatLearning[] = [];
  for (const l of global) out.push({ scope: "global", id: l.id, content: l.content, path: l.path });
  for (const r of repos) {
    for (const l of r.learnings) {
      out.push({ scope: "repo", owner: r.owner, repo: r.repo, id: l.id, content: l.content, path: l.path });
    }
  }
  return out;
}

/**
 * Register the learnings management endpoints on the API router. Reads are
 * open to any authenticated role; writes are author+ with CSRF. Must be called
 * before the router's catch-all 404.
 */
export function registerLearningRoutes(router: Router, deps: LearningDeps): void {
  const { learnings, requireRole, csrf } = deps;
  const author = requireRole("author");
  // Reads require an authenticated user (viewer floor). When auth is enabled the
  // router's auth gate already 401s anon requests; this makes the role contract
  // explicit per-route and resolves req.dsActor for handlers.
  const viewer = requireRole("viewer");

  // ── List everything (global + per-repo) + dedupe suggestions ────────
  router.get("/learnings", viewer, async (_req: Request, res: Response) => {
    try {
      const [global, repos] = await Promise.all([learnings.getGlobalLearnings(), learnings.listAllRepos()]);
      const duplicates = computeDuplicates(flatten(global, repos));
      sendData(res, { global, repos, duplicates });
    } catch (err) {
      logger.error({ err }, "api GET /learnings failed");
      sendError(res, 500, "internal", "Failed to load learnings.");
    }
  });

  // ── Test a file path against the learnings that would apply ─────────
  // Read-only (viewer floor, no CSRF — it mutates nothing): mirrors the engine's
  // getRelevantLearnings selection for a single filename.
  router.post("/learnings/test", viewer, async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const filePath = typeof body.path === "string" ? body.path.trim() : "";
    const owner = typeof body.owner === "string" ? body.owner.trim() : "";
    const repo = typeof body.repo === "string" ? body.repo.trim() : "";
    if (!filePath) {
      sendError(res, 400, "bad_request", "A non-empty 'path' (file path to test) is required.");
      return;
    }
    if ((owner || repo) && !(validSegment(owner) && validSegment(repo))) {
      sendError(res, 400, "bad_request", "Invalid owner/repo.");
      return;
    }
    try {
      const [global, repoLearnings] = await Promise.all([
        learnings.getGlobalLearnings(),
        owner && repo ? learnings.getLearnings(`${owner}/${repo}`) : Promise.resolve([]),
      ]);
      const matched = [...global, ...repoLearnings].filter(
        (l) => !l.path || minimatch(filePath, l.path, { matchBase: true }),
      );
      sendData(res, { path: filePath, matched });
    } catch (err) {
      logger.error({ err }, "api POST /learnings/test failed");
      sendError(res, 500, "internal", "Failed to test path.");
    }
  });

  // ── Bulk delete across scopes ───────────────────────────────────────
  router.post("/learnings/bulk-delete", author, csrf.verify, async (req: Request, res: Response) => {
    const actor = getActor(req);
    const items = (req.body as { items?: unknown } | undefined)?.items;
    if (!Array.isArray(items) || items.length === 0) {
      sendError(res, 400, "bad_request", "'items' must be a non-empty array.");
      return;
    }
    if (items.length > MAX_BULK) {
      sendError(res, 400, "bad_request", `At most ${MAX_BULK} items may be deleted at once.`);
      return;
    }
    try {
      let deleted = 0;
      for (const raw of items as Array<Record<string, unknown>>) {
        const id = typeof raw?.id === "string" ? raw.id : "";
        if (!id) continue;
        if (raw.scope === "global") {
          if (await learnings.removeGlobalLearning(id)) deleted += 1;
        } else {
          const owner = typeof raw.owner === "string" ? raw.owner : "";
          const repo = typeof raw.repo === "string" ? raw.repo : "";
          if (!validSegment(owner) || !validSegment(repo)) continue;
          if (await learnings.removeLearning(`${owner}/${repo}`, id)) deleted += 1;
        }
      }
      recordChange(actor, { scope: "global", action: "bulk_delete", count: deleted });
      sendData(res, { deleted });
    } catch (err) {
      logger.error({ err }, "api POST /learnings/bulk-delete failed");
      sendError(res, 500, "internal", "Failed to delete learnings.");
    }
  });

  // ── Global create / update / delete ─────────────────────────────────
  router.post("/learnings/global", author, csrf.verify, async (req: Request, res: Response) => {
    const actor = getActor(req);
    const parsed = parseBody(req.body);
    if ("error" in parsed) {
      sendError(res, 400, "bad_request", parsed.error);
      return;
    }
    try {
      const created = await learnings.addGlobalLearning(parsed.content!, parsed.path ?? undefined);
      recordChange(actor, { scope: "global", action: "create", id: created.id });
      sendData(res, created, 201);
    } catch (err) {
      logger.error({ err }, "api POST /learnings/global failed");
      sendError(res, 500, "internal", "Failed to create global learning.");
    }
  });

  router.put("/learnings/global/:id", author, csrf.verify, async (req: Request<IdParams>, res: Response) => {
    const actor = getActor(req);
    const parsed = parseBody(req.body, { partial: true });
    if ("error" in parsed) {
      sendError(res, 400, "bad_request", parsed.error);
      return;
    }
    try {
      const updated = await learnings.updateGlobalLearning(req.params.id, parsed);
      if (!updated) {
        sendError(res, 404, "not_found", "No such global learning.");
        return;
      }
      recordChange(actor, { scope: "global", action: "update", id: updated.id });
      sendData(res, updated);
    } catch (err) {
      logger.error({ err }, "api PUT /learnings/global/:id failed");
      sendError(res, 500, "internal", "Failed to update global learning.");
    }
  });

  router.delete("/learnings/global/:id", author, csrf.verify, async (req: Request<IdParams>, res: Response) => {
    const actor = getActor(req);
    try {
      const ok = await learnings.removeGlobalLearning(req.params.id);
      if (!ok) {
        sendError(res, 404, "not_found", "No such global learning.");
        return;
      }
      recordChange(actor, { scope: "global", action: "delete", id: req.params.id });
      sendData(res, { id: req.params.id, deleted: true });
    } catch (err) {
      logger.error({ err }, "api DELETE /learnings/global/:id failed");
      sendError(res, 500, "internal", "Failed to delete global learning.");
    }
  });

  // ── Per-repo create / update / delete / promote ─────────────────────
  const repoBase = "/repos/:owner/:repo/learnings";

  router.post(repoBase, author, csrf.verify, async (req: Request<RepoParams>, res: Response) => {
    const { owner, repo } = req.params;
    if (!validSegment(owner) || !validSegment(repo)) {
      sendError(res, 400, "bad_request", "Invalid owner/repo.");
      return;
    }
    const actor = getActor(req);
    const parsed = parseBody(req.body);
    if ("error" in parsed) {
      sendError(res, 400, "bad_request", parsed.error);
      return;
    }
    try {
      const created = await learnings.addLearning(`${owner}/${repo}`, parsed.content!, parsed.path ?? undefined);
      recordChange(actor, { scope: "repo", owner, repo, action: "create", id: created.id });
      sendData(res, created, 201);
    } catch (err) {
      logger.error({ err, owner, repo }, "api POST repo learning failed");
      sendError(res, 500, "internal", "Failed to create learning.");
    }
  });

  router.put(`${repoBase}/:id`, author, csrf.verify, async (req: Request<RepoIdParams>, res: Response) => {
    const { owner, repo, id } = req.params;
    if (!validSegment(owner) || !validSegment(repo)) {
      sendError(res, 400, "bad_request", "Invalid owner/repo.");
      return;
    }
    const actor = getActor(req);
    const parsed = parseBody(req.body, { partial: true });
    if ("error" in parsed) {
      sendError(res, 400, "bad_request", parsed.error);
      return;
    }
    try {
      const updated = await learnings.updateLearning(`${owner}/${repo}`, id, parsed);
      if (!updated) {
        sendError(res, 404, "not_found", "No such learning.");
        return;
      }
      recordChange(actor, { scope: "repo", owner, repo, action: "update", id: updated.id });
      sendData(res, updated);
    } catch (err) {
      logger.error({ err, owner, repo }, "api PUT repo learning failed");
      sendError(res, 500, "internal", "Failed to update learning.");
    }
  });

  router.delete(`${repoBase}/:id`, author, csrf.verify, async (req: Request<RepoIdParams>, res: Response) => {
    const { owner, repo, id } = req.params;
    if (!validSegment(owner) || !validSegment(repo)) {
      sendError(res, 400, "bad_request", "Invalid owner/repo.");
      return;
    }
    const actor = getActor(req);
    try {
      const ok = await learnings.removeLearning(`${owner}/${repo}`, id);
      if (!ok) {
        sendError(res, 404, "not_found", "No such learning.");
        return;
      }
      recordChange(actor, { scope: "repo", owner, repo, action: "delete", id });
      sendData(res, { id, deleted: true });
    } catch (err) {
      logger.error({ err, owner, repo }, "api DELETE repo learning failed");
      sendError(res, 500, "internal", "Failed to delete learning.");
    }
  });

  router.post(`${repoBase}/:id/promote`, author, csrf.verify, async (req: Request<RepoIdParams>, res: Response) => {
    const { owner, repo, id } = req.params;
    if (!validSegment(owner) || !validSegment(repo)) {
      sendError(res, 400, "bad_request", "Invalid owner/repo.");
      return;
    }
    const actor = getActor(req);
    try {
      const promoted = await learnings.promoteToGlobal(`${owner}/${repo}`, id);
      if (!promoted) {
        sendError(res, 404, "not_found", "No such learning.");
        return;
      }
      // One change touched both stores; record against the new global entry.
      recordChange(actor, { scope: "global", owner, repo, action: "promote", id: promoted.id });
      sendData(res, promoted);
    } catch (err) {
      logger.error({ err, owner, repo }, "api POST promote learning failed");
      sendError(res, 500, "internal", "Failed to promote learning.");
    }
  });
}
