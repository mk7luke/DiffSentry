import type { Route } from "./types.js";
import { handleList } from "./list.js";
import { handleCreate } from "./create.js";

/** The route table `createRouter` dispatches against. */
export const routes: Route[] = [
  { method: "GET", path: "/reports", handler: handleList },
  { method: "POST", path: "/reports", handler: handleCreate },
];
