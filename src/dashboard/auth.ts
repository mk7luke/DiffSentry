import crypto from "node:crypto";
import type { Request, Response, NextFunction, RequestHandler } from "express";
import { logger } from "../logger.js";
import { esc, renderLayout } from "./layout.js";

export interface AuthConfig {
  clientId: string;
  clientSecret: string;
  allowedOrgs: string[];
  sessionSecret: string;
  /** Full URL the dashboard is mounted at — used to build the OAuth callback. */
  baseUrl: string;
}

export interface AuthRuntime {
  middleware: RequestHandler;
  routes: (app: import("express").Router) => void;
  enabled: true;
}

/** Builds auth config from env vars or returns null to signal auth disabled. */
export function loadAuthConfigFromEnv(): AuthConfig | null {
  const clientId = process.env.GITHUB_OAUTH_CLIENT_ID ?? "";
  const clientSecret = process.env.GITHUB_OAUTH_CLIENT_SECRET ?? "";
  const orgs = (process.env.DASHBOARD_ALLOWED_ORGS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const baseUrl = process.env.DASHBOARD_URL ?? "";
  const sessionSecret = process.env.DASHBOARD_SESSION_SECRET || process.env.GITHUB_WEBHOOK_SECRET || "";
  if (!clientId || !clientSecret || orgs.length === 0 || !baseUrl || !sessionSecret) return null;
  return { clientId, clientSecret, allowedOrgs: orgs, sessionSecret, baseUrl: baseUrl.replace(/\/$/, "") };
}

const SESSION_COOKIE = "ds_session";
const STATE_COOKIE = "ds_oauth_state";
const SESSION_MAX_AGE_SECS = 7 * 24 * 60 * 60;

interface SessionPayload {
  login: string;
  id: number;
  exp: number;
}

function sign(secret: string, data: string): string {
  return crypto.createHmac("sha256", secret).update(data).digest("base64url");
}

function makeSessionCookie(secret: string, payload: SessionPayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = sign(secret, body);
  return `${body}.${sig}`;
}

function verifySessionCookie(secret: string, raw: string | undefined): SessionPayload | null {
  if (!raw) return null;
  const dot = raw.indexOf(".");
  if (dot < 0) return null;
  const body = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  const expected = sign(secret, body);
  if (sig.length !== expected.length) return null;
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf-8")) as SessionPayload;
    if (!parsed.login || !parsed.id || !parsed.exp) return null;
    if (Math.floor(Date.now() / 1000) > parsed.exp) return null;
    return parsed;
  } catch {
    return null;
  }
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

function setCookie(res: Response, name: string, value: string, maxAgeSec: number) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/dashboard",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSec}`,
  ];
  if (process.env.NODE_ENV !== "development") parts.push("Secure");
  res.append("Set-Cookie", parts.join("; "));
}

function clearCookie(res: Response, name: string) {
  res.append("Set-Cookie", `${name}=; Path=/dashboard; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function renderLoginPage(opts: { baseUrl: string; error?: string; next?: string }): string {
  const nextQs = opts.next ? `?next=${encodeURIComponent(opts.next)}` : "";
  const body = `
    <div class="max-w-md mx-auto bg-white border border-slate-200 rounded-lg p-8 text-center">
      <h1 class="text-xl font-semibold mb-2">Sign in</h1>
      <p class="text-sm text-slate-500 mb-6">You must be a member of an authorized GitHub organization.</p>
      ${opts.error ? `<div class="bg-red-50 border border-red-200 rounded p-3 text-sm text-red-800 mb-4 text-left">${esc(opts.error)}</div>` : ""}
      <a href="/dashboard/auth/login${nextQs}" class="inline-block bg-slate-900 text-white px-4 py-2 rounded text-sm hover:bg-slate-700">Continue with GitHub</a>
    </div>`;
  return renderLayout({ title: "Sign in", body });
}

async function postForToken(cfg: AuthConfig, code: string, redirectUri: string): Promise<string | null> {
  const resp = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
  });
  if (!resp.ok) {
    logger.warn({ status: resp.status }, "OAuth token exchange failed");
    return null;
  }
  const json = (await resp.json()) as { access_token?: string; error?: string };
  if (json.error || !json.access_token) {
    logger.warn({ error: json.error }, "OAuth token exchange returned error");
    return null;
  }
  return json.access_token;
}

async function getUserLogin(token: string): Promise<{ login: string; id: number } | null> {
  const resp = await fetch("https://api.github.com/user", {
    headers: { Authorization: `Bearer ${token}`, "User-Agent": "DiffSentry-Dashboard", Accept: "application/vnd.github+json" },
  });
  if (!resp.ok) return null;
  const j = (await resp.json()) as { login?: string; id?: number };
  if (!j.login || !j.id) return null;
  return { login: j.login, id: j.id };
}

async function userInAnyOrg(token: string, login: string, allowedOrgs: string[]): Promise<string | null> {
  for (const org of allowedOrgs) {
    const resp = await fetch(`https://api.github.com/user/memberships/orgs/${encodeURIComponent(org)}`, {
      headers: { Authorization: `Bearer ${token}`, "User-Agent": "DiffSentry-Dashboard", Accept: "application/vnd.github+json" },
    });
    if (!resp.ok) continue;
    const j = (await resp.json()) as { state?: string; user?: { login?: string } };
    if (j.state === "active" && j.user?.login?.toLowerCase() === login.toLowerCase()) return org;
  }
  return null;
}

