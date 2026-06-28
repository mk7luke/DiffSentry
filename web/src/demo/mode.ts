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

export const DEMO_BASENAME = "/demo";

/** True when the current location's path is the /demo route (or a sub-route). */
export function demoPathActive(): boolean {
  if (typeof window === "undefined") return false;
  const p = window.location.pathname;
  return p === DEMO_BASENAME || p.startsWith(DEMO_BASENAME + "/");
}

/** True when ?demo=true is present in the query string. */
function demoQueryFlag(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("demo") === "true";
}

/**
 * Whether the app is running in demo mode. Evaluated once at module load.
 * `?demo=true` at any path counts as demo too; main.tsx redirects those to the
 * canonical /demo route so React Router's basename stays consistent.
 */
export const DEMO: boolean = demoPathActive() || demoQueryFlag();
