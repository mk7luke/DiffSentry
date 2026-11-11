#!/usr/bin/env node
/**
 * DiffSentry MCP server — the findings, in the agent that has to fix them.
 *
 * The platform API has always been able to hand a coding agent the findings on
 * a PR; getting them there meant a human copying a curl response into a prompt.
 * This is that same API spoken over MCP (stdio), so Claude Code, Cursor or any
 * MCP client can ask for them directly.
 *
 * It is a CLIENT of the HTTP API, not a second way into the database: it holds
 * no DB handle, mints nothing, and can do exactly what its bearer token's scopes
 * allow. A `read` token cannot trigger a review, because the server it talks to
 * says no — the authorization story stays in one place.
 *
 * Protocol is implemented directly rather than through an SDK. It is JSON-RPC
 * 2.0 over newline-delimited stdio and four tools; a dependency would be larger
 * than the thing it implements, and this repo keeps its runtime dependency list
 * short on purpose.
 *
 * Run it with:
 *   DIFFSENTRY_URL=https://your-instance DIFFSENTRY_TOKEN=dsk_... node dist/mcp/server.js
 */

/** Versions of the MCP spec this server is known to speak. */
const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const DEFAULT_PROTOCOL = SUPPORTED_PROTOCOLS[0];

/**
 * stdout is the protocol channel and nothing else may touch it — a single stray
 * log line makes the server unparseable to its client. This is also why the
 * module never imports the app's pino logger, which writes to stdout.
 */
function log(message: string, extra?: unknown): void {
  const suffix = extra === undefined ? "" : ` ${JSON.stringify(extra)}`;
  process.stderr.write(`[diffsentry-mcp] ${message}${suffix}\n`);
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  /** Returns the text the client sees. Throwing produces a tool error, not a transport error. */
  run: (args: Record<string, unknown>, api: ApiClient) => Promise<unknown>;
}

// ─── HTTP client ────────────────────────────────────────────────────

export class ApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  /**
   * `path` is relative to the `/api/v1` mount. The API's error envelope carries
   * a human-readable message, so it is surfaced verbatim — a 403 saying the
   * token lacks the `review` scope is exactly what the agent needs to read.
   */
  async request(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    const url = `${this.baseUrl}/api/v1${path}`;
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      // Left as text — an HTML error page from a proxy in front of the instance
      // is more useful to show than a parse failure about it.
    }
    if (!res.ok) {
      const envelope = parsed as { error?: { message?: string; code?: string } } | null;
      const detail = envelope?.error?.message ?? (typeof parsed === "string" ? parsed.slice(0, 400) : "");
      throw new Error(`${method} ${path} failed (HTTP ${res.status})${detail ? `: ${detail}` : ""}`);
    }
    // Every API response is wrapped in `{ data: ... }`; unwrap so a tool result
    // is the payload itself rather than a layer the model has to dig through.
    const envelope = parsed as { data?: unknown } | null;
    return envelope && typeof envelope === "object" && "data" in envelope ? envelope.data : parsed;
  }
}

// ─── Argument coercion ──────────────────────────────────────────────
//
// An MCP client's arguments are whatever the model produced, so nothing here
// trusts a type. A number arriving as "42" is the common case and is accepted;
// anything genuinely unusable raises a tool error naming the field.

function str(args: Record<string, unknown>, key: string, required: true): string;
function str(args: Record<string, unknown>, key: string, required?: false): string | undefined;
function str(args: Record<string, unknown>, key: string, required = false): string | undefined {
  const v = args[key];
  if (typeof v === "string" && v.trim().length > 0) return v.trim();
  if (typeof v === "number") return String(v);
  if (required) throw new Error(`Missing required argument '${key}'.`);
  return undefined;
}

function int(args: Record<string, unknown>, key: string, required = false): number | undefined {
  const v = args[key];
  const n = typeof v === "number" ? v : typeof v === "string" ? Number.parseInt(v, 10) : NaN;
  if (Number.isFinite(n)) return n;
  if (required) throw new Error(`Argument '${key}' must be a number.`);
  return undefined;
}

