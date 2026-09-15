import type { IncomingMessage, ServerResponse } from "node:http";
import type { Store } from "../store.js";
import { ownerId, readBody, sendJson } from "./respond.js";

/** `POST /reports`: creates a report for the requesting owner. */
export async function handleCreate(req: IncomingMessage, res: ServerResponse, store: Store): Promise<void> {
  const owner = ownerId(req);
  if (!owner) {
    sendJson(res, 400, { error: "missing x-owner-id header" });
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

  const report = store.insert({ ownerId: owner, title, body });
  sendJson(res, 201, report);
}
