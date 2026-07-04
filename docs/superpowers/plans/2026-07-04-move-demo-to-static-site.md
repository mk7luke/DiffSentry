# Move Demo to `demo.diffsentry.app` + Refresh Marketing Site — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Relocate the public demo off the operator's real instance (`api.diffsentry.app`) to a standalone container at `demo.diffsentry.app`, and refresh the marketing site (`diffsentry.app`) to match the current product and link to the relocated demo.

**Architecture:** The demo is the product's own Vite/React `web/dist` bundle running in fixture-backed "demo mode" (zero network calls). A build-time `VITE_FORCE_DEMO` flag hard-locks demo mode and serves it at the domain **root**; that build is served by a tiny standalone nginx container on host port **3027**, reached via a new cloudflared public hostname. The real instance turns the demo off (`DISABLE_DEMO=1`). The marketing site keeps its deliberate single-screen design but refreshes copy and adds a "Try the live demo" CTA.

**Tech Stack:** DiffSentry — Node/TypeScript, Vite 5 + React 18 + React Router 6 (`web/`), `vite-plugin-pwa`, Docker, nginx:alpine. DiffSentry-site — static HTML + vanilla `app.js` + Tailwind Play CDN, nginx:alpine in Docker. cloudflared tunnel for ingress.

## Global Constraints

- **Two repos, coordinate per AGENTS.md.** Product changes that affect the site get a matching `Sync site:` update. Run `git` only inside each child repo; both are on branch `move-demo`.
- **Ports (no collisions):** real instance `3005`, site container host `8088`, **demo container host `3027`**.
- **`web/` has NO test framework** (only `dev`/`build`/`typecheck`). Do not add one for this work. Verify web changes with `tsc --noEmit`, `vite build` output assertions, and a Playwright runtime smoke.
- **Demo mode must make ZERO network calls** (`/api/*`). This is the load-bearing safety property; the Playwright smoke asserts it.
- **Never point `demo.diffsentry.app` at `localhost:3005`.** It is a *separate* container on `3027`; `api.diffsentry.app → localhost:3005` stays untouched.
- **Site CSP forbids inline scripts / `on*=` handlers.** Behavior lives in `app.js`. Linking out to `demo.diffsentry.app` is a plain anchor (navigation, not `connect-src`) — no site CSP change needed.
- **Site asset cache is 30d `immutable`.** Any edit to `index.html` or `app.js` MUST bump `asset-version` meta AND every matching `?v=N` string AND the `VER` constant in `app.js`, together. Any *new* served file must be added to the site `Dockerfile` per-file `COPY` list.
- **Real provider surface** (authoritative, from `.env.example`): `AI_PROVIDER=anthropic|openai|openai-compatible`; keys `ANTHROPIC_API_KEY/_MODEL/_BASE_URL`, `OPENAI_API_KEY/_MODEL/_BASE_URL`, `LOCAL_AI_BASE_URL/_MODEL/_API_KEY`. The vars `DIFFSENTRY_SELF_HOSTED` and `TELEMETRY` are NOT real — do not reintroduce them.
- **Spec:** `DiffSentry/docs/superpowers/specs/2026-07-04-move-demo-to-static-site-design.md`.

---

# Part A — Product repo (`DiffSentry/`): relocate the demo

All Part A commands run from the `DiffSentry/` repo root.

## Task A1: Build-time force-demo flag (`mode.ts`, env typing, `vite.config`, PWA disable)

**Files:**
- Modify: `web/src/demo/mode.ts`
- Modify: `web/src/vite-env.d.ts`
- Modify: `web/vite.config.ts` (currently `export default defineConfig({ plugins: [react(), VitePWA({…})], … })`)

**Interfaces:**
- Produces: `export const FORCE_DEMO: boolean`, `export const DEMO: boolean`, `export const DEMO_BASENAME: string` from `web/src/demo/mode.ts`. `FORCE_DEMO` is true only in a `VITE_FORCE_DEMO=true` build. `DEMO_BASENAME` is `"/"` when `FORCE_DEMO`, else `"/demo"`. Detection of the `/demo` URL keys off the literal `"/demo"`, never off `DEMO_BASENAME`.