/** `owner/repo` or separate fields — models reliably produce both shapes. */
function repoCoords(args: Record<string, unknown>): { owner: string; repo: string } {
  const combined = str(args, "repo");
  if (combined?.includes("/")) {
    const [owner, repo] = combined.split("/", 2);
    if (owner && repo) return { owner, repo };
  }
  const owner = str(args, "owner");
  if (owner && combined) return { owner, repo: combined };
  throw new Error("Provide the repository as 'owner/repo', or as separate 'owner' and 'repo' arguments.");
}

const q = encodeURIComponent;

// ─── Tools ──────────────────────────────────────────────────────────

export const TOOLS: ToolDef[] = [
  {
    name: "list_repos",
    description:
      "List the repositories DiffSentry has reviewed, with review counts and when each was last reviewed. " +
      "Start here when you do not already know the exact 'owner/repo'.",
    inputSchema: { type: "object", properties: {} },
    run: async (_args, api) => api.request("GET", "/repos"),
  },
  {
    name: "get_pr_findings",
    description:
      "Every DiffSentry finding on one pull request, with the latest review's summary, risk score and verdict. " +
      "This is the tool to call before fixing review comments: each finding carries its file, line, severity and body.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "'owner/repo' (or just the repo name alongside 'owner')." },
        owner: { type: "string", description: "Repository owner, when 'repo' is not 'owner/repo'." },
        number: { type: "number", description: "Pull request number." },
      },
      required: ["repo", "number"],
    },
    run: async (args, api) => {
      const { owner, repo } = repoCoords(args);
      const number = int(args, "number", true)!;
      return api.request("GET", `/repos/${q(owner)}/${q(repo)}/prs/${number}`);
    },
  },
  {
    name: "search_findings",
    description:
      "Search findings across repositories — by severity, source, repo, age, or free text on the title and path. " +
      "Use it to find whether an issue has been raised before, or to sweep up every open finding of a severity.",
    inputSchema: {
      type: "object",
      properties: {
        severity: { type: "string", enum: ["critical", "major", "minor", "nit"] },
        source: { type: "string", description: "e.g. 'ai', 'safety', 'builtin', 'custom'." },
        repo: { type: "string", description: "Restrict to one 'owner/repo'." },
        query: { type: "string", description: "Free-text match on the finding title or path." },
        age_days: { type: "number", description: "Only findings newer than this many days." },
        limit: { type: "number", description: "Max results (default 50)." },
      },
    },
    run: async (args, api) => {
      const params = new URLSearchParams();
      const severity = str(args, "severity");
      if (severity) params.set("severity", severity);
      const source = str(args, "source");
      if (source) params.set("source", source);
      const repo = str(args, "repo");
      if (repo) params.set("repo", repo);
      const query = str(args, "query");
      if (query) params.set("q", query);
      const age = int(args, "age_days");
      if (age !== undefined) params.set("age", String(age));
      params.set("limit", String(Math.min(Math.max(int(args, "limit") ?? 50, 1), 200)));
      return api.request("GET", `/findings?${params.toString()}`);
    },
  },
  {
    name: "request_review",
    description:
      "Ask DiffSentry to review a pull request — 'incremental' (default) reviews what changed since the last pass, " +
      "'full' re-reviews every file. Returns as soon as the review is queued, so call get_pr_findings afterwards to " +
      "read the result. Requires a token with the 'review' scope.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "'owner/repo' (or just the repo name alongside 'owner')." },
        owner: { type: "string", description: "Repository owner, when 'repo' is not 'owner/repo'." },
        number: { type: "number", description: "Pull request number." },
        mode: { type: "string", enum: ["incremental", "full"], description: "Defaults to 'incremental'." },
      },
      required: ["repo", "number"],
    },
    run: async (args, api) => {
      const { owner, repo } = repoCoords(args);
      const number = int(args, "number", true)!;
      const mode = str(args, "mode") === "full" ? "full" : "incremental";
      return api.request("POST", `/repos/${q(owner)}/${q(repo)}/prs/${number}/review`, { mode });
    },
  },
];

