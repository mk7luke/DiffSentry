// Typed fetch wrapper around the DiffSentry JSON API.
//
// Every endpoint answers { data } on success or { error: { code, message } }
// on failure. `apiGet` unwraps the envelope and throws a typed ApiError so
// TanStack Query's error state carries a useful code + message.

export interface ApiErrorBody {
  code: string;
  message: string;
}

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(status: number, body: ApiErrorBody) {
    super(body.message);
    this.name = "ApiError";
    this.code = body.code;
    this.status = status;
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
