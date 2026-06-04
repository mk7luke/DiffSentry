import type { Request, Response, Router } from "express";
import type { Role } from "../dashboard/roles.js";
import { getActor } from "../dashboard/roles.js";
import type { CsrfRuntime } from "../dashboard/auth.js";
import {
  CUSTOM_RULE_KINDS,
  CUSTOM_RULE_SEVERITIES,
  CUSTOM_RULE_TYPES,
  customRuleNameExists,
  type CustomRuleInput,
  deleteCustomRule,
  getCustomRule,
  insertAuditLog,
  insertCustomRule,
  updateCustomRule,
} from "../storage/dao.js";
import { listCustomRulesWithHits } from "../dashboard/queries.js";
import { testPattern, validatePattern } from "../pattern-checks.js";
import { bus } from "../realtime/bus.js";
import { logger } from "../logger.js";

// ─────────────────────────────────────────────────────────────────────────────
// Custom anti-pattern rules — the admin-authored side of the pattern engine.
//
// All endpoints are admin-gated (managing review config is an admin
// capability). Writes additionally CSRF-verify, write an audit_log row, and
// publish a `rule.changed` event so open dashboards refresh. The tester
// (/rules/test) is read-only — it compiles + runs a candidate rule against a
// pasted snippet without persisting anything.
// ─────────────────────────────────────────────────────────────────────────────

