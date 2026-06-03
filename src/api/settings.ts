import type { Request, Response, Router } from "express";
import type { Role } from "../dashboard/roles.js";
import { getActor } from "../dashboard/roles.js";
import type { CsrfRuntime } from "../dashboard/auth.js";
import { repoExists } from "../dashboard/queries.js";
import { insertAuditLog, upsertSettingOverride, deleteSettingOverride } from "../storage/dao.js";
import { bus } from "../realtime/bus.js";
import { logger } from "../logger.js";
import {
  GLOBAL_SCOPE,
  GLOBAL_SETTING_DEFS,
  REPO_SETTING_DEFS,
  getGlobalSettings,
  getRepoSettings,
  repoScope,
  type SettingDef,
} from "../settings/overrides.js";

// ─────────────────────────────────────────────────────────────────────────────
// Settings (operator controls) — global + per-repo overrides.
//
// GET  /settings                         resolved global settings
// PUT  /settings                         set/clear global overrides   (admin)
// GET  /repos/:owner/:repo/settings      resolved per-repo overrides
// PUT  /repos/:owner/:repo/settings      set/clear per-repo overrides (admin)
//
// Every write follows the command-center contract: requireRole('admin') BEFORE
// csrf.verify, then an audit_log row + a 'settings.changed' bus event per key.
// Writes are validated atomically — if any field is invalid the whole PUT is
// rejected 400 and nothing is persisted.
// ─────────────────────────────────────────────────────────────────────────────

export interface SettingsDeps {
  requireRole: (role: Role) => import("express").RequestHandler;
  csrf: CsrfRuntime;
}

type ErrorCode = "forbidden" | "not_found" | "bad_request" | "internal";

function sendData(res: Response, data: unknown, status = 200): void {
  res.status(status).json({ data });
}
function sendError(res: Response, status: number, code: ErrorCode, message: string): void {
  res.status(status).json({ error: { code, message } });
}

/** A single validated change to apply: set a value, or clear (value === CLEAR). */
const CLEAR = Symbol("clear");
interface PlannedChange {
  key: string;
  /** The new value, or the CLEAR sentinel when the override is being removed. */
  value: unknown | typeof CLEAR;
  apply?: (value: unknown) => void;
}

/**
 * Validate a PUT body against a set of setting defs. Only keys present in the
 * body are considered. Returns either the planned changes or the field errors.
 */
function planChanges(
  body: Record<string, unknown>,
  defs: readonly SettingDef[],
): { ok: true; changes: PlannedChange[] } | { ok: false; errors: string[] } {
  const byKey = new Map(defs.map((d) => [d.key, d]));
  const changes: PlannedChange[] = [];
  const errors: string[] = [];

  for (const [key, raw] of Object.entries(body)) {
    const def = byKey.get(key);
    if (!def) {
      errors.push(`'${key}' is not a settable key`);
      continue;
    }
    if (raw === null) {
      if (!def.nullable) {
        errors.push(`'${key}' cannot be cleared`);
        continue;
      }
      changes.push({ key, value: CLEAR, apply: def.apply });
      continue;
    }
    const verdict = def.validate(raw);
    if (!verdict.ok) {
      errors.push(`'${key}' ${verdict.message}`);
      continue;
    }
    changes.push({ key, value: verdict.value, apply: def.apply });
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, changes };
}

