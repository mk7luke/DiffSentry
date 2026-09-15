import type { IncomingMessage, ServerResponse } from "node:http";
import type { Store } from "../store.js";

export type RouteHandler = (req: IncomingMessage, res: ServerResponse, store: Store) => void | Promise<void>;

export type Route = {
  method: string;
  path: string;
  handler: RouteHandler;
};
