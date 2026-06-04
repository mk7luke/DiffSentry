import type { Request, Response, Router } from "express";
import type { Role } from "../dashboard/roles.js";
import { getActor } from "../dashboard/roles.js";
import type { CsrfRuntime } from "../dashboard/auth.js";
import { getInstallationId } from "../dashboard/queries.js";
import { insertAuditLog } from "../storage/dao.js";
import { bus } from "../realtime/bus.js";
import { logger } from "../logger.js";

// ─────────────────────────────────────────────────────────────────────────────
// Command actions — the write side of the command center.
//
// Each endpoint is the same shape: requireRole('author') + CSRF verify, run the
// wrapped Reviewer action, write an audit_log row, and publish an
// 'action.performed' event on the bus (so connected dashboards see it live).
// The Reviewer itself additionally emits review.started/finished/failed.
//
// The Reviewer is injected as a narrow `ReviewerActions` surface (mirroring how
// getInstallationOctokit is passed to the router) rather than importing the
// Reviewer class — keeps the API layer decoupled and trivially testable.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The slice of Reviewer the command endpoints drive. Implemented by the real
 * Reviewer in server.ts; a fake is injected in the smoke test.
 */
export interface ReviewerActions {
  /** Run a review (full or incremental). Resolves when the review completes. */
  triggerReview(
    installationId: number,
    owner: string,
    repo: string,
    pullNumber: number,
    mode: "full" | "incremental",
  ): Promise<void>;
  /** Resolve all DiffSentry review threads on a PR. */
  resolveThreads(installationId: number, owner: string, repo: string, pullNumber: number): Promise<void>;
  /** Pause automatic + manual reviews for a PR. */
  pauseReviews(owner: string, repo: string, pullNumber: number): void;
  /** Resume reviews for a PR (and reset the auto-pause counter). */
  resumeReviews(owner: string, repo: string, pullNumber: number): void;
  /** Abort any in-flight review (handlePRClose semantics). */
  cancelReview(owner: string, repo: string, pullNumber: number): void;
  /** Run a chat command (synthesized "@bot <cmd>") through handleComment. */
  runCommand(installationId: number, owner: string, repo: string, pullNumber: number, command: string): Promise<void>;
}

/**
 * Chat commands the dashboard surfaces as buttons. Each maps a stable token
 * (sent in the request body) to the raw phrase parseCommand understands. The
 * allowlist is the trust boundary: only these run, so the endpoint can never be
 * used to inject an arbitrary "@bot …" free-text chat message.
 */
const COMMAND_PHRASES: Record<string, string> = {
  summary: "summary",
  tldr: "tldr",
  ship: "ship",
  changelog: "changelog",
  generate_tests: "generate tests",
  generate_docstrings: "generate docstrings",
};

export interface ActionDeps {
  reviewer: ReviewerActions;
  /** requireRole factory bound to the router's actor resolver. */
  requireRole: (role: Role) => import("express").RequestHandler;
  csrf: CsrfRuntime;
}

/** Route params shared by every PR command endpoint. Typing these explicitly
 * keeps req.params.* as `string` regardless of the Express default generics. */
type PrParams = { owner: string; repo: string; number: string };
type PrRequest = Request<PrParams>;

type ErrorCode = "forbidden" | "not_found" | "bad_request" | "internal";

function sendData(res: Response, data: unknown, status = 200): void {
  res.status(status).json({ data });
}

function sendError(res: Response, status: number, code: ErrorCode, message: string): void {
  res.status(status).json({ error: { code, message } });
}

function parsePrNumber(raw: string): number | null {
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

interface ActionContext {
  owner: string;
  repo: string;
  number: number;
  actorLogin: string | null;
  actorRole: string | null;
}

/** Audit-log + bus-publish a completed action. Best-effort; never throws. */
function recordAction(ctx: ActionContext, action: string, result: "ok" | "error", detail?: string): void {
  insertAuditLog({
    actorLogin: ctx.actorLogin,
    actorRole: ctx.actorRole,
    action: `pr.${action}`,
    targetType: "pr",
    targetRef: `${ctx.owner}/${ctx.repo}#${ctx.number}`,
    payload: detail ? { detail } : undefined,
    result,
  });
  bus.publish("action.performed", {
    owner: ctx.owner,
    repo: ctx.repo,
    number: ctx.number,
    action,
    actor: ctx.actorLogin,
    role: ctx.actorRole,
    result,
    detail,
  });
}

/**
 * Shared wrapper: resolve actor + PR number, run `fn`, then audit + publish.
 * `fn` returns an optional detail string (e.g. the review mode) for the audit
 * payload and the success response. Throwing inside `fn` is recorded as an
 * error action and surfaced as a 500.
 */
function handler(
  deps: ActionDeps,
  action: string,
  fn: (ctx: ActionContext, req: PrRequest) => Promise<string | void> | string | void,
) {
  return async (req: PrRequest, res: Response): Promise<void> => {
    const actor = getActor(req);
    const number = parsePrNumber(req.params.number);
    if (number == null) {
      sendError(res, 400, "bad_request", "Invalid PR number.");
      return;
    }
    const ctx: ActionContext = {
      owner: req.params.owner,
      repo: req.params.repo,
      number,
      actorLogin: actor?.login ?? null,
      actorRole: actor?.role ?? null,
    };
    try {
      const detail = (await fn(ctx, req)) || undefined;
      recordAction(ctx, action, "ok", detail);
      sendData(res, { owner: ctx.owner, repo: ctx.repo, number: ctx.number, action, result: "ok", detail });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err, action, ...ctx }, "command action failed");
      recordAction(ctx, action, "error", message);
      // A missing installation is the one expected, actionable failure.
      if (message === "no_installation") {
        sendError(res, 404, "not_found", `No installation on record for ${ctx.owner}/${ctx.repo}.`);
        return;
      }
      sendError(res, 500, "internal", `Action '${action}' failed.`);
    }
  };
}