- [ ] **Step 1: Rewrite `web/src/demo/mode.ts`**

Replace the exported constants at the bottom of the file (keep the file's existing doc comment and the `demoPathActive()` / `demoQueryFlag()` functions, but make `demoPathActive()` test the literal `/demo`, not the basename):

```ts
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
```

- [ ] **Step 2: Augment `ImportMetaEnv` in `web/src/vite-env.d.ts`**

Append after the existing `/// <reference …>` lines:

```ts
interface ImportMetaEnv {
  readonly VITE_FORCE_DEMO?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
```

- [ ] **Step 3: Convert `web/vite.config.ts` to the function form; inject the flag and disable PWA when forced**

Read the current file first. Change `export default defineConfig({ … })` to a function that reads the env var, then (a) add a `define` that hard-injects `import.meta.env.VITE_FORCE_DEMO`, and (b) pass `disable: forceDemo` to the existing `VitePWA({ … })` call (keep all its current options; `disable` keeps the `virtual:pwa-register` module as a no-op so `usePWA.tsx`'s import still resolves, and emits no service worker):

```ts
export default defineConfig(() => {
  const forceDemo = process.env.VITE_FORCE_DEMO === "true";
  return {
    // …everything the config already returns (build, server, resolve, etc.)…
    define: {
      "import.meta.env.VITE_FORCE_DEMO": JSON.stringify(process.env.VITE_FORCE_DEMO ?? ""),
    },
    plugins: [
      react(),
      VitePWA({
        disable: forceDemo, // no service worker in the public demo build
        // …keep every existing VitePWA option below unchanged…
      }),
    ],
  };
});
```

**Contingency (if the forced build in Task A3 fails on `virtual:pwa-register`):** `VitePWA({ disable: true })` is expected to keep that virtual module as a no-op. If a given `vite-plugin-pwa` version instead drops the module (build error: cannot resolve `virtual:pwa-register`), do NOT remove the plugin. Instead keep it enabled but non-emitting — set `selfDestroying: true` (and leave `injectRegister: null`, already set) under `forceDemo` — or guard the import in `web/src/pwa/usePWA.tsx` behind a dynamic `import()` skipped when `FORCE_DEMO`. Re-run Task A3 step 3 to confirm no `sw.js` is emitted.

- [ ] **Step 4: Verify a normal build still typechecks and behaves**

Run: `npm --prefix web run typecheck`
Expected: exits 0, no errors (confirms the `ImportMetaEnv` augmentation and `mode.ts` types are valid).

- [ ] **Step 5: Verify a forced build typechecks**

Run: `VITE_FORCE_DEMO=true npm --prefix web run typecheck`
Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add web/src/demo/mode.ts web/src/vite-env.d.ts web/vite.config.ts
git commit -m "feat(web): add VITE_FORCE_DEMO build flag for standalone demo"
```

## Task A2: Guard the `/demo` redirect under force-demo (`main.tsx`)

Under a forced root build, `DEMO` is true but `demoPathActive()` is false (path is `/`), so the existing redirect at `main.tsx:41` would `window.location.replace("")` — an infinite reload loop. Gate it off.

**Files:**
- Modify: `web/src/main.tsx:6` (import) and `:41` (condition)

**Interfaces:**
- Consumes: `FORCE_DEMO` from `web/src/demo/mode.ts` (Task A1).

- [ ] **Step 1: Import `FORCE_DEMO`**

Change the import on `web/src/main.tsx:6` from:
```ts
import { DEMO, DEMO_BASENAME, demoPathActive } from "./demo/mode";
```
to:
```ts
import { DEMO, DEMO_BASENAME, FORCE_DEMO, demoPathActive } from "./demo/mode";
```

- [ ] **Step 2: Gate the redirect**

Change the condition on `web/src/main.tsx:41` from:
```ts
  if (DEMO && !demoPathActive()) {
```
to:
```ts
  // A forced root build (FORCE_DEMO) already serves at "/"; never redirect it
  // to /demo — that would loop. Only ?demo=true on a normal build bounces.
  if (DEMO && !FORCE_DEMO && !demoPathActive()) {
```

- [ ] **Step 3: Verify typecheck (both modes)**

Run: `npm --prefix web run typecheck && VITE_FORCE_DEMO=true npm --prefix web run typecheck`
Expected: both exit 0.

- [ ] **Step 4: Commit**

```bash
git add web/src/main.tsx
git commit -m "fix(web): don't redirect the forced root demo build to /demo"
```

## Task A3: Add the demo build script

**Files:**
- Modify: `package.json` (root `scripts`)

- [ ] **Step 1: Add the script**

In root `package.json` `scripts`, add after `build:web`:
```json
"build:web:demo": "VITE_FORCE_DEMO=true npm --prefix web run build",
```

- [ ] **Step 2: Run it (may take ~30–90s → run in background if preferred)**

Run: `npm run build:web:demo`
Expected: completes; `web/dist/index.html` exists.

- [ ] **Step 3: Verify NO service worker was emitted**

Run: `ls web/dist/sw.js web/dist/registerSW.js 2>/dev/null; echo "exit=$?"`
Expected: no such files (a non-zero `ls` / empty output). Confirms `VitePWA({ disable: true })` worked.

- [ ] **Step 4: Verify the flag is baked into the bundle**

Run: `grep -rl "VITE_FORCE_DEMO" web/dist/assets 2>/dev/null; grep -roh "true" web/dist/index.html >/dev/null; echo "built"`
Expected: prints `built`. (The env expression is replaced at build; the presence check is a sanity gate — the real behavioral check is Task A6.)

- [ ] **Step 5: Commit**

```bash
git add package.json
git commit -m "build: add build:web:demo (forced standalone demo bundle)"
```

## Task A4: Standalone demo container (`Dockerfile.demo` + demo nginx conf)

**Files:**
- Create: `Dockerfile.demo`
- Create: `deploy/demo-nginx.conf`

- [ ] **Step 1: Create `deploy/demo-nginx.conf`**

```nginx
server {
  listen 80;
  listen [::]:80;
  server_name demo.diffsentry.app localhost;
  root /usr/share/nginx/html;
  index index.html;

  add_header X-Frame-Options SAMEORIGIN always;
  add_header X-Content-Type-Options nosniff always;
  add_header Referrer-Policy strict-origin-when-cross-origin always;
  # Built React app: self scripts only, Google Fonts, no external API (demo makes
  # zero network calls). 'unsafe-inline' style is needed for injected component
  # styles (CodeMirror, etc.). No 'unsafe-eval'.
  add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; base-uri 'self'; frame-ancestors 'none'" always;

  gzip on;
  gzip_types text/css application/javascript application/json image/svg+xml;

  # Hashed Vite assets are content-addressed and safe to cache hard.
  location /assets/ {
    expires 30d;
    add_header Cache-Control "public, immutable";
  }

  # SPA client routing: unknown paths serve the app shell.
  location / {
    try_files $uri $uri/ /index.html;
  }

  location = /health {
    add_header Content-Type text/plain;
    return 200 'ok';
  }
}
```

- [ ] **Step 2: Create `Dockerfile.demo`**

```dockerfile
# Standalone public demo (demo.diffsentry.app). Builds the SPA with demo mode
# hard-forced (VITE_FORCE_DEMO=true, served at root, no service worker), then
# serves the static bundle with nginx. No server, DB, keys, or .diffsentry.yaml.
FROM node:22-alpine AS build
WORKDIR /app
COPY web/package.json web/package-lock.json ./web/
RUN npm --prefix web ci
COPY web/ ./web/
ENV VITE_FORCE_DEMO=true
RUN npm --prefix web run build

FROM nginx:alpine
COPY deploy/demo-nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/web/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:80/health || exit 1
```

- [ ] **Step 3: Build the image (slow → run in background)**

Run: `docker build -f Dockerfile.demo -t diffsentry-demo .`
Expected: builds successfully; final `nginx:alpine` stage tagged `diffsentry-demo`.

- [ ] **Step 4: Run and smoke the container**

```bash
docker run -d --name diffsentry-demo-test -p 3027:80 diffsentry-demo
sleep 2
curl -sS -o /dev/null -w "%{http_code}\n" http://localhost:3027/          # expect 200
curl -sS http://localhost:3027/ | grep -o '<div id="root">' | head -1     # expect the SPA root div
curl -sS -o /dev/null -w "%{http_code}\n" http://localhost:3027/health     # expect 200
```
Expected: `200`, `<div id="root">`, `200`.

- [ ] **Step 5: Tear down the test container**

Run: `docker rm -f diffsentry-demo-test`
Expected: removed.

- [ ] **Step 6: Commit**

```bash
git add Dockerfile.demo deploy/demo-nginx.conf
git commit -m "feat: standalone demo container (Dockerfile.demo + nginx)"
```

## Task A5: Wire the demo service into `docker-compose.yml`

**Files:**
- Modify: `docker-compose.yml` (add a `demo` service alongside the existing `diffsentry` service)

- [ ] **Step 1: Add the service**

Add under `services:` (do not touch the existing `diffsentry` service):
```yaml
  demo:
    build:
      context: .
      dockerfile: Dockerfile.demo
    ports:
      - "3027:80"
    restart: unless-stopped
    container_name: diffsentry-demo
```

- [ ] **Step 2: Build + start only the demo service**

```bash
docker compose build demo
docker compose up -d demo
sleep 2
curl -sS -o /dev/null -w "%{http_code}\n" http://localhost:3027/   # expect 200
```
Expected: `200`.

- [ ] **Step 3: Commit**

```bash
git add docker-compose.yml
git commit -m "feat: add demo service (host port 3027) to compose"
```

## Task A6: Runtime smoke — assert ZERO `/api` calls (Playwright)

This is the meaningful behavioral test: the demo must render from fixtures and make no network calls. Requires the demo container running on `3027` (Task A5).

- [ ] **Step 1: Load the demo and capture network requests**

Using the Playwright MCP tools:
1. `browser_navigate` → `http://localhost:3027/`
2. `browser_snapshot` → confirm the dashboard shell renders (Overview) and the demo banner ("You're in demo mode") is present.
3. `browser_network_requests` → capture all requests.

- [ ] **Step 2: Assert no backend calls and no CSP violations**

- Assert: **no** request URL contains `/api/` (reads short-circuit to fixtures; no SSE/`/api/v1/events` either).
- `browser_console_messages` → assert **no** `Content-Security-Policy` violation errors and no uncaught errors.
- Navigate a deep link `http://localhost:3027/repos/acme/checkout-api/pr/142` → confirm it resolves at root (no bounce to `/demo`, no reload loop) and renders the fixture PR.

Expected: zero `/api/*` requests; no CSP errors; deep link renders.

**Contingency (only if a `/api/*` request appears):** it will be the SSE `EventStreamProvider` opening a stream. Fix by guarding it under `DEMO` in `web/src/realtime/useEventStream.tsx` (skip opening the `EventSource` when `DEMO` is true), rebuild (`npm run build:web:demo` / `docker compose build demo`), and re-run this task. Commit that fix separately: `fix(web): don't open the realtime SSE stream in demo mode`.

- [ ] **Step 3: Record the result** in the plan checkbox (no code commit unless the contingency fix was needed).

---

# Part B — Site repo (`DiffSentry-site/`): content refresh + demo link

All Part B commands run from the `DiffSentry-site/` repo root. Preserve the deliberate single-screen design — enrich the hero column, do not add a scrolling section.

## Task B1: Hero refresh — subhead, capability chips, demo CTA (`index.html`)

**Files:**
- Modify: `DiffSentry-site/index.html` (hero prose `:250-252`, CTA row `:254-265`)

- [ ] **Step 1: Refresh the hero prose** (`index.html:250-252`)

Replace:
```html
      <p class="text-lg md:text-xl text-surface-300 leading-relaxed mb-8 max-w-xl" data-animate>
        A GitHub PR review bot that runs on your own infrastructure. It leaves inline comments, writes walkthroughs, suggests fixes, and answers follow-up questions right in the thread. Your data, your keys, your rules.
      </p>
```
with:
```html
      <p class="text-lg md:text-xl text-surface-300 leading-relaxed mb-6 max-w-xl" data-animate>
        A GitHub PR review bot that runs on your own infrastructure — inline comments, walkthroughs, suggested fixes, and in-thread chat, plus a full command center to triage findings, track AI spend, and watch review health. Any model: Claude, GPT, or a local one. Your data, your keys, your rules.
      </p>

      <!-- Capability chips: signal the product's breadth without breaking the
           single-screen design. Kept compact; the live demo does the showing. -->
      <div class="flex flex-wrap items-center justify-center gap-2 mb-8 max-w-xl" data-animate>
        <span class="px-3 py-1 rounded-full text-xs font-medium bg-surface-800/70 border border-surface-700 text-surface-300">Command-center dashboard</span>
        <span class="px-3 py-1 rounded-full text-xs font-medium bg-surface-800/70 border border-surface-700 text-surface-300">Findings triage</span>
        <span class="px-3 py-1 rounded-full text-xs font-medium bg-surface-800/70 border border-surface-700 text-surface-300">AI cost tracking</span>
        <span class="px-3 py-1 rounded-full text-xs font-medium bg-surface-800/70 border border-surface-700 text-surface-300">Any model — local too</span>
        <span class="px-3 py-1 rounded-full text-xs font-medium bg-surface-800/70 border border-surface-700 text-surface-300">Static-analysis aware</span>
      </div>
```

- [ ] **Step 2: Make the demo the primary CTA** (`index.html:254-265`)

Replace the CTA `<div>` (View on GitHub primary + Read the docs) with a "Try the live demo" primary, "View on GitHub" secondary (nav-style outline), and keep "Read the docs":
```html
      <div class="flex flex-wrap items-center justify-center gap-4" data-animate>
        <a href="https://demo.diffsentry.app" target="_blank" rel="noopener"
           class="inline-flex items-center gap-2 px-7 py-3.5 rounded-xl bg-brand-600 hover:bg-brand-500 text-white font-semibold text-base transition-all hover:shadow-lg hover:shadow-brand-600/25 hover:-translate-y-0.5">
          Try the live demo
          <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3"/></svg>
        </a>
        <a href="https://github.com/mk7luke/DiffSentry" target="_blank" rel="noopener"
           class="inline-flex items-center gap-2 px-5 py-3 rounded-xl bg-surface-800 hover:bg-surface-700 border border-surface-700 hover:border-surface-600 text-white font-medium text-sm transition-all">
          <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/></svg>
          View on GitHub
        </a>
        <a href="https://github.com/mk7luke/DiffSentry#readme" target="_blank" rel="noopener"
           class="inline-flex items-center gap-2 text-surface-300 hover:text-white transition-colors text-sm font-medium">
          Read the docs
          <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3"/></svg>
        </a>
      </div>
```

- [ ] **Step 3: Also add a "Live demo" link in the nav** (`index.html:203`, before the GitHub button)

Insert immediately before the existing `<a href="https://github.com/mk7luke/DiffSentry" …>GitHub</a>` in the nav, wrapping both in a flex gap if needed:
```html
        <a href="https://demo.diffsentry.app" target="_blank" rel="noopener"
           class="hidden sm:inline-flex items-center px-4 py-2 rounded-lg text-sm font-medium text-surface-300 hover:text-white transition-colors">
          Live demo
        </a>
```
(Confirm the nav's right-hand cluster is a flex row; if it currently holds only the GitHub button directly, wrap the two anchors in `<div class="flex items-center gap-1">…</div>`.)

- [ ] **Step 4: Verify structure is intact**

Run: `grep -c "demo.diffsentry.app" index.html`
Expected: `>= 2` (nav link + hero CTA).

(asset-version bump for this file happens in Task B3.)

## Task B2: Provider-accurate decorative snippets + console copy (`app.js`)

The background diff snippets currently imply Anthropic-only and use non-existent env vars. Make them provider-accurate using the real surface (see Global Constraints).

**Files:**
- Modify: `DiffSentry-site/app.js` — the `.diffsentry.yaml` snippet (`:155-162`), the env snippet (`:194-199`), and the `tldr()` console string (`~:483`)

- [ ] **Step 1: Fix the `.diffsentry.yaml` snippet** (`app.js:155-162`)

Replace the block:
```js
    [
      [' ', '# .diffsentry.yaml'],
      [' ', 'model: claude-opus-4'],
      ['+', 'review:'],
      ['+', '  inline_comments: true'],
      ['+', '  walkthrough: true'],
      ['-', '  auto_approve: false'],
      [' ', '  max_files: 50'],
    ],
```
with (real keys from the product's `.diffsentry.yaml` surface — `reviews.profile`, `walkthrough.*`, `chat.auto_reply`):
```js
    [
      [' ', '# .diffsentry.yaml'],
      [' ', 'reviews:'],
      ['+', '  profile: assertive'],
      ['+', '  request_changes_workflow: true'],
      [' ', '  walkthrough:'],
      ['+', '    enabled: true'],
      ['-', '    sequence_diagrams: false'],
      ['+', '    sequence_diagrams: true'],
    ],
```

- [ ] **Step 2: Fix the env snippet** (`app.js:194-199`) — provider-agnostic, real vars only

Replace:
```js
    [
      [' ', '# Your keys, your infra'],
      [' ', 'export ANTHROPIC_API_KEY=sk-...'],
      ['+', 'export DIFFSENTRY_SELF_HOSTED=1'],
      [' ', 'export GITHUB_APP_ID=...'],
      ['-', 'export TELEMETRY=on'],
      ['+', 'export TELEMETRY=off'],
    ],
```
with:
```js
    [
      [' ', '# Your keys, your infra — any provider'],
      [' ', 'export AI_PROVIDER=anthropic   # or openai, or openai-compatible'],
      ['+', 'export ANTHROPIC_API_KEY=sk-ant-...'],
      ['-', '# export OPENAI_API_KEY=sk-...'],
      ['+', '# export LOCAL_AI_BASE_URL=http://localhost:11434/v1  # Ollama'],
      [' ', 'export GITHUB_APP_ID=...'],
    ],
```

- [ ] **Step 3: Refresh the `tldr()` console string** (`app.js`, the `tldr()` line ~483)

Read the current `tldr()` string, then replace it with:
```js
    "Self-hosted GitHub PR review bot. Inline comments, walkthroughs, suggested fixes, in-thread chat + a command center (triage, cost, health). Any model — Claude, GPT, or local. Your infra, your keys. MIT.",
```

- [ ] **Step 4: Verify no non-existent vars remain**

Run: `grep -nE "DIFFSENTRY_SELF_HOSTED|TELEMETRY|claude-opus-4|auto_approve" app.js; echo "exit=$?"`
Expected: no matches (grep exits 1 / prints nothing).

(VER bump happens in Task B3.)

## Task B3: Bump `asset-version` v13 → v14 and rebuild the site

Required because Task B1/B2 edited `index.html` and `app.js`, which nginx serves `immutable` for 30 days.

**Files:**
- Modify: `DiffSentry-site/index.html` (meta `:18` + every `?v=13`), `DiffSentry-site/app.js` (`VER` constant `~:401`)

- [ ] **Step 1: Bump all version strings together**

```bash
# index.html: the asset-version meta + every ?v=13 query string
sed -i '' 's/content="v13"/content="v14"/; s/?v=13/?v=14/g' index.html
# app.js: the VER constant
sed -i '' "s/VER = 'v13'/VER = 'v14'/" app.js
```

- [ ] **Step 2: Verify consistency (no stale v13 remains)**

Run: `grep -n "v13" index.html app.js; echo "exit=$?"`
Expected: no matches (grep prints nothing / exits 1).

Run: `grep -c "v14" index.html`
Expected: `>= 6` (meta + favicon + svg + apple-touch + og + app.js query).

- [ ] **Step 3: Build + serve the site container and smoke assets**

```bash
docker compose build
docker compose up -d
sleep 2
curl -sS -o /dev/null -w "%{http_code}\n" http://localhost:8088/            # expect 200
curl -sS -o /dev/null -w "%{http_code}\n" http://localhost:8088/app.js?v=14 # expect 200
curl -sS http://localhost:8088/ | grep -c "demo.diffsentry.app"             # expect >= 2
```
Expected: `200`, `200`, `>= 2`.

- [ ] **Step 4: Playwright CSP + link smoke**

`browser_navigate` → `http://localhost:8088/`; `browser_console_messages` → assert no CSP violations; confirm the "Try the live demo" button and nav "Live demo" link point to `https://demo.diffsentry.app`.

- [ ] **Step 5: Commit (site repo)**

```bash
git add index.html app.js
git commit -m "Sync site: relocate demo CTA to demo.diffsentry.app + refresh copy for current product (v14)"
```

---

# Part C — Manual cutover (operator: luke)

These are **operator actions**, not code. Do them in order after Parts A & B are deployed.

- [ ] **C1: Deploy the demo container** on the box that runs the tunnel: `docker compose up -d demo` (from `DiffSentry/`). Verify locally: `curl -I http://localhost:3027/` → `200`.

- [ ] **C2: Add the cloudflared public hostname.** In the tunnel config, add `demo.diffsentry.app` → `http://localhost:3027`.
  - Zero Trust dashboard → your tunnel → *Public Hostnames* → Add (auto-creates the DNS CNAME), **or** add an ingress rule in `config.yml` and run `cloudflared tunnel route dns <tunnel> demo.diffsentry.app`, then restart `cloudflared`.
  - No path routing, no new certs (the tunnel + Cloudflare terminate TLS). `api.diffsentry.app → localhost:3005` is unchanged.
  - Verify: `curl -I https://demo.diffsentry.app/` → `200`; the demo loads the fixture dashboard.

- [ ] **C3: Turn the demo off on the real instance.** Set `DISABLE_DEMO=1` in the `api.diffsentry.app` deployment env and restart it.
  - Verify: `curl -s -o /dev/null -w "%{http_code}\n" https://api.diffsentry.app/demo` → `404`. Confirm your authenticated dashboard at `api.diffsentry.app` still works.

- [ ] **C4: Deploy the refreshed site.** `docker compose up -d` from `DiffSentry-site/`. Verify `https://diffsentry.app` shows the new copy and the demo CTA reaches `https://demo.diffsentry.app`.

---

## Self-review notes (author)

- **Spec coverage:** host = subdomain (Part C2); force-demo root build (A1–A3); demo container on 3027 (A4–A5); PWA off (A1 step 3 + A3 step 3); redirect-loop guard (A2); real-instance `DISABLE_DEMO=1` (C3); site content refresh + demo CTA + multi-provider accuracy (B1–B2); asset-version bump (B3); no-network-call verification (A6). All spec sections mapped.
- **No test framework in `web/`** — Part A uses typecheck + build-output + Playwright runtime assertions by design (Global Constraints), which is the honest fit for a framework-less workspace and tests the property that actually matters (zero `/api` calls).
- **Type/name consistency:** `FORCE_DEMO`, `DEMO`, `DEMO_BASENAME`, `DEMO_PATH`, `demoPathActive` used identically across A1/A2. `demoPathActive()` keys off `DEMO_PATH` (never the basename) — the footgun the spec called out.