export interface RuleDeps {
  /** requireRole factory bound to the router's actor resolver. */
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

/** A settings scope is the literal 'global' or an 'owner/repo' pair. */
function isValidScope(scope: string): boolean {
  if (scope === "global") return true;
  const parts = scope.split("/");
  return parts.length === 2 && parts.every((p) => p.length > 0);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** Parse a positive integer route id. The whole parameter must be digits —
 * Number.parseInt would otherwise accept "123abc" as 123 and act on a real
 * rule. Tolerates the string|string[] param type. */
function parseId(raw: unknown): number | null {
  const s = Array.isArray(raw) ? raw[0] : raw;
  if (typeof s !== "string" || !/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

interface ParsedRule {
  /** Only the fields the body actually provided — so a partial update never
   * clobbers name/pattern (or anything else) with a default. */
  input?: Partial<CustomRuleInput>;
  error?: string;
}

/**
 * Validate and normalize a create/update body. `partial` allows omitting the
 * required name/pattern (for PATCH-style updates); a full create requires both.
 */
function parseRuleBody(body: Record<string, unknown>, partial: boolean): ParsedRule {
  const name = str(body.name)?.trim();
  const pattern = typeof body.pattern === "string" ? body.pattern : undefined;
  // Normalize flags: trim, and treat a now-empty string as "no flags" so a
  // whitespace-only value can't reach the regex engine as an invalid flag set.
  const flags = str(body.flags)?.trim() || undefined;
  const scope = str(body.scope)?.trim() ?? (partial ? undefined : "global");
  const kind = str(body.kind) ?? (partial ? undefined : "regex");
  const severity = str(body.severity);
  const type = str(body.type);
  // Trim optional text so a whitespace-only value clears the field (via the
  // `?? null` assignments below) instead of being stored as blanks.
  const pathGlob = str(body.pathGlob ?? body.path_glob)?.trim() || undefined;
  const message = str(body.message)?.trim() || undefined;
  const advice = str(body.advice)?.trim() || undefined;
  const enabled = typeof body.enabled === "boolean" ? body.enabled : undefined;

  if (!partial) {
    if (!name) return { error: "A non-empty 'name' is required." };
    if (pattern == null || pattern.length === 0) return { error: "A non-empty 'pattern' is required." };
  }
  if (body.name !== undefined && !name) return { error: "'name' must be a non-empty string." };
  if (body.pattern !== undefined && (pattern == null || pattern.length === 0)) {
    return { error: "'pattern' must be a non-empty string." };
  }
  if (scope !== undefined && !isValidScope(scope)) {
    return { error: "'scope' must be 'global' or 'owner/repo'." };
  }
  if (kind !== undefined && !(CUSTOM_RULE_KINDS as readonly string[]).includes(kind)) {
    return { error: `'kind' must be one of: ${CUSTOM_RULE_KINDS.join(", ")} (AST rules are not yet supported).` };
  }
  if (severity !== undefined && !(CUSTOM_RULE_SEVERITIES as readonly string[]).includes(severity)) {
    return { error: `'severity' must be one of: ${CUSTOM_RULE_SEVERITIES.join(", ")}.` };
  }
  if (type !== undefined && !(CUSTOM_RULE_TYPES as readonly string[]).includes(type)) {
    return { error: `'type' must be one of: ${CUSTOM_RULE_TYPES.join(", ")}.` };
  }
  // The pattern must actually compile (with its flags) before we store it.
  if (pattern !== undefined) {
    const v = validatePattern(pattern, flags);
    if (!v.ok) return { error: `Invalid regular expression: ${v.error}` };
  } else if (flags !== undefined) {
    // Updating flags alone — validate against a trivial pattern to catch bad flags.
    const v = validatePattern("a", flags);
    if (!v.ok) return { error: `Invalid regex flags: ${v.error}` };
  }

  // Build from only the provided fields. Crucially, name/pattern are set ONLY
  // when present — a partial update that omits them must not push "" and wipe
  // the stored values.
  const input: Partial<CustomRuleInput> = {};
  if (name !== undefined) input.name = name;
  if (pattern !== undefined) input.pattern = pattern;
  if (body.scope !== undefined || !partial) input.scope = scope;
  if (body.kind !== undefined || !partial) input.kind = kind;
  if (severity !== undefined) input.severity = severity;
  if (type !== undefined) input.type = type;
  if (body.flags !== undefined) input.flags = flags ?? null;
  if (body.pathGlob !== undefined || body.path_glob !== undefined) input.pathGlob = pathGlob ?? null;
  if (body.message !== undefined) input.message = message ?? null;
  if (body.advice !== undefined) input.advice = advice ?? null;
  if (enabled !== undefined) input.enabled = enabled;
  return { input };
}

function recordRuleChange(
  req: Request,
  action: "create" | "update" | "delete",
  id: number | null,
  name: string,
  scope: string,
): void {
  const actor = getActor(req);
  insertAuditLog({
    actorLogin: actor?.login ?? null,
    actorRole: actor?.role ?? null,
    action: `rule.${action}`,
    targetType: "custom_rule",
    targetRef: id != null ? `#${id} ${name}` : name,
    payload: { scope },
    result: "ok",
  });
  bus.publish("rule.changed", {
    id,
    name,
    scope,
    action,
    actor: actor?.login ?? null,
    role: actor?.role ?? null,
  });
}

/**
 * Register the custom-rule endpoints on the API router (mounted under /api/v1).
 */
export function registerRuleRoutes(router: Router, deps: RuleDeps): void {
  const { requireRole, csrf } = deps;
  const admin = requireRole("admin");

  // ── List rules + hit-counts ─────────────────────────────────────────
  router.get("/rules", admin, (_req, res) => {
    try {
      sendData(res, { rules: listCustomRulesWithHits() });
    } catch (err) {
      logger.error({ err }, "api GET /rules failed");
      sendError(res, 500, "internal", "Failed to load custom rules.");
    }
  });

  // ── Test a candidate rule against a pasted snippet (no persistence) ──
  // CSRF-verified like the write routes: it's still an authenticated POST that
  // runs attacker-influenced regex compute, and the SPA already sends the token.
  router.post("/rules/test", admin, csrf.verify, (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const pattern = typeof body.pattern === "string" ? body.pattern : "";
    const flags = str(body.flags)?.trim() || undefined;
    // Trim like parseRuleBody so a whitespace-only glob is treated as absent —
    // otherwise the tester would apply " " as a real glob and show no matches
    // even though the persisted rule clears it.
    const pathGlob = str(body.pathGlob ?? body.path_glob)?.trim() || undefined;
    const filename = str(body.filename);
    const snippet = typeof body.snippet === "string" ? body.snippet : "";
    if (!pattern) {
      sendError(res, 400, "bad_request", "A non-empty 'pattern' is required.");
      return;
    }
    try {
      const result = testPattern({ pattern, flags, path: pathGlob }, snippet, filename);
      sendData(res, result);
    } catch (err) {
      logger.error({ err }, "api POST /rules/test failed");
      sendError(res, 500, "internal", "Failed to test rule.");
    }
  });

  // ── Create a rule ───────────────────────────────────────────────────
  router.post("/rules", admin, csrf.verify, (req, res) => {
    const { input, error } = parseRuleBody((req.body ?? {}) as Record<string, unknown>, false);
    if (error || !input) {
      sendError(res, 400, "bad_request", error ?? "Invalid rule.");
      return;
    }
    // A full create always carries name + pattern (validated above); narrow the
    // Partial back to a create-shaped object for insertCustomRule.
    if (input.name == null || input.pattern == null) {
      sendError(res, 400, "bad_request", "A non-empty 'name' and 'pattern' are required.");
      return;
    }
    // Custom-rule names must be globally unique: pattern_hits joins to a rule by
    // name, so two same-named rules would merge their hit-counts in analytics.
    if (customRuleNameExists(input.name)) {
      sendError(res, 400, "bad_request", `A custom rule named '${input.name}' already exists. Names must be unique.`);
      return;
    }
    try {
      const actor = getActor(req);
      const id = insertCustomRule({ ...input, name: input.name, pattern: input.pattern }, actor?.login ?? null);
      if (id == null) {
        sendError(res, 503, "internal", "Persistence is disabled — cannot store custom rules.");
        return;
      }
      recordRuleChange(req, "create", id, input.name, input.scope ?? "global");
      sendData(res, { rule: getCustomRule(id) }, 201);
    } catch (err) {
      logger.error({ err }, "api POST /rules failed");
      sendError(res, 500, "internal", "Failed to create custom rule.");
    }
  });

  // ── Update a rule ───────────────────────────────────────────────────
  router.put("/rules/:id", admin, csrf.verify, (req, res) => {
    const id = parseId(req.params.id);
    if (id == null) {
      sendError(res, 400, "bad_request", "Invalid rule id.");
      return;
    }
    const existing = getCustomRule(id);
    if (!existing) {
      sendError(res, 404, "not_found", `No custom rule #${id}.`);
      return;
    }
    const { input, error } = parseRuleBody((req.body ?? {}) as Record<string, unknown>, true);
    if (error || !input) {
      sendError(res, 400, "bad_request", error ?? "Invalid rule.");
      return;
    }
    // A flags-only update can be valid in isolation yet invalid against the
    // *stored* pattern (e.g. the `u` flag rejecting an escape that compiled
    // without it). parseRuleBody only sees the incoming fields, so validate the
    // effective pattern+flags here — where `existing` is available — to reject a
    // bad combo at author time instead of silently dropping the rule when
    // compile() returns null at review time.
    if (input.flags !== undefined || input.pattern !== undefined) {
      const mergedPattern = input.pattern ?? existing.pattern;
      const mergedFlags = input.flags !== undefined ? input.flags ?? undefined : existing.flags ?? undefined;
      const merged = validatePattern(mergedPattern, mergedFlags);
      if (!merged.ok) {
        sendError(res, 400, "bad_request", `Invalid regular expression: ${merged.error}`);
        return;
      }
    }
    // A rename must not collide with another rule's name (see create note).
    if (input.name != null && input.name !== existing.name && customRuleNameExists(input.name, id)) {
      sendError(res, 400, "bad_request", `A custom rule named '${input.name}' already exists. Names must be unique.`);
      return;
    }
    try {
      const ok = updateCustomRule(id, input);
      if (!ok) {
        sendError(res, 500, "internal", "Failed to update custom rule.");
        return;
      }
      // No hit migration needed on rename: pattern_hits reference the rule by its
      // stable id (custom_rule_id), so the analytics join survives a rename.
      const updated = getCustomRule(id);
      recordRuleChange(req, "update", id, updated?.name ?? existing.name, updated?.scope ?? existing.scope);
      sendData(res, { rule: updated });
    } catch (err) {
      logger.error({ err, id }, "api PUT /rules/:id failed");
      sendError(res, 500, "internal", "Failed to update custom rule.");
    }
  });

  // ── Delete a rule ───────────────────────────────────────────────────
  router.delete("/rules/:id", admin, csrf.verify, (req, res) => {
    const id = parseId(req.params.id);
    if (id == null) {
      sendError(res, 400, "bad_request", "Invalid rule id.");
      return;
    }
    const existing = getCustomRule(id);
    if (!existing) {
      sendError(res, 404, "not_found", `No custom rule #${id}.`);
      return;
    }
    try {
      const ok = deleteCustomRule(id);
      if (!ok) {
        sendError(res, 500, "internal", "Failed to delete custom rule.");
        return;
      }
      recordRuleChange(req, "delete", id, existing.name, existing.scope);
      sendData(res, { id });
    } catch (err) {
      logger.error({ err, id }, "api DELETE /rules/:id failed");
      sendError(res, 500, "internal", "Failed to delete custom rule.");
    }
  });
}