/** Look up the installation id for a repo, or throw the sentinel "no_installation". */
function requireInstallation(owner: string, repo: string): number {
  const id = getInstallationId(owner, repo);
  if (id == null) throw new Error("no_installation");
  return id;
}

/**
 * Register the command (write) endpoints on the API router. All are mounted
 * under /api/v1 and gated author+ with CSRF.
 */
export function registerActionRoutes(router: Router, deps: ActionDeps): void {
  const { reviewer, requireRole, csrf } = deps;
  const author = requireRole("author");
  const base = "/repos/:owner/:repo/prs/:number";

  // ── Re-review (full | incremental) ──────────────────────────────────
  // Kicked off in the background like the webhook path: the response returns
  // 202 immediately and review.started/finished/failed arrive over SSE. The
  // audit row + action.performed are written at trigger time.
  router.post(
    `${base}/review`,
    author,
    csrf.verify,
    async (req: PrRequest, res: Response) => {
      const actor = getActor(req);
      const number = parsePrNumber(req.params.number);
      if (number == null) {
        sendError(res, 400, "bad_request", "Invalid PR number.");
        return;
      }
      const owner = req.params.owner;
      const repo = req.params.repo;
      const rawMode = (req.body as { mode?: unknown } | undefined)?.mode;
      const mode: "full" | "incremental" = rawMode === "full" ? "full" : "incremental";
      const ctx: ActionContext = {
        owner,
        repo,
        number,
        actorLogin: actor?.login ?? null,
        actorRole: actor?.role ?? null,
      };
      let installationId: number;
      try {
        installationId = requireInstallation(owner, repo);
      } catch {
        recordAction(ctx, "review", "error", "no_installation");
        sendError(res, 404, "not_found", `No installation on record for ${owner}/${repo}.`);
        return;
      }
      // Record the trigger now; the lifecycle events report completion.
      recordAction(ctx, "review", "ok", mode);
      sendData(res, { owner, repo, number, action: "review", result: "accepted", mode }, 202);
      // Fire-and-forget — the reviewer emits its own lifecycle events.
      reviewer.triggerReview(installationId, owner, repo, number, mode).catch((err) => {
        logger.error({ err, owner, repo, pr: number }, "command-triggered review failed");
      });
    },
  );

  // ── Resolve all review threads ──────────────────────────────────────
  router.post(
    `${base}/resolve`,
    author,
    csrf.verify,
    handler(deps, "resolve", async (ctx) => {
      const installationId = requireInstallation(ctx.owner, ctx.repo);
      await reviewer.resolveThreads(installationId, ctx.owner, ctx.repo, ctx.number);
    }),
  );

  // ── Pause / Resume (in-memory state, no installation needed) ─────────
  router.post(
    `${base}/pause`,
    author,
    csrf.verify,
    handler(deps, "pause", (ctx) => {
      reviewer.pauseReviews(ctx.owner, ctx.repo, ctx.number);
    }),
  );

  router.post(
    `${base}/resume`,
    author,
    csrf.verify,
    handler(deps, "resume", (ctx) => {
      reviewer.resumeReviews(ctx.owner, ctx.repo, ctx.number);
    }),
  );

  // ── Cancel in-flight review (handlePRClose semantics / abort) ────────
  router.post(
    `${base}/cancel`,
    author,
    csrf.verify,
    handler(deps, "cancel", (ctx) => {
      reviewer.cancelReview(ctx.owner, ctx.repo, ctx.number);
    }),
  );

  // ── Chat command (summary / tldr / ship / changelog / generate …) ────
  // Surfaces the existing "@bot <cmd>" commands as buttons. Like /review it
  // runs the AI in the background, so it answers 202 immediately; the audit row
  // + action.performed are written at trigger time, and the command's own
  // GitHub-side replies arrive asynchronously.
  router.post(
    `${base}/command`,
    author,
    csrf.verify,
    async (req: PrRequest, res: Response) => {
      const actor = getActor(req);
      const number = parsePrNumber(req.params.number);
      if (number == null) {
        sendError(res, 400, "bad_request", "Invalid PR number.");
        return;
      }
      const owner = req.params.owner;
      const repo = req.params.repo;
      const rawCommand = (req.body as { command?: unknown } | undefined)?.command;
      const token = typeof rawCommand === "string" ? rawCommand.trim().toLowerCase() : "";
      const phrase = COMMAND_PHRASES[token];
      if (!phrase) {
        sendError(res, 400, "bad_request", `Unknown command '${token || "(empty)"}'.`);
        return;
      }
      const ctx: ActionContext = {
        owner,
        repo,
        number,
        actorLogin: actor?.login ?? null,
        actorRole: actor?.role ?? null,
      };
      let installationId: number;
      try {
        installationId = requireInstallation(owner, repo);
      } catch {
        recordAction(ctx, "command", "error", "no_installation");
        sendError(res, 404, "not_found", `No installation on record for ${owner}/${repo}.`);
        return;
      }
      // Record the trigger now; the command performs its own GitHub-side work.
      recordAction(ctx, "command", "ok", token);
      sendData(res, { owner, repo, number, action: "command", result: "accepted", command: token }, 202);
      // Fire-and-forget — Promise.resolve().then(...) so a synchronous throw from
      // runCommand is funneled into the same .catch() as a rejected promise.
      Promise.resolve()
        .then(() => reviewer.runCommand(installationId, owner, repo, number, phrase))
        .catch((err) => {
          logger.error({ err, owner, repo, pr: number, command: token }, "command-triggered action failed");
        });
    },
  );
}
