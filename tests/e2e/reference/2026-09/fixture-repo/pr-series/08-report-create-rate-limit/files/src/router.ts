import type { IncomingMessage, ServerResponse } from "node:http";
import type { Store } from "./store.js";

const OWNER_HEADER = "x-owner-id";
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 30;

const requestCounts = new Map<string, { count: number; windowStart: number }>();

function isRateLimited(owner: string, now: number): boolean {
  const entry = requestCounts.get(owner);
  if (!entry || now - entry.windowStart >= RATE_LIMIT_WINDOW_MS) {
    requestCounts.set(owner, { count: 1, windowStart: now });
    return false;
  }
  entry.count += 1;
  return entry.count > RATE_LIMIT_MAX;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(payload);
}

function ownerId(req: IncomingMessage): string | undefined {
  const header = req.headers[OWNER_HEADER];
  return Array.isArray(header) ? header[0] : header;
}

async function handleList(req: IncomingMessage, res: ServerResponse, store: Store): Promise<void> {
  const owner = ownerId(req);
  if (!owner) {
    sendJson(res, 400, { error: `missing ${OWNER_HEADER} header` });
    return;
  }
  sendJson(res, 200, store.list(owner));
}

async function handleCreate(req: IncomingMessage, res: ServerResponse, store: Store): Promise<void> {
  const owner = ownerId(req);
  if (!owner) {
    sendJson(res, 400, { error: `missing ${OWNER_HEADER} header` });
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readBody(req));
  } catch {
    sendJson(res, 400, { error: "invalid JSON body" });
    return;
  }

  const { title, body } = (parsed ?? {}) as { title?: unknown; body?: unknown };
  if (typeof title !== "string" || title.trim() === "" || typeof body !== "string" || body.trim() === "") {
    sendJson(res, 400, { error: "title and body must be non-empty strings" });
    return;
  }

  if (isRateLimited(owner, Date.now())) {
    sendJson(res, 429, { error: "too many reports created recently, try again shortly" });
    return;
  }

  const report = store.insert({ ownerId: owner, title: title.trim(), body: body.trim() });
  sendJson(res, 201, report);
}

/** Builds the `/reports` request handler for the given store. */
export function createRouter(store: Store): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    if (req.url !== "/reports") {
      sendJson(res, 404, { error: "not found" });
      return;
    }

    if (req.method === "GET") {
      void handleList(req, res, store);
      return;
    }

    if (req.method === "POST") {
      void handleCreate(req, res, store);
      return;
    }

    sendJson(res, 405, { error: "method not allowed" });
  };
}
