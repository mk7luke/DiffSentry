import type { IncomingMessage, ServerResponse } from "node:http";
import type { Store } from "../store.js";
import { ownerId, sendJson } from "./respond.js";

/** `GET /reports`: lists the requesting owner's reports. */
export async function handleList(req: IncomingMessage, res: ServerResponse, store: Store): Promise<void> {
  const owner = ownerId(req);
  if (!owner) {
    sendJson(res, 400, { error: "missing x-owner-id header" });
    return;
  }
  sendJson(res, 200, store.list(owner));
}
