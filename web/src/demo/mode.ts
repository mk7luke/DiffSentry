// Demo / sandbox mode detection.
//
// Demo mode is a public, no-auth showcase of the dashboard UI backed entirely
// by bundled fixtures (see ./fixtures.ts). It is active when the SPA is served
// under the /demo route OR when ?demo=true is present in the query string.
//
// CRUCIAL SAFETY PROPERTY: when demo mode is active the API client (api/client.ts)
// answers every read from in-memory fixtures and refuses every write — it makes
// NO network request at all. So the demo can neither read nor mutate real data,
// regardless of what the server happens to expose. The server-side /demo route
// only serves the static SPA shell (see src/server.ts); it mounts no data API.

export const DEMO_PATH = "/demo"; // literal /demo route — used for URL detection only

/** True when the current location's path is the /demo route (or a sub-route). */
export function demoPathActive(): boolean {
  if (typeof window === "undefined") return false;
  const p = window.location.pathname;
  return p === DEMO_PATH || p.startsWith(DEMO_PATH + "/");
}

/** True when ?demo=true is present in the query string. */
function demoQueryFlag(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("demo") === "true";
}

/**
 * Build-time force flag. A `VITE_FORCE_DEMO=true` build (the standalone
 * demo.diffsentry.app site) is hard-locked to demo mode and served at the
 * domain root. Injected via `define` in vite.config.ts.
 */
export const FORCE_DEMO: boolean = import.meta.env.VITE_FORCE_DEMO === "true";

/** Whether the app is running in demo mode. Evaluated once at module load. */
export const DEMO: boolean = FORCE_DEMO || demoPathActive() || demoQueryFlag();

/**
 * React Router basename. A forced standalone build serves at root ("/"); a
 * normal build serves the demo under /demo. NOTE: detection above must never
 * use this constant — if it were "/", `startsWith("/")` matches every path.
 */
export const DEMO_BASENAME: string = FORCE_DEMO ? "/" : DEMO_PATH;
