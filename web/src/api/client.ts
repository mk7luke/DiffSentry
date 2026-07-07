// Typed fetch wrapper around the DiffSentry JSON API.
//
// Every endpoint answers { data } on success or { error: { code, message } }
// on failure. `apiGet` unwraps the envelope and throws a typed ApiError so
// TanStack Query's error state carries a useful code + message.
//
// Demo mode (see ../demo): when DEMO is true, reads resolve from bundled
// fixtures and writes are refused — NO network request is made, so the demo can
// neither read nor mutate real data.

import { DEMO } from "../demo/mode";
import { resolveDemoGet } from "../demo/fixtures";

export interface ApiErrorBody {
  code: string;
  message: string;
  /** Optional structured detail (e.g. per-field config validation errors). */
  details?: unknown;
}

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;
  constructor(status: number, body: ApiErrorBody) {
    super(body.message);
    this.name = "ApiError";
    this.code = body.code;
    this.status = status;
    this.details = body.details;
  }
}

const BASE = "/api/v1";

// A 401 from the JSON API means the cookie session has expired or was never
// established. Every request the SPA makes is cookie-based, and the server only
// answers 401 when OAuth is enabled (open mode never gates on a session), so a
// 401 unambiguously means "sign in again". Bounce the whole page to the server
// login route — it 302s to GitHub OAuth and returns here afterwards (`next`).
// Without this the SPA just paints an "Authentication required" error card with
// no visible way to re-auth (the old workaround was to hunt for /dashboard,
// sign out, then sign back in).
let redirectingToLogin = false;

function redirectToLogin(path: string): void {
  // Nothing to redirect in SSR/tests or demo mode. Public reads (/public/*) are
  // served BEFORE the auth gate, so a 401 there isn't a session problem — never
  // hijack the no-auth share viewer into a GitHub login.
  if (typeof window === "undefined" || DEMO || path.startsWith("/public/")) return;
  // A screen fires many queries at once; the first 401 wins the redirect and the
  // rest are no-ops, so we never stack navigations.
  if (redirectingToLogin) return;
  redirectingToLogin = true;
  const returnTo = window.location.pathname + window.location.search + window.location.hash;
  window.location.assign(`/dashboard/auth/login?next=${encodeURIComponent(returnTo)}`);
}

export async function apiGet<T>(path: string, params?: Record<string, string | number | undefined>): Promise<T> {
  const url = new URL(BASE + path, window.location.origin);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    }
  }

  // Demo mode: resolve from bundled fixtures, never touching the network. Pass
  // the same relative path + serialized query the live request would use, so the
  // resolver can route on filters too (not just the base path).
  if (DEMO) return resolveDemoGet<T>(path + url.search);

  let resp: Response;
  try {
    resp = await fetch(url.toString(), {
      headers: { Accept: "application/json" },
      credentials: "same-origin",
    });
  } catch (err) {
    throw new ApiError(0, { code: "network", message: `Network error: ${(err as Error).message}` });
  }

  let json: unknown = null;
  const text = await resp.text();
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      // Non-JSON body (e.g. an HTML error page) — surface a clean error.
      throw new ApiError(resp.status, {
        code: "bad_response",
        message: `Expected JSON, got ${resp.headers.get("content-type") ?? "unknown"} (HTTP ${resp.status}).`,
      });
    }
  }

  if (!resp.ok) {
    // Session expired / not signed in → send the whole page to re-auth rather
    // than surfacing a dead-end error card.
    if (resp.status === 401) redirectToLogin(path);
    const body = (json as { error?: ApiErrorBody })?.error;
    throw new ApiError(resp.status, body ?? { code: "http_error", message: `HTTP ${resp.status}` });
  }

  return (json as { data: T }).data;
}

/** Reads a non-HttpOnly cookie value by name from document.cookie. */
function readCookie(name: string): string {
  const prefix = `${name}=`;
  for (const part of document.cookie.split(";")) {
    const c = part.trim();
    if (c.startsWith(prefix)) {
      try {
        return decodeURIComponent(c.slice(prefix.length));
      } catch {
        return c.slice(prefix.length);
      }
    }
  }
  return "";
}

/**
 * Mutating request (POST by default). Sends the ds_csrf cookie value back as
 * the X-CSRF-Token header — the double-submit token the server's CSRF verify
 * expects. Same envelope handling as apiGet.
 */
export async function apiSend<T>(
  path: string,
  opts: { method?: "POST" | "PUT" | "DELETE"; body?: unknown } = {},
): Promise<T> {
  // Demo mode is strictly read-only: refuse every write without a network call,
  // so it can never mutate real data. The viewer UI hides write controls, so
  // this is a defensive backstop surfaced as a clean, friendly error.
  if (DEMO) {
    throw new ApiError(403, {
      code: "demo_readonly",
      message: "This is a read-only demo. Install DiffSentry on your own repo to make changes.",
    });
  }

  const url = new URL(BASE + path, window.location.origin);
  let resp: Response;
  try {
    resp = await fetch(url.toString(), {
      method: opts.method ?? "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-CSRF-Token": readCookie("ds_csrf"),
      },
      credentials: "same-origin",
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  } catch (err) {
    throw new ApiError(0, { code: "network", message: `Network error: ${(err as Error).message}` });
  }

  let json: unknown = null;
  const text = await resp.text();
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      // Non-JSON body (e.g. the CSRF verify's text/plain 403) — surface cleanly.
      throw new ApiError(resp.status, {
        code: resp.status === 403 ? "forbidden" : "bad_response",
        message: text.slice(0, 200) || `HTTP ${resp.status}`,
      });
    }
  }

  if (!resp.ok) {
    // A write that 401s means the session lapsed mid-action — re-auth, keeping
    // the user on the page they were working from.
    if (resp.status === 401) redirectToLogin(path);
    const body = (json as { error?: ApiErrorBody })?.error;
    throw new ApiError(resp.status, body ?? { code: "http_error", message: `HTTP ${resp.status}` });
  }

  return (json as { data: T }).data;
}
