import type { IncomingMessage, ServerResponse } from "node:http";
import type { Store } from "./store.js";
import { routes } from "./routes/index.js";
import { sendJson } from "./routes/respond.js";

/** Builds the request handler by dispatching to the route table. */
export function createRouter(store: Store): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    const match = routes.find((r) => r.path === req.url && r.method === req.method);
    if (match) {
      void match.handler(req, res, store);
      return;
    }

    const pathMatches = routes.some((r) => r.path === req.url);
    if (pathMatches) {
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }

    sendJson(res, 404, { error: "not found" });
  };
}
