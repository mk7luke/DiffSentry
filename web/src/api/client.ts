// Typed fetch wrapper around the DiffSentry JSON API.
//
// Every endpoint answers { data } on success or { error: { code, message } }
// on failure. `apiGet` unwraps the envelope and throws a typed ApiError so
// TanStack Query's error state carries a useful code + message.

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

export async function apiGet<T>(path: string, params?: Record<string, string | number | undefined>): Promise<T> {
  const url = new URL(BASE + path, window.location.origin);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    }
  }

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
    const body = (json as { error?: ApiErrorBody })?.error;
    throw new ApiError(resp.status, body ?? { code: "http_error", message: `HTTP ${resp.status}` });
  }

  return (json as { data: T }).data;
}