/** Apply the planned changes to one scope, auditing + emitting each. */
function applyChanges(
  scope: string,
  changes: PlannedChange[],
  actor: { login: string | null; role: string | null },
): void {
  for (const c of changes) {
    const clearing = c.value === CLEAR;
    const value = clearing ? null : c.value;
    if (clearing) {
      deleteSettingOverride(scope, c.key);
    } else {
      upsertSettingOverride({ scope, key: c.key, value, updatedBy: actor.login });
    }
    // Runtime side effect (e.g. log level). On set, apply the new value; on
    // clear, re-resolve the effective value now that the override is gone (read
    // from getGlobalSettings — the only keys with a side effect are global) so
    // the runtime reverts to the default immediately rather than on restart.
    if (c.apply) {
      try {
        const effective = clearing ? (getGlobalSettings() as unknown as Record<string, unknown>)[c.key] : value;
        c.apply(effective);
      } catch (err) {
        logger.debug({ err, key: c.key }, "settings: apply side effect failed");
      }
    }
    insertAuditLog({
      actorLogin: actor.login,
      actorRole: actor.role,
      action: clearing ? "settings.clear" : "settings.set",
      targetType: "setting",
      targetRef: `${scope}:${c.key}`,
      payload: { value },
      result: "ok",
    });
    bus.publish("settings.changed", { scope, key: c.key, value, actor: actor.login });
  }
}

export function registerSettingsRoutes(router: Router, deps: SettingsDeps): void {
  const { requireRole, csrf } = deps;
  const admin = requireRole("admin");

  // ── Global ──────────────────────────────────────────────────────────
  router.get("/settings", admin, (_req: Request, res: Response) => {
    try {
      sendData(res, { settings: getGlobalSettings() });
    } catch (err) {
      logger.error({ err }, "api GET /settings failed");
      sendError(res, 500, "internal", "Failed to load settings.");
    }
  });

  router.put("/settings", admin, csrf.verify, (req: Request, res: Response) => {
    const actor = getActor(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      sendError(res, 400, "bad_request", "Body must be a JSON object of setting keys.");
      return;
    }
    const planned = planChanges(body, GLOBAL_SETTING_DEFS);
    if (!planned.ok) {
      sendError(res, 400, "bad_request", planned.errors.join("; "));
      return;
    }
    try {
      applyChanges(GLOBAL_SCOPE, planned.changes, {
        login: actor?.login ?? null,
        role: actor?.role ?? null,
      });
      sendData(res, { settings: getGlobalSettings() });
    } catch (err) {
      logger.error({ err }, "api PUT /settings failed");
      sendError(res, 500, "internal", "Failed to update settings.");
    }
  });

  // ── Per-repo ────────────────────────────────────────────────────────
  router.get("/repos/:owner/:repo/settings", admin, (req: Request, res: Response) => {
    const { owner, repo } = req.params as { owner: string; repo: string };
    try {
      // Match the PUT handler: unknown repos 404 rather than looking like a
      // valid managed repo with inherited defaults.
      if (!repoExists(owner, repo)) {
        sendError(res, 404, "not_found", `No data for ${owner}/${repo}.`);
        return;
      }
      sendData(res, { owner, repo, settings: getRepoSettings(owner, repo) });
    } catch (err) {
      logger.error({ err, owner, repo }, "api GET repo settings failed");
      sendError(res, 500, "internal", "Failed to load repo settings.");
    }
  });

  router.put("/repos/:owner/:repo/settings", admin, csrf.verify, (req: Request, res: Response) => {
    const { owner, repo } = req.params as { owner: string; repo: string };
    const actor = getActor(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      sendError(res, 400, "bad_request", "Body must be a JSON object of setting keys.");
      return;
    }
    // Reject overrides for repos we've never seen — a typo'd scope would write
    // a row no review path ever reads. When persistence is disabled repoExists
    // is false (there are no managed repos at all), so this 404s rather than
    // silently writing an override that can't persist.
    if (!repoExists(owner, repo)) {
      sendError(res, 404, "not_found", `No data for ${owner}/${repo}.`);
      return;
    }
    const planned = planChanges(body, REPO_SETTING_DEFS);
    if (!planned.ok) {
      sendError(res, 400, "bad_request", planned.errors.join("; "));
      return;
    }
    try {
      applyChanges(repoScope(owner, repo), planned.changes, {
        login: actor?.login ?? null,
        role: actor?.role ?? null,
      });
      sendData(res, { owner, repo, settings: getRepoSettings(owner, repo) });
    } catch (err) {
      logger.error({ err, owner, repo }, "api PUT repo settings failed");
      sendError(res, 500, "internal", "Failed to update repo settings.");
    }
  });
}
