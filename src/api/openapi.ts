import { API_SCOPES } from "./token-auth.js";

// ─────────────────────────────────────────────────────────────────────────────
// OpenAPI 3.0 document for the DiffSentry platform API, served at
// /api/v1/openapi.json and rendered by the docs page (src/api/docs.ts).
//
// Hand-authored (no decorators/generator) so it stays dependency-free and in
// one place. Responses use the shared `{ data }` / `{ error }` envelope; we
// model the envelope + a handful of representative payloads rather than every
// row shape — enough to drive a viewer and a typed client without turning this
// file into a second copy of the row interfaces.
// ─────────────────────────────────────────────────────────────────────────────

/** Build the spec. `serverUrl` defaults to the conventional mount point. */
export function buildOpenApiSpec(opts: { serverUrl?: string } = {}): Record<string, unknown> {
  const server = opts.serverUrl ?? "/api/v1";

  // Reusable response refs.
  const dataEnvelope = (description: string, dataSchema: Record<string, unknown> = { type: "object" }) => ({
    description,
    content: {
      "application/json": {
        schema: { type: "object", properties: { data: dataSchema }, required: ["data"] },
      },
    },
  });
  const errorResponse = (description: string) => ({
    description,
    content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
  });

  const ownerRepoParams = [
    { name: "owner", in: "path", required: true, schema: { type: "string" }, description: "Repository owner / org login." },
    { name: "repo", in: "path", required: true, schema: { type: "string" }, description: "Repository name." },
  ];
  const prNumberParam = {
    name: "number",
    in: "path",
    required: true,
    schema: { type: "integer", minimum: 1 },
    description: "Pull request number.",
  };

  const common401 = { 401: errorResponse("Authentication required (no valid session or bearer token).") };
  const common403 = { 403: errorResponse("Forbidden — your role or token scope does not permit this.") };

  return {
    openapi: "3.0.3",
    info: {
      title: "DiffSentry Platform API",
      version: "1.0.0",
      description:
        "Programmatic access to DiffSentry review data and a safe subset of review actions.\n\n" +
        "**Authentication.** Two schemes are accepted on every endpoint:\n" +
        "- **Bearer token** (`Authorization: Bearer dsk_…`) — for scripts and integrations. " +
        "Create tokens in the dashboard's *API Tokens* screen. Scopes: `read` (all GET " +
        "endpoints) and `review` (the action subset). Admin endpoints are never reachable " +
        "by a token.\n" +
        "- **Cookie session** (`ds_session`) — the dashboard SPA. Mutating cookie requests " +
        "also require the `X-CSRF-Token` header (double-submit of the `ds_csrf` cookie); " +
        "bearer requests are exempt from CSRF.\n\n" +
        "**Envelope.** Success responses are `{ \"data\": … }`; errors are " +
        "`{ \"error\": { \"code\", \"message\" } }`.",
    },
    servers: [{ url: server }],
    tags: [
      { name: "meta", description: "Identity, health, and the spec itself." },
      { name: "repos", description: "Repositories, pull requests, and reviews." },
      { name: "findings", description: "Findings explorer and pattern rules." },
      { name: "actions", description: "Mutating review actions (author / review-scope)." },
      { name: "realtime", description: "Server-Sent Events stream." },
      { name: "admin", description: "Audit log, role and API-token administration (admin, cookie session only)." },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description: "An API token (`dsk_…`). Send as `Authorization: Bearer <token>`.",
        },
        cookieAuth: {
          type: "apiKey",
          in: "cookie",
          name: "ds_session",
          description: "The dashboard OAuth session cookie.",
        },
      },
      schemas: {
        Error: {
          type: "object",
          properties: {
            error: {
              type: "object",
              properties: {
                code: { type: "string", example: "forbidden" },
                message: { type: "string" },
              },
              required: ["code", "message"],
            },
          },
          required: ["error"],
        },
        Me: {
          type: "object",
          properties: {
            user: {
              type: "object",
              properties: {
                login: { type: "string" },
                id: { type: "integer" },
                role: { type: "string", enum: ["viewer", "author", "admin"] },
                capabilities: { type: "object", additionalProperties: { type: "boolean" } },
              },
            },
            authEnabled: { type: "boolean" },
          },
        },
        ApiTokenMeta: {
          type: "object",
          properties: {
            id: { type: "integer" },
            name: { type: "string", nullable: true },
            scopes: { type: "array", items: { type: "string", enum: [...API_SCOPES] } },
            created_by: { type: "string", nullable: true },
            created_at: { type: "string", nullable: true, format: "date-time" },
            last_used_at: { type: "string", nullable: true, format: "date-time" },
            revoked_at: { type: "string", nullable: true, format: "date-time" },
          },
        },
      },
    },
    // Either scheme satisfies auth on every operation unless overridden.
    security: [{ bearerAuth: [] }, { cookieAuth: [] }],
    paths: {
      "/openapi.json": {
        get: {
          tags: ["meta"],
          summary: "This OpenAPI document",
          description: "The machine-readable API description. Public — no authentication required.",
          security: [],
          responses: { 200: { description: "The OpenAPI 3 document." } },
        },
      },
      "/me": {
        get: {
          tags: ["meta"],
          summary: "Current principal, role, and capabilities",
          responses: {
            200: dataEnvelope("The resolved user/token, role, and capability flags.", { $ref: "#/components/schemas/Me" }),
            ...common401,
          },
        },
      },
      "/health": {
        get: {
          tags: ["meta"],
          summary: "Persistence counts + recent warnings",
          responses: { 200: dataEnvelope("Row counts and the in-memory warn/error log ring."), ...common401 },
        },
      },
      "/repos": {
        get: {
          tags: ["repos"],
          summary: "Repository overview + daily activity",
          responses: { 200: dataEnvelope("All known repos with rollups, plus 14-day activity."), ...common401, ...common403 },
        },
      },
      "/repos/{owner}/{repo}": {
        get: {
          tags: ["repos"],
          summary: "Repository detail",
          parameters: ownerRepoParams,
          responses: {
            200: dataEnvelope("Sparkline, hot paths, top rules, recent PRs/issues, learnings, config."),
            404: errorResponse("No data for that repository."),
            ...common401,
            ...common403,
          },
        },
      },
      "/repos/{owner}/{repo}/prs/{number}": {
        get: {
          tags: ["repos"],
          summary: "Pull request detail",
          parameters: [...ownerRepoParams, prNumberParam],
          responses: {
            200: dataEnvelope("The PR, its reviews, findings, and event timeline."),
            400: errorResponse("Invalid PR number."),
            404: errorResponse("No data for that PR."),
            ...common401,
            ...common403,
          },
        },
      },
      "/findings": {
        get: {
          tags: ["findings"],
          summary: "Findings explorer",
          parameters: [
            { name: "severity", in: "query", schema: { type: "string", enum: ["critical", "major", "minor", "nit"] } },
            { name: "source", in: "query", schema: { type: "string" } },
            { name: "repo", in: "query", schema: { type: "string" }, description: "Filter by `owner/repo`." },
            { name: "q", in: "query", schema: { type: "string" }, description: "Free-text match on title/path." },
            { name: "fingerprint", in: "query", schema: { type: "string" } },
            { name: "age", in: "query", schema: { type: "integer" }, description: "Max age in days." },
            { name: "limit", in: "query", schema: { type: "integer", default: 100 } },
            { name: "offset", in: "query", schema: { type: "integer", default: 0 } },
          ],
          responses: { 200: dataEnvelope("Matching findings, total count, and fingerprint groups."), ...common401, ...common403 },
        },
      },
      "/patterns": {
        get: {
          tags: ["findings"],
          summary: "Pattern rule hit rollup",
          responses: { 200: dataEnvelope("Pattern rules with total / 30-day hit counts."), ...common401, ...common403 },
        },
      },
      "/stream": {
        get: {
          tags: ["realtime"],
          summary: "Server-Sent Events stream",
          description:
            "A `text/event-stream` of review-lifecycle and action events. Supports " +
            "`Last-Event-ID` replay. Any authenticated principal with `read` may subscribe.",
          responses: {
            200: { description: "An event stream (`text/event-stream`).", content: { "text/event-stream": {} } },
            ...common401,
          },
        },
      },
      "/repos/{owner}/{repo}/prs/{number}/review": {
        post: {
          tags: ["actions"],
          summary: "Trigger a review (full | incremental)",
          description: "Requires the `author` role or a token with the `review` scope. Returns 202; lifecycle events arrive over `/stream`.",
          parameters: [...ownerRepoParams, prNumberParam],
          requestBody: {
            required: false,
            content: {
              "application/json": {
                schema: { type: "object", properties: { mode: { type: "string", enum: ["full", "incremental"], default: "incremental" } } },
              },
            },
          },
          responses: {
            202: dataEnvelope("Review accepted and queued."),
            404: errorResponse("No installation on record for that repo."),
            ...common401,
            ...common403,
          },
        },
      },
      "/repos/{owner}/{repo}/prs/{number}/resolve": {
        post: {
          tags: ["actions"],
          summary: "Resolve all DiffSentry review threads",
          parameters: [...ownerRepoParams, prNumberParam],
          responses: { 200: dataEnvelope("Threads resolved."), 404: errorResponse("No installation."), ...common401, ...common403 },
        },
      },
      "/repos/{owner}/{repo}/prs/{number}/pause": {
        post: {
          tags: ["actions"],
          summary: "Pause automatic + manual reviews for a PR",
          parameters: [...ownerRepoParams, prNumberParam],
          responses: { 200: dataEnvelope("Reviews paused."), ...common401, ...common403 },
        },
      },
      "/repos/{owner}/{repo}/prs/{number}/resume": {
        post: {
          tags: ["actions"],
          summary: "Resume reviews for a PR",
          parameters: [...ownerRepoParams, prNumberParam],
          responses: { 200: dataEnvelope("Reviews resumed."), ...common401, ...common403 },
        },
      },
      "/repos/{owner}/{repo}/prs/{number}/cancel": {
        post: {
          tags: ["actions"],
          summary: "Abort any in-flight review",
          parameters: [...ownerRepoParams, prNumberParam],
          responses: { 200: dataEnvelope("In-flight review cancelled."), ...common401, ...common403 },
        },
      },
      "/audit": {
        get: {
          tags: ["admin"],
          summary: "Audit trail + role overrides (admin)",
          description: "Admin only, cookie session only — not reachable with an API token.",
          security: [{ cookieAuth: [] }],
          parameters: [
            { name: "action", in: "query", schema: { type: "string" } },
            { name: "actor", in: "query", schema: { type: "string" } },
            { name: "limit", in: "query", schema: { type: "integer", default: 100 } },
            { name: "offset", in: "query", schema: { type: "integer", default: 0 } },
          ],
          responses: { 200: dataEnvelope("Audit rows, total, distinct actions, role overrides."), ...common401, ...common403 },
        },
      },
      "/roles": {
        post: {
          tags: ["admin"],
          summary: "Grant or clear a per-login role override (admin)",
          security: [{ cookieAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    login: { type: "string" },
                    role: { type: "string", nullable: true, enum: ["viewer", "author", "admin", null] },
                  },
                  required: ["login"],
                },
              },
            },
          },
          responses: { 200: dataEnvelope("Override set or cleared."), 400: errorResponse("Bad request."), ...common401, ...common403 },
        },
      },
      "/tokens": {
        get: {
          tags: ["admin"],
          summary: "List API tokens (admin)",
          security: [{ cookieAuth: [] }],
          responses: {
            200: dataEnvelope("Token metadata (never the secret) + available scopes.", {
              type: "object",
              properties: {
                tokens: { type: "array", items: { $ref: "#/components/schemas/ApiTokenMeta" } },
                availableScopes: { type: "array", items: { type: "string" } },
              },
            }),
            ...common401,
            ...common403,
          },
        },
        post: {
          tags: ["admin"],
          summary: "Create an API token (admin)",
          description: "Returns the plaintext token **once**. Store it now — it cannot be retrieved again.",
          security: [{ cookieAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    scopes: { type: "array", items: { type: "string", enum: [...API_SCOPES] } },
                  },
                  required: ["name"],
                },
              },
            },
          },
          responses: {
            201: dataEnvelope("The created token, including the one-time secret.", {
              type: "object",
              properties: {
                id: { type: "integer" },
                name: { type: "string" },
                scopes: { type: "array", items: { type: "string" } },
                token: { type: "string", description: "The plaintext token — shown only here." },
              },
            }),
            400: errorResponse("A non-empty name is required."),
            ...common401,
            ...common403,
          },
        },
      },
      "/tokens/{id}": {
        delete: {
          tags: ["admin"],
          summary: "Revoke an API token (admin)",
          security: [{ cookieAuth: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
          responses: { 200: dataEnvelope("Whether the token transitioned to revoked."), ...common401, ...common403 },
        },
      },
    },
  };
}
