import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TOOLS, dispatch, createApiClient, type ApiClient } from "../../src/mcp/server.js";

// Captures what the server writes to stdout — which is the protocol channel and
// must carry nothing else.
const sent: Array<Record<string, unknown>> = [];

beforeEach(() => {
  sent.length = 0;
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    for (const line of String(chunk).split("\n")) {
      if (line.trim()) sent.push(JSON.parse(line));
    }
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

const requests: Array<{ method: string; path: string; body?: unknown }> = [];
function fakeApi(result: unknown | (() => never)): ApiClient {
  return {
    request: async (method: string, path: string, body?: unknown) => {
      requests.push({ method, path, body });
      return typeof result === "function" ? (result as () => never)() : result;
    },
  } as unknown as ApiClient;
}

const api = fakeApi({ ok: true });

describe("mcp server protocol", () => {
  it("answers initialize with the client's protocol version when it knows it", async () => {
    await dispatch({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } }, api);
    expect(sent[0].result).toMatchObject({
      protocolVersion: "2024-11-05",
      capabilities: { tools: { listChanged: false } },
    });
  });

  it("falls back to its own protocol version for an unknown one", async () => {
    await dispatch({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "1999-01-01" } }, api);
    expect((sent[0].result as { protocolVersion: string }).protocolVersion).toBe("2025-06-18");
  });

  it("lists every tool with a schema", async () => {
    await dispatch({ jsonrpc: "2.0", id: 2, method: "tools/list" }, api);
    const tools = (sent[0].result as { tools: Array<{ name: string; inputSchema: unknown; description: string }> }).tools;
    expect(tools.map((t) => t.name).sort()).toEqual(["get_pr_findings", "list_repos", "request_review", "search_findings"]);
    for (const t of tools) {
      expect(t.description.length).toBeGreaterThan(20);
      expect(t.inputSchema).toMatchObject({ type: "object" });
    }
  });

  // A notification carries no id, so answering it would desynchronise the client.
  it("stays silent on notifications/initialized", async () => {
    await dispatch({ jsonrpc: "2.0", method: "notifications/initialized" }, api);
    expect(sent).toHaveLength(0);
  });

  it("rejects an unknown method with a JSON-RPC error", async () => {
    await dispatch({ jsonrpc: "2.0", id: 3, method: "resources/list" }, api);
    expect(sent[0].error).toMatchObject({ code: -32601 });
  });

  // A failed tool must come back as a successful RPC carrying isError, so the
  // model can read the reason instead of the transport dying under it.
  it("reports a tool failure as an isError result, not a transport error", async () => {
    const failing = fakeApi(() => {
      throw new Error("GET /repos failed (HTTP 403): token lacks the 'review' scope");
    });
    await dispatch(
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "list_repos", arguments: {} } },
      failing,
    );
    expect(sent[0].error).toBeUndefined();
    const result = sent[0].result as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("403");
  });

  it("reports an unknown tool as an isError result", async () => {
    await dispatch({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "rm_rf", arguments: {} } }, api);
    expect((sent[0].result as { isError: boolean }).isError).toBe(true);
  });
});

describe("mcp tool arguments", () => {
  const tool = (name: string) => TOOLS.find((t) => t.name === name)!;

  beforeEach(() => {
    requests.length = 0;
  });

  it("accepts the repo as owner/repo", async () => {
    await tool("get_pr_findings").run({ repo: "acme/app", number: 12 }, fakeApi({}));
    expect(requests[0].path).toBe("/repos/acme/app/prs/12");
  });

  it("accepts owner and repo as separate fields", async () => {
    await tool("get_pr_findings").run({ owner: "acme", repo: "app", number: "12" }, fakeApi({}));
    expect(requests[0].path).toBe("/repos/acme/app/prs/12");
  });

  it("names the offending field when the repo is unusable", async () => {
    await expect(tool("get_pr_findings").run({ number: 12 }, fakeApi({}))).rejects.toThrow(/owner\/repo/);
  });

  it("percent-encodes path segments", async () => {
    await tool("get_pr_findings").run({ owner: "a b", repo: "c/d", number: 1 }, fakeApi({}));
    expect(requests[0].path).toBe("/repos/c/d/prs/1");
  });

  it("clamps the findings limit", async () => {
    await tool("search_findings").run({ limit: 9999 }, fakeApi({}));
    expect(requests[0].path).toContain("limit=200");
  });

  it("defaults request_review to incremental and only allows the two modes", async () => {
    await tool("request_review").run({ repo: "acme/app", number: 3, mode: "nonsense" }, fakeApi({}));
    expect(requests[0]).toMatchObject({ method: "POST", body: { mode: "incremental" } });
    await tool("request_review").run({ repo: "acme/app", number: 3, mode: "full" }, fakeApi({}));
    expect(requests[1].body).toMatchObject({ mode: "full" });
  });
});

// `main` answers requests in arrival order, so an unbounded fetch blocks every
// MCP request queued behind it, not just its own.
describe("mcp request deadline", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("passes an abort signal to every outbound request", async () => {
    let seen: RequestInit | undefined;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      seen = init;
      return new Response('{"data":{}}', { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;
    const client = createApiClient({ DIFFSENTRY_URL: "https://x", DIFFSENTRY_TOKEN: "dsk_x" });
    await client.request("GET", "/repos");
    expect(seen?.signal).toBeInstanceOf(AbortSignal);
  });

  it("turns a timed-out request into a readable tool error", async () => {
    globalThis.fetch = (async () => {
      const err = new Error("The operation was aborted due to timeout");
      err.name = "TimeoutError";
      throw err;
    }) as unknown as typeof fetch;
    const client = createApiClient({ DIFFSENTRY_URL: "https://x", DIFFSENTRY_TOKEN: "dsk_x" });
    await dispatch(
      { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "list_repos", arguments: {} } },
      client,
    );
    const result = sent[0].result as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/timed out after 30s/);
    expect(result.content[0].text).toContain("DIFFSENTRY_URL");
  });
});

describe("mcp configuration", () => {
  it("requires a URL and a token, and says which is missing", () => {
    expect(() => createApiClient({ DIFFSENTRY_TOKEN: "dsk_x" })).toThrow(/DIFFSENTRY_URL/);
    expect(() => createApiClient({ DIFFSENTRY_URL: "https://x" })).toThrow(/DIFFSENTRY_TOKEN/);
    expect(() => createApiClient({ DIFFSENTRY_URL: "https://x", DIFFSENTRY_TOKEN: "dsk_x" })).not.toThrow();
  });
});
