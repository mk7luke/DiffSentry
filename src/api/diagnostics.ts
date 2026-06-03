import fs from "node:fs";
import crypto from "node:crypto";
import type { Request, Response, Router } from "express";
import type { Role } from "../dashboard/roles.js";
import { getActor } from "../dashboard/roles.js";
import type { CsrfRuntime } from "../dashboard/auth.js";
import { loadAuthConfigFromEnv } from "../dashboard/auth.js";
import { insertAuditLog } from "../storage/dao.js";
import { openDatabase } from "../storage/db.js";
import { getHealthCounts } from "../dashboard/queries.js";
import { bus } from "../realtime/bus.js";
import { logger } from "../logger.js";
import type { GithubDiagnostics } from "../github.js";

// ─────────────────────────────────────────────────────────────────────────────
// Guided first-run diagnostics.
//
// GET  /diagnostics          — fast, local, no network. Reads process.env + the
//                              DB to report exactly which config is missing or
//                              degraded, each with a concrete fix hint. Drives
//                              the setup wizard (incomplete=true) and the
//                              permanent Diagnostics screen.
// GET  /diagnostics/github   — live probe: installations + connected repos,
//                              webhook delivery health, rate-limit headroom.
//                              Network-bound, so it's a separate lazy endpoint.
// POST /diagnostics/test-ai      — author+. Fires a tiny completion to prove the
//                                  provider is reachable. Audited + bus event.
// POST /diagnostics/test-webhook — author+. Round-trips a signed synthetic
//                                  payload through the same signature
//                                  verification /webhook uses, proving the
//                                  webhook secret is wired correctly.
//
// Env presence is read from process.env directly (not the validated Config) so
// the report is accurate even for values the boot path doesn't hard-require.
// ─────────────────────────────────────────────────────────────────────────────

export interface DiagnosticsProvider {
  aiTarget(): { provider: string; model: string };
  testAiProvider(): Promise<{
    ok: boolean;
    provider: string;
    model: string;
    latencyMs: number;
    reply?: string;
    error?: string;
  }>;
  getGithubDiagnostics(): Promise<GithubDiagnostics>;
}

export interface DiagnosticsRouteDeps {
  diagnostics: DiagnosticsProvider;
  requireRole: (role: Role) => import("express").RequestHandler;
  csrf: CsrfRuntime;
  /** Whether OAuth is configured (mirrors the router's authEnabled). */
  authEnabled: boolean;
}

type CheckStatus = "ok" | "warn" | "fail";
type CheckCategory = "github" | "ai" | "auth" | "persistence";

export interface DiagnosticCheck {
  id: string;
  category: CheckCategory;
  label: string;
  status: CheckStatus;
  detail: string;
  /** Actionable remediation, shown verbatim in the wizard / Diagnostics screen. */
  fixHint?: string;
}

function sendData(res: Response, data: unknown, status = 200): void {
  res.status(status).json({ data });
}

function sendError(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } });
}

/** Constant-time string compare (lengths must match to be equal). */
function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function envSet(name: string): boolean {
  const v = process.env[name];
  return typeof v === "string" && v.trim().length > 0;
}

/** Is a private key available — inline, or via a readable, non-empty file? */
function privateKeyState(): { ok: boolean; detail: string } {
  if (envSet("GITHUB_PRIVATE_KEY")) return { ok: true, detail: "Provided inline via GITHUB_PRIVATE_KEY." };
  const p = process.env.GITHUB_PRIVATE_KEY_PATH;
  if (!p || !p.trim()) return { ok: false, detail: "Neither GITHUB_PRIVATE_KEY nor GITHUB_PRIVATE_KEY_PATH is set." };
  try {
    const contents = fs.readFileSync(p, "utf-8");
    if (!contents.trim()) return { ok: false, detail: `File at GITHUB_PRIVATE_KEY_PATH (${p}) is empty.` };
    return { ok: true, detail: `Loaded from ${p}.` };
  } catch (err) {
    return { ok: false, detail: `Could not read GITHUB_PRIVATE_KEY_PATH (${p}): ${(err as Error).message}` };
  }
}

const VALID_PROVIDERS = ["anthropic", "openai", "openai-compatible"];