// ─── JSON-RPC plumbing ──────────────────────────────────────────────

type Json = Record<string, unknown>;

function send(msg: Json): void {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function reply(id: unknown, result: unknown): void {
  send({ jsonrpc: "2.0", id, result });
}

function replyError(id: unknown, code: number, message: string): void {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

/**
 * A failed tool is reported as a SUCCESSFUL JSON-RPC response carrying
 * `isError: true`, which is what the spec asks for: the model should see — and
 * be able to act on — "that repo does not exist" or "this token cannot trigger
 * reviews", not have the transport fail underneath it.
 */
async function handleToolCall(id: unknown, params: Json, api: ApiClient): Promise<void> {
  const name = typeof params.name === "string" ? params.name : "";
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) {
    reply(id, { content: [{ type: "text", text: `Unknown tool '${name}'.` }], isError: true });
    return;
  }
  const args = (params.arguments ?? {}) as Record<string, unknown>;
  try {
    const result = await tool.run(args, api);
    reply(id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`tool ${name} failed`, { message });
    reply(id, { content: [{ type: "text", text: message }], isError: true });
  }
}

export async function dispatch(msg: Json, api: ApiClient): Promise<void> {
  const { id, method, params } = msg as { id?: unknown; method?: string; params?: Json };
  // A notification has no id and takes no response — `notifications/initialized`
  // is the one every client sends.
  const isNotification = id === undefined || id === null;

  switch (method) {
    case "initialize": {
      const asked = (params?.protocolVersion as string | undefined) ?? "";
      const protocolVersion = SUPPORTED_PROTOCOLS.includes(asked) ? asked : DEFAULT_PROTOCOL;
      reply(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "diffsentry", version: "1.0.0" },
      });
      return;
    }
    case "tools/list":
      reply(id, {
        tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      });
      return;
    case "tools/call":
      await handleToolCall(id, params ?? {}, api);
      return;
    case "ping":
      reply(id, {});
      return;
    default:
      if (isNotification) return;
      replyError(id, -32601, `Method not found: ${method ?? "(none)"}`);
  }
}

// ─── Entry point ────────────────────────────────────────────────────

export function createApiClient(env: NodeJS.ProcessEnv = process.env): ApiClient {
  const baseUrl = (env.DIFFSENTRY_URL ?? "").trim().replace(/\/+$/, "");
  const token = (env.DIFFSENTRY_TOKEN ?? "").trim();
  if (!baseUrl) throw new Error("DIFFSENTRY_URL is required (e.g. https://diffsentry.example.com).");
  if (!token) throw new Error("DIFFSENTRY_TOKEN is required — mint one under API tokens in the dashboard.");
  return new ApiClient(baseUrl, token);
}

export async function main(): Promise<void> {
  const api = createApiClient();
  log(`ready — ${TOOLS.length} tools`);

  // Messages are newline-delimited, but a chunk boundary can fall anywhere, so
  // buffer and only act on complete lines.
  let buffer = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (line.length === 0) continue;
      let msg: Json;
      try {
        msg = JSON.parse(line) as Json;
      } catch {
        // No id to answer with, so there is nobody to tell. Logged and skipped.
        log("ignoring unparseable line");
        continue;
      }
      // Awaited in order: a client may pipeline requests, and answering them in
      // arrival order keeps the transcript readable. Tool calls are network
      // round trips to one instance, so there is nothing to win by racing them.
      await dispatch(msg, api).catch((err) => log("dispatch failed", { message: String(err) }));
    }
  }
}

// Only run as the entrypoint (`node dist/mcp/server.js` / `tsx
// src/mcp/server.ts`), matching src/cli/backfill.ts. Imported for its exports —
// which is how the tests reach the tool table — the module starts nothing and
// never touches stdin.
if (require.main === module) {
  main().catch((err) => {
    log("fatal", { message: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  });
}