export function createAuth(cfg: AuthConfig | null): AuthRuntime | null {
  if (!cfg) return null;

  const middleware: RequestHandler = (req, res, next) => {
    if (req.path.startsWith("/auth/")) return next();
    const cookies = parseCookies(req.headers.cookie);
    const session = verifySessionCookie(cfg.sessionSecret, cookies[SESSION_COOKIE]);
    if (session) {
      (req as Request & { dsUser?: SessionPayload }).dsUser = session;
      return next();
    }
    const next_ = req.originalUrl && req.originalUrl.startsWith("/dashboard") ? req.originalUrl : "/dashboard";
    res.redirect(`/dashboard/auth/login?next=${encodeURIComponent(next_)}`);
  };

  const routes: AuthRuntime["routes"] = (router) => {
    router.get("/auth/login", (req, res) => {
      const state = crypto.randomBytes(18).toString("base64url");
      const next_ = typeof req.query.next === "string" ? req.query.next : "/dashboard";
      const stateBody = Buffer.from(JSON.stringify({ state, next: next_, iat: Math.floor(Date.now() / 1000) })).toString("base64url");
      const stateSig = sign(cfg.sessionSecret, stateBody);
      setCookie(res, STATE_COOKIE, `${stateBody}.${stateSig}`, 600);
      const redirect = `${cfg.baseUrl}/auth/callback`;
      const url = new URL("https://github.com/login/oauth/authorize");
      url.searchParams.set("client_id", cfg.clientId);
      url.searchParams.set("redirect_uri", redirect);
      url.searchParams.set("state", state);
      url.searchParams.set("scope", "read:org");
      res.redirect(url.toString());
    });

    router.get("/auth/callback", async (req, res) => {
      const code = typeof req.query.code === "string" ? req.query.code : "";
      const state = typeof req.query.state === "string" ? req.query.state : "";
      const cookies = parseCookies(req.headers.cookie);
      const stateCookie = cookies[STATE_COOKIE] ?? "";
      clearCookie(res, STATE_COOKIE);
      const dot = stateCookie.indexOf(".");
      if (!code || !state || dot < 0) {
        res.status(400).type("html").send(renderLoginPage({ baseUrl: cfg.baseUrl, error: "Missing OAuth parameters." }));
        return;
      }
      const body = stateCookie.slice(0, dot);
      const sig = stateCookie.slice(dot + 1);
      const expected = sign(cfg.sessionSecret, body);
      if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
        res.status(400).type("html").send(renderLoginPage({ baseUrl: cfg.baseUrl, error: "Invalid OAuth state." }));
        return;
      }
      let parsedState: { state: string; next?: string };
      try {
        parsedState = JSON.parse(Buffer.from(body, "base64url").toString("utf-8"));
      } catch {
        res.status(400).type("html").send(renderLoginPage({ baseUrl: cfg.baseUrl, error: "Corrupt OAuth state." }));
        return;
      }
      if (parsedState.state !== state) {
        res.status(400).type("html").send(renderLoginPage({ baseUrl: cfg.baseUrl, error: "OAuth state mismatch." }));
        return;
      }
      const token = await postForToken(cfg, code, `${cfg.baseUrl}/auth/callback`);
      if (!token) {
        res.status(502).type("html").send(renderLoginPage({ baseUrl: cfg.baseUrl, error: "Failed to exchange OAuth code." }));
        return;
      }
      const user = await getUserLogin(token);
      if (!user) {
        res.status(502).type("html").send(renderLoginPage({ baseUrl: cfg.baseUrl, error: "Could not read your GitHub profile." }));
        return;
      }
      const matchingOrg = await userInAnyOrg(token, user.login, cfg.allowedOrgs);
      if (!matchingOrg) {
        logger.warn({ login: user.login, allowed: cfg.allowedOrgs }, "Dashboard login denied — not an org member");
        res.status(403).type("html").send(
          renderLoginPage({
            baseUrl: cfg.baseUrl,
            error: `@${user.login} is not a member of any authorized org (${cfg.allowedOrgs.join(", ")}).`,
          }),
        );
        return;
      }
      const session: SessionPayload = {
        login: user.login,
        id: user.id,
        exp: Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_SECS,
      };
      setCookie(res, SESSION_COOKIE, makeSessionCookie(cfg.sessionSecret, session), SESSION_MAX_AGE_SECS);
      logger.info({ login: user.login, org: matchingOrg }, "Dashboard login");
      const nextUrl = parsedState.next && parsedState.next.startsWith("/dashboard") ? parsedState.next : "/dashboard";
      res.redirect(nextUrl);
    });

    router.get("/auth/login-page", (req, res) => {
      const next_ = typeof req.query.next === "string" ? req.query.next : undefined;
      res.type("html").send(renderLoginPage({ baseUrl: cfg.baseUrl, next: next_ }));
    });

    router.get("/auth/logout", (_req, res) => {
      clearCookie(res, SESSION_COOKIE);
      res.redirect("/dashboard/auth/login-page");
    });
  };

  return { middleware, routes, enabled: true };
}

export function getCurrentUser(req: Request): SessionPayload | null {
  return ((req as Request & { dsUser?: SessionPayload }).dsUser) ?? null;
}