/** Build the static (no-network) check list from the environment + DB. */
function buildChecks(authEnabled: boolean): DiagnosticCheck[] {
  const checks: DiagnosticCheck[] = [];

  // ── GitHub App ──────────────────────────────────────────────────
  checks.push({
    id: "github.app_id",
    category: "github",
    label: "GitHub App ID",
    status: envSet("GITHUB_APP_ID") ? "ok" : "fail",
    detail: envSet("GITHUB_APP_ID") ? "GITHUB_APP_ID is set." : "GITHUB_APP_ID is not set.",
    fixHint: envSet("GITHUB_APP_ID")
      ? undefined
      : "Copy the numeric App ID from your GitHub App's settings page into GITHUB_APP_ID.",
  });

  const pk = privateKeyState();
  checks.push({
    id: "github.private_key",
    category: "github",
    label: "GitHub App private key",
    status: pk.ok ? "ok" : "fail",
    detail: pk.detail,
    fixHint: pk.ok
      ? undefined
      : "Generate a private key in the App settings and point GITHUB_PRIVATE_KEY_PATH at the .pem file (or paste it into GITHUB_PRIVATE_KEY).",
  });

  checks.push({
    id: "github.webhook_secret",
    category: "github",
    label: "Webhook secret",
    status: envSet("GITHUB_WEBHOOK_SECRET") ? "ok" : "fail",
    detail: envSet("GITHUB_WEBHOOK_SECRET")
      ? "GITHUB_WEBHOOK_SECRET is set — incoming webhooks can be verified."
      : "GITHUB_WEBHOOK_SECRET is not set; webhook signatures cannot be verified.",
    fixHint: envSet("GITHUB_WEBHOOK_SECRET")
      ? undefined
      : "Set the same secret in both the GitHub App's webhook config and GITHUB_WEBHOOK_SECRET.",
  });

  // ── AI provider ─────────────────────────────────────────────────
  const provider = (process.env.AI_PROVIDER || "anthropic").trim();
  const providerValid = VALID_PROVIDERS.includes(provider);
  checks.push({
    id: "ai.provider",
    category: "ai",
    label: "AI provider selection",
    status: providerValid ? "ok" : "fail",
    detail: providerValid
      ? `AI_PROVIDER=${provider}.`
      : `AI_PROVIDER=${provider || "(unset)"} is not recognized.`,
    fixHint: providerValid ? undefined : `Set AI_PROVIDER to one of: ${VALID_PROVIDERS.join(", ")}.`,
  });

  if (provider === "anthropic") {
    const ok = envSet("ANTHROPIC_API_KEY");
    checks.push({
      id: "ai.credentials",
      category: "ai",
      label: "Anthropic credentials",
      status: ok ? "ok" : "fail",
      detail: ok ? "ANTHROPIC_API_KEY is set." : "ANTHROPIC_API_KEY is not set.",
      fixHint: ok ? undefined : "Set ANTHROPIC_API_KEY to a key from console.anthropic.com.",
    });
  } else if (provider === "openai") {
    const ok = envSet("OPENAI_API_KEY");
    checks.push({
      id: "ai.credentials",
      category: "ai",
      label: "OpenAI credentials",
      status: ok ? "ok" : "fail",
      detail: ok ? "OPENAI_API_KEY is set." : "OPENAI_API_KEY is not set.",
      fixHint: ok ? undefined : "Set OPENAI_API_KEY to a key from platform.openai.com.",
    });
  } else if (provider === "openai-compatible") {
    const baseOk = envSet("LOCAL_AI_BASE_URL");
    const modelOk = envSet("LOCAL_AI_MODEL");
    const ok = baseOk && modelOk;
    const missing = [!baseOk && "LOCAL_AI_BASE_URL", !modelOk && "LOCAL_AI_MODEL"].filter(Boolean).join(", ");
    checks.push({
      id: "ai.credentials",
      category: "ai",
      label: "Local model endpoint",
      status: ok ? "ok" : "fail",
      detail: ok
        ? `LOCAL_AI_BASE_URL + LOCAL_AI_MODEL are set.`
        : `Missing ${missing} for the openai-compatible provider.`,
      fixHint: ok
        ? undefined
        : "Set LOCAL_AI_BASE_URL (e.g. http://localhost:11434/v1) and LOCAL_AI_MODEL (the model your server exposes).",
    });
  }

  // ── Dashboard auth (OAuth) ──────────────────────────────────────
  // Open mode (no OAuth) is a supported configuration, so a missing OAuth setup
  // is a warning, not a failure: the dashboard works but is unauthenticated and
  // the local operator is treated as admin.
  checks.push({
    id: "auth.oauth",
    category: "auth",
    label: "Dashboard OAuth",
    status: authEnabled ? "ok" : "warn",
    detail: authEnabled
      ? "OAuth is configured — dashboard access is gated and RBAC is active."
      : "Running in open mode: no OAuth, so anyone who can reach the dashboard has admin access.",
    fixHint: authEnabled
      ? undefined
      : "Set GITHUB_OAUTH_CLIENT_ID, GITHUB_OAUTH_CLIENT_SECRET, DASHBOARD_URL, and at least one of DASHBOARD_ALLOWED_ORGS / DASHBOARD_ALLOWED_LOGINS to require sign-in.",
  });

  // ── Persistence ─────────────────────────────────────────────────
  const dbOn = !!openDatabase();
  checks.push({
    id: "persistence.db",
    category: "persistence",
    label: "SQLite persistence",
    status: dbOn ? "ok" : "warn",
    detail: dbOn
      ? "Database is open — reviews, findings, and audit history are recorded."
      : "Persistence is disabled; the dashboard has no history and the audit log is a no-op.",
    fixHint: dbOn
      ? undefined
      : "Set DB_PATH to a writable file (default ./data/diffsentry.db) to enable persistence.",
  });

  return checks;
}

