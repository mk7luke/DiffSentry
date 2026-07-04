# Move the public demo to `demo.diffsentry.app` + refresh the marketing site

- **Date:** 2026-07-04
- **Status:** Approved (design)
- **Scope:** cross-repo (`DiffSentry`, `DiffSentry-site`) + Cloudflare Tunnel infra
- **Owner:** luke

## Problem

The public demo is currently served from the operator's **real** DiffSentry
instance at `api.diffsentry.app` (same origin the operator uses day-to-day). We
want the demo off the personal instance and onto its own home so the real
instance carries no public, unauthenticated surface. Separately, the marketing
site (`diffsentry.app`) has **zero "Sync site" commits** and ~50 product PRs of
drift — its copy no longer matches what the product does.

Two goals:

1. **Move the demo** off `api.diffsentry.app` to a dedicated host.
2. **Update the marketing site** content to reflect the current product, and
   link to the relocated demo.

## Key facts (from codebase exploration)

- **The demo is the whole dashboard SPA in "demo mode,"** not a page. It is the
  same `web/dist` Vite/React bundle as the authenticated dashboard, keyed on URL:
  `/demo` path or `?demo=true` (`web/src/demo/mode.ts:13-33`).
- **In demo mode it makes zero network calls.** Every read resolves from bundled
  client-side fixtures (`web/src/demo/fixtures.ts`); every write is refused
  client-side (`web/src/api/client.ts:47,109`). No AI, no SQLite, no auth, no
  `.diffsentry.yaml`. It is already effectively a static app.
- **Server coupling is thin:** the same Express process serves the SPA shell for
  `/demo`, gated by `DISABLE_DEMO` (`src/server.ts:63-72`). Turning that off on
  the real instance fully removes the public demo there.
- **The marketing site is a no-build-step vanilla page** — `index.html` + `app.js`
  + Tailwind CDN, served by nginx in Docker. It was deliberately simplified to a
  single screen on 2026-06-05. It has **no demo link today**; all CTAs point to
  the GitHub repo. Its CSP forbids inline scripts; assets are `immutable` for 30d
  and gated behind an `asset-version` meta (currently `v13`) + `?v=N` query
  strings; every served file is a per-file `COPY` in the Dockerfile.
- **Do not confuse the demo with the Public Impact share** feature
  (`/share/impact/:id`, `DISABLE_PUBLIC_SHARE`) — that one is DB-backed and out of
  scope.

## Goals / Non-goals

**Goals**
- Serve the demo at **`demo.diffsentry.app`**, independent of the real instance.
- Demo serves at the domain **root** with clean URLs (no `/demo` prefix in the
  public URL).
- Real instance (`api.diffsentry.app`) stops serving the demo.
- Marketing site copy is accurate to the current product and links to the demo.

**Non-goals**
- No change to the demo's fixture data or the dashboard UI itself.
- No rebuild of the marketing site off its no-build-step vanilla stack.
- No change to the Public Impact share feature.
- No new hosting paradigm (stay on containers behind the existing cloudflared
  tunnel; Cloudflare Pages noted only as an alternative).

## Decision 1 — Host: `demo.diffsentry.app` (subdomain), not `diffsentry.app/demo`

On cloudflared, a subdomain is materially cleaner than a subpath:

| | `demo.diffsentry.app` (chosen) | `diffsentry.app/demo` |
|---|---|---|
| Tunnel config | one public hostname → auto DNS | order-sensitive `^/demo` path ingress rule |
| Demo build | served at root, standard Vite `base:"/"` | needs `base:"/demo/"` or vendored bundle in site nginx |
| Marketing site | untouched (one link) | image/route entangled with a heavy React bundle |
| Redeploys | demo rebuilds independently | coupled |

The only thing the subpath buys is a single domain in the URL, which does not
justify the routing entanglement.

## Decision 2 — Force demo mode at build time; serve at root

Add a build-time flag so a standalone build is hard-locked to demo mode and
served at `/` (no `/demo` prefix). Small, additive, and preserves all existing
behavior (`/demo` path and `?demo=true` still work on any normal build).

Product-repo changes (`DiffSentry`):

- **`web/src/demo/mode.ts`** — introduce a build-time force flag and fold it into
  the exported `DEMO`. Keep the **detection** path (`/demo`) separate from the
  **router basename** so force mode doesn't break `demoPathActive()`:
  ```ts
  export const FORCE_DEMO = import.meta.env.VITE_FORCE_DEMO === "true";
  const DEMO_PATH = "/demo";                       // used for URL detection only
  // demoPathActive() must keep testing DEMO_PATH (NOT the basename): if the
  // basename became "/", `p.startsWith("/")` would be true for every path.
  export const DEMO: boolean = FORCE_DEMO || demoPathActive() || demoQueryFlag();
  // Router basename: force build serves at root; otherwise under /demo.
  export const DEMO_BASENAME = FORCE_DEMO ? "/" : DEMO_PATH;
  ```
  (Declare `VITE_FORCE_DEMO` in the web `vite-env.d.ts` `ImportMetaEnv`.)
- **`web/src/main.tsx:41-49`** — skip the `/demo` redirect when `FORCE_DEMO` (the
  app is already at root; `demoPathActive()` would be false and must not trigger a
  redirect loop). Gate the redirect on `DEMO && !FORCE_DEMO && !demoPathActive()`.
- **`web/src/router.tsx:108`** — already uses `DEMO_BASENAME`; no change once the
  constant resolves to `/` under force mode. Verify `basename:"/"` is a no-op.
