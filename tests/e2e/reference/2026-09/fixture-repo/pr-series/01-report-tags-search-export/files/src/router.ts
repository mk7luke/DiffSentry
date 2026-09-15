import type { IncomingMessage, ServerResponse } from "node:http";
import type { Report } from "./store.js";
import type { Store } from "./store.js";
import { buildTagDigest } from "./tags.js";
import { exportReportsArchive } from "./export.js";

const OWNER_HEADER = "x-owner-id";

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

  const { title, body, tags } = (parsed ?? {}) as { title?: unknown; body?: unknown; tags?: unknown };
  if (typeof title !== "string" || title.trim() === "" || typeof body !== "string" || body.trim() === "") {
    sendJson(res, 400, { error: "title and body must be non-empty strings" });
    return;
  }

  const tagList = Array.isArray(tags) ? tags.filter((t): t is string => typeof t === "string") : [];
  const report = store.insert({ ownerId: owner, title, body, tags: tagList });
  sendJson(res, 201, report);
}

async function handleUpdate(req: IncomingMessage, res: ServerResponse, store: Store): Promise<void> {
  const owner = ownerId(req);
  if (!owner) {
    sendJson(res, 400, { error: `missing ${OWNER_HEADER} header` });
    return;
  }

  const url = new URL(req.url ?? "/reports", "http://internal");
  const idParam = url.searchParams.get("id");
  const id = idParam ? Number(idParam) : NaN;
  if (!Number.isInteger(id)) {
    sendJson(res, 400, { error: "id query parameter must be an integer" });
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
  const patch: Partial<Pick<Report, "title" | "body">> = {};
  if (typeof title === "string" && title.trim() !== "") patch.title = title;
  if (typeof body === "string" && body.trim() !== "") patch.body = body;

  const updated = store.update(id, patch);
  if (!updated) {
    sendJson(res, 404, { error: "report not found" });
    return;
  }
  sendJson(res, 200, updated);
}

async function handleDigest(req: IncomingMessage, res: ServerResponse, store: Store): Promise<void> {
  const owner = ownerId(req);
  if (!owner) {
    sendJson(res, 400, { error: `missing ${OWNER_HEADER} header` });
    return;
  }
  const digest = await buildTagDigest(store.list(owner));
  sendJson(res, 200, digest);
}

async function handleExport(req: IncomingMessage, res: ServerResponse, store: Store): Promise<void> {
  const owner = ownerId(req);
  if (!owner) {
    sendJson(res, 400, { error: `missing ${OWNER_HEADER} header` });
    return;
  }
  const archive = await exportReportsArchive(owner, store.list(owner));
  res.writeHead(200, { "content-type": "application/zip" });
  res.end(archive);
}

/** Builds the `/reports` request handler for the given store. */
export function createRouter(store: Store): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    const url = new URL(req.url ?? "/", "http://internal");

    if (url.pathname === "/reports") {
      if (req.method === "GET") {
        void handleList(req, res, store);
        return;
      }
      if (req.method === "POST") {
        void handleCreate(req, res, store);
        return;
      }
      if (req.method === "PATCH") {
        void handleUpdate(req, res, store);
        return;
      }
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }

    if (url.pathname === "/reports/digest" && req.method === "GET") {
      void handleDigest(req, res, store);
      return;
    }

    if (url.pathname === "/reports/export" && req.method === "POST") {
      void handleExport(req, res, store);
      return;
    }

    sendJson(res, 404, { error: "not found" });
  };
}