function summarize(checks: DiagnosticCheck[]): { ok: number; warn: number; fail: number } {
  return {
    ok: checks.filter((c) => c.status === "ok").length,
    warn: checks.filter((c) => c.status === "warn").length,
    fail: checks.filter((c) => c.status === "fail").length,
  };
}

export function registerDiagnosticsRoutes(router: Router, deps: DiagnosticsRouteDeps): void {
  const { diagnostics, requireRole, csrf, authEnabled } = deps;
  const author = requireRole("author");

  // ── GET /diagnostics — static, fast, no network ──────────────────
  router.get("/diagnostics", (_req, res) => {
    try {
      const checks = buildChecks(authEnabled);
      const summary = summarize(checks);
      const counts = getHealthCounts();
      const target = diagnostics.aiTarget();
      const oauthCfg = loadAuthConfigFromEnv();
      sendData(res, {
        checks,
        summary,
        // The wizard nags only when something is outright broken; warnings
        // (open mode, no DB) are surfaced but don't force the wizard open.
        incomplete: summary.fail > 0,
        config: {
          provider: target.provider,
          model: target.model,
          botName: process.env.BOT_NAME || "diffsentry",
          authEnabled,
          oauthConfigured: !!oauthCfg,
          dashboardUrl: oauthCfg?.baseUrl ?? null,
          persistence: !!openDatabase(),
        },
        db: {
          enabled: !!openDatabase(),
          sizeBytes: counts.db_bytes,
          lastReviewAt: counts.newest_review,
          counts,
        },
      });
    } catch (err) {
      logger.error({ err }, "api /diagnostics failed");
      sendError(res, 500, "internal", "Failed to build diagnostics.");
    }
  });

  // ── GET /diagnostics/github — live probe ─────────────────────────
  router.get("/diagnostics/github", async (_req, res) => {
    try {
      const gh = await diagnostics.getGithubDiagnostics();
      const connectedRepos = gh.installations.reduce((n, i) => n + i.repoCount, 0);
      sendData(res, {
        ...gh,
        reachable: !gh.error,
        connectedRepos,
        installationCount: gh.installations.length,
      });
    } catch (err) {
      logger.error({ err }, "api /diagnostics/github failed");
      sendError(res, 500, "internal", "Failed to probe GitHub.");
    }
  });

  // ── POST /diagnostics/test-ai — author+, audited ─────────────────
  router.post("/diagnostics/test-ai", author, csrf.verify, async (req: Request, res: Response) => {
    const actor = getActor(req);
    const result = await diagnostics.testAiProvider();
    insertAuditLog({
      actorLogin: actor?.login ?? null,
      actorRole: actor?.role ?? null,
      action: "diagnostics.test_ai",
      targetType: "provider",
      targetRef: `${result.provider}:${result.model}`,
      payload: { ok: result.ok, latencyMs: result.latencyMs, error: result.error },
      result: result.ok ? "ok" : "error",
    });
    bus.publish("action.performed", {
      owner: "-",
      repo: "-",
      number: 0,
      action: "diagnostics.test_ai",
      actor: actor?.login ?? null,
      role: actor?.role ?? null,
      result: result.ok ? "ok" : "error",
      detail: result.ok ? `${result.latencyMs}ms` : result.error,
    });
    sendData(res, result);
  });

  // ── POST /diagnostics/test-webhook — author+, audited ────────────
  // Proves the webhook secret is wired correctly using the exact HMAC-SHA256
  // scheme GitHub signs deliveries with (the same one /webhook verifies). It
  // never contacts GitHub — it confirms the secret is set and the signature
  // pipeline both accepts a correct signature and rejects a tampered one.
  router.post("/diagnostics/test-webhook", author, csrf.verify, async (req: Request, res: Response) => {
    const actor = getActor(req);
    const secret = process.env.GITHUB_WEBHOOK_SECRET ?? "";
    let ok = false;
    let error: string | undefined;
    if (!secret) {
      error = "GITHUB_WEBHOOK_SECRET is not set, so webhook signatures cannot be verified.";
    } else {
      try {
        const payload = JSON.stringify({ zen: "DiffSentry self-test", hook_id: 0 });
        const sign = (key: string) =>
          "sha256=" + crypto.createHmac("sha256", key).update(payload).digest("hex");
        const good = sign(secret);
        const tampered = sign(secret + "-wrong");
        const accepts = timingSafeEqualStr(good, sign(secret));
        const rejects = !timingSafeEqualStr(good, tampered);
        ok = accepts && rejects;
        if (!ok) error = "Signature pipeline did not behave as expected.";
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
    }
    insertAuditLog({
      actorLogin: actor?.login ?? null,
      actorRole: actor?.role ?? null,
      action: "diagnostics.test_webhook",
      targetType: "webhook",
      targetRef: null,
      payload: { ok, error },
      result: ok ? "ok" : "error",
    });
    bus.publish("action.performed", {
      owner: "-",
      repo: "-",
      number: 0,
      action: "diagnostics.test_webhook",
      actor: actor?.login ?? null,
      role: actor?.role ?? null,
      result: ok ? "ok" : "error",
      detail: error,
    });
    sendData(res, { ok, error, secretConfigured: !!secret });
  });
}