- **PWA:** disable the service worker / install prompt in the force-demo build
  (the public demo should not offer to "install DiffSentry Command Center" or
  precache a shell). Gate `VitePWA(...)` on `!VITE_FORCE_DEMO`, or add a
  `build:web:demo` script that builds with the flag and PWA off. Confirm no SW is
  emitted in the demo bundle.
- **Build script** — add `build:web:demo` (e.g. `VITE_FORCE_DEMO=true npm --prefix
  web run build`) producing `web/dist` suitable for static serving at root.

Alternative considered (rejected for URL aesthetics): serve today's `web/dist`
unchanged and `return 302 /demo/` at nginx root — zero product change, but public
URLs read `demo.diffsentry.app/demo/…`.

## Decision 3 — Demo deployment lives in the product repo

The demo *is* the product's web build, so its container home is `DiffSentry`
(rebuilding there keeps it in sync automatically):

- A **SPA-only image** (nginx:alpine) that serves the force-demo `web/dist` at
  root on a container port, with a static-site-appropriate CSP (self + Tailwind
  is not used here — this is the built React app, so `script-src 'self'` plus
  whatever the Vite bundle needs; fonts from Google as the app already uses).
  Mirror the security headers from the site's nginx.conf.
- A **`demo` service** wired into deployment (compose service or equivalent)
  exposing host port **3027** locally for the tunnel to reach (the real instance
  keeps `3005`; the site container keeps `8088`).
- No server, DB, private key, or `.diffsentry.yaml` mounted.

## Decision 4 — Marketing site content refresh (`DiffSentry-site`)

Keep the minimalist single-screen instinct; close the accuracy gap:

- Keep the hero; refresh the subhead.
- Add **one tasteful "what it does now" strip** — a small set of maturity signals:
  command-center dashboard, findings triage (accept/dismiss/snooze), AI cost
  tracking, multi-provider incl. local / OpenAI-compatible, static-analysis-aware
  reviews (lint/typecheck/SAST), repo health scorecards. Not a feature wall.
- **Fix stale claims** in the decorative `app.js` snippets: today they imply
  Anthropic-only (`ANTHROPIC_API_KEY`, `model: claude-opus-4`). Update to reflect
  multi-provider / BYOK and reconcile config keys against the real
  `.diffsentry.yaml`. (Ground truth: `DiffSentry-site/.diffsentry.yaml` and the
  product README.)
- Add a prominent **"Try the live demo → demo.diffsentry.app"** CTA in the hero.
- Respect CSP: no inline scripts / `on*=` handlers; behavior goes in `app.js`.
  Linking out to `demo.diffsentry.app` is a plain anchor — no CSP change needed
  (it is a navigation, not `connect-src`).
- **Bump `asset-version` v13 → v14** and every matching `?v=` string + the `VER`
  constant in `app.js` (enforced by the site's own `.diffsentry.yaml` check).
- Any new asset must be added to the Dockerfile per-file `COPY` list.

## What the operator does manually (Cloudflare / DNS)

1. Add a **public hostname** to the existing cloudflared tunnel:
   `demo.diffsentry.app` → `http://localhost:3027`. (Your `api.diffsentry.app →
   localhost:3005` personal instance is untouched — the demo is a separate
   container on its own port.)
   - Zero Trust dashboard → tunnel → Public Hostnames (auto-creates the DNS
     CNAME), **or** `config.yml` ingress + `cloudflared tunnel route dns <tunnel>
     demo.diffsentry.app`.
2. **No path routing, no new certs** — the tunnel + Cloudflare terminate TLS.
3. **Cleanup on the real instance:** set `DISABLE_DEMO=1` on the
   `api.diffsentry.app` deployment and restart, so `/demo` there returns 404.

## Rollout / cutover sequence

1. Land the product-repo demo-build changes + demo image/service.
2. Deploy the demo container; add the tunnel public hostname; verify
   `demo.diffsentry.app` loads the fixture dashboard at root, makes no network
   calls, and refuses writes.
3. Land the marketing-site refresh with the demo CTA; deploy; bump asset-version.
4. Set `DISABLE_DEMO=1` on `api.diffsentry.app`; confirm `/demo` 404s there.
5. Coordinate the two repos per AGENTS.md (product change that affects the site →
   matching `Sync site:` update).

## Risks / watch-items

- **Redirect loop** if `main.tsx` still redirects under force-demo — must gate on
  `!FORCE_DEMO`. Verify no reload loop at root.
- **Service worker** from a prior visit to `api.diffsentry.app/demo` could cache
  an old shell; disabling PWA in the demo build avoids emitting one going forward.
  (Different origin anyway, so cross-contamination is unlikely.)
- **CSP mismatch** in the demo nginx: the built React app's needs differ from the
  marketing page's; derive the demo CSP from what the Vite bundle actually loads.
- **asset-version drift** on the site: bump meta + all `?v=` + `VER` together or
  nginx serves stale immutable assets for 30 days.
- **Dockerfile COPY omissions** on the site: any new asset not in the COPY list
  404s in the container.

## Verification

- Demo: load `demo.diffsentry.app`, DevTools Network shows **no** `/api` calls;
  attempting a write action surfaces the client-side `403 demo_readonly`; deep
  links resolve at root; no SW registered.
- Real instance: `curl -sS https://api.diffsentry.app/demo` → 404.
- Site: renders with refreshed copy + working demo link; asset-version bumped;
  container serves all assets (no 404s); CSP unbroken (no console violations).
