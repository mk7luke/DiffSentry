import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestContext {
  user: { login: string } | null;
  pathname: string;
}

const als = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return als.run(ctx, fn);
}

export function getRequestContext(): RequestContext {
  return als.getStore() ?? { user: null, pathname: "" };
}

/** Tiny HTML escape for untrusted string interpolation. */
export function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface Crumb {
  label: string;
  href?: string;
}

export interface CurrentUser {
  login: string;
}

// Small, brand-tinted logomark — used in the nav only.
const LOGO_SVG = `<svg class="w-5 h-5" viewBox="0 0 536.47 603.92" aria-hidden="true">
  <path fill="currentColor" d="M268.5,603.92l-20.91-9.38c-52.32-23.47-92.73-49.8-135.59-87.15l-4.73-4.12c-11.43-9.96-21.23-20.67-30.91-32.29-27.54-33.04-48.51-70.17-60.28-111.6-6.77-23.85-10.93-47.15-13.25-71.67l-2.51-26.52-.24-13.23-.07-157.57c38.42-5.4,74.93-13.75,111.72-23.56l32.28-10.16c43.05-14.96,84.19-33.91,124.25-56.66,27.33,15.02,54.88,28.48,83.72,40.65,47.68,20.13,96.79,33.9,147.61,43.15l36.88,6.54-.1,85.75-.77,85.38c-.26,28.47-3.73,56.26-11.57,83.52l-5.79,20.14c-12.87,44.76-39.64,86.03-71.1,119.91-31.24,33.64-69.83,61.49-109.55,84.35-22.43,12.91-45,23.23-69.08,34.52ZM147.17,488.52c2.4,2.21,4.48,4.05,6.83,5.74l35.64,25.66c8.86,6.38,28.81,18.38,38.59,23.13l39.87,19.35c17.05-8.29,33.15-15.63,49.46-25.02,85.9-49.43,157.12-118.34,173.56-220.35,5.1-31.44,7.33-61.97,7.32-93.96l-.02-100.75c-83.18-14.52-156.14-39.09-230.34-78.19l-18.94,9.74c-68.9,33.69-134.48,55.7-211.11,68.48v100.67c0,15.97.48,30.85,1.59,46.54l2.29,23.71c2.42,25.08,11.06,61.19,20.89,84.67,4.83,11.54,10.78,22.67,17.11,33.59,6.35,10.94,29.09,41.03,37.68,49.18l19.54,18.55,10.04,9.26Z"/>
</svg>`;

const TAILWIND_CONFIG = `window.tailwind = window.tailwind || {};
window.tailwind.config = {
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'monospace'],
      },
      colors: {
        brand: {
          50: '#eef7ff', 100: '#d9edff', 200: '#bce0ff', 300: '#8ecdff',
          400: '#59b0ff', 500: '#338dff', 600: '#1a6df5', 700: '#1457e1',
          800: '#1746b6', 900: '#193d8f', 950: '#142757',
        },
        surface: {
          50:  '#fafafb', 100: '#f2f2f4', 200: '#e4e4e8', 300: '#c9c9d0',
          400: '#a0a0ad', 500: '#6e6e7a', 600: '#4a4a55', 700: '#2f2f38',
          800: '#22222a', 850: '#1c1c23', 900: '#16161c', 950: '#0d0d12',
        },
      },
    },
  },
};`;

// Ops-oriented, high-contrast, low-decoration. No mesh / cursor glow.
const BASE_STYLES = `
  html, body { height: 100%; }
  html { background: #0d0d12; }
  body { font-family: 'Inter', system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
  ::-webkit-scrollbar { width: 10px; height: 10px; }
  ::-webkit-scrollbar-track { background: #0d0d12; }
  ::-webkit-scrollbar-thumb { background: #2f2f38; border-radius: 5px; border: 2px solid #0d0d12; }
  ::-webkit-scrollbar-thumb:hover { background: #4a4a55; }

  /* Subtle brand stripe at the top so the nav doesn't look detached */
  .top-stripe {
    position: fixed; top: 0; left: 0; right: 0; height: 1px;
    background: linear-gradient(90deg, transparent 0%, rgba(51,141,255,0.5) 30%, rgba(51,141,255,0.5) 70%, transparent 100%);
    z-index: 100;
  }

  /* Focus ring */
  a:focus-visible, button:focus-visible, [role="button"]:focus-visible,
  input:focus-visible, select:focus-visible {
    outline: 2px solid #59b0ff; outline-offset: 2px; border-radius: 6px;
  }

  /* Inputs on dark */
  input[type="text"], input:not([type]), select {
    background-color: #16161c;
    border: 1px solid #2f2f38;
    color: #e4e4e8;
    padding: 0.375rem 0.625rem;
    border-radius: 0.375rem;
    font-size: 0.8125rem;
  }
  input::placeholder { color: #6e6e7a; }
  input:focus, select:focus { border-color: #338dff; outline: none; box-shadow: 0 0 0 2px rgba(51,141,255,0.2); }

  /* Tables: dense, high contrast */
  table.dash-table { width: 100%; border-collapse: collapse; font-size: 0.8125rem; }
  table.dash-table thead th {
    text-align: left; padding: 0.5rem 0.875rem;
    font-size: 0.6875rem; font-weight: 600; letter-spacing: 0.05em;
    text-transform: uppercase; color: #a0a0ad;
    background: #16161c; border-bottom: 1px solid #2f2f38;
    position: sticky; top: 0;
  }
  table.dash-table thead th.num, table.dash-table thead th.right { text-align: right; }
  table.dash-table tbody td {
    padding: 0.5625rem 0.875rem; color: #e4e4e8;
    border-bottom: 1px solid rgba(47, 47, 56, 0.6);
    vertical-align: top;
  }
  table.dash-table tbody td.num, table.dash-table tbody td.right { text-align: right; font-variant-numeric: tabular-nums; }
  table.dash-table tbody td.muted, table.dash-table tbody td .muted { color: #a0a0ad; }
  table.dash-table tbody td.zero { color: #4a4a55; }
  table.dash-table tbody tr { transition: background-color 0.12s ease; }
  table.dash-table tbody tr:hover { background-color: rgba(51, 141, 255, 0.06); }
  table.dash-table tbody tr:last-child td { border-bottom: 0; }
  table.dash-table a.link { color: #8ecdff; }
  table.dash-table a.link:hover { color: #bce0ff; text-decoration: underline; }

  /* Panel card — used for every section */
  .panel {
    background: #16161c;
    border: 1px solid #2f2f38;
    border-radius: 0.625rem;
    overflow: hidden;
  }
  .panel-head {
    display: flex; align-items: center; justify-content: space-between;
    padding: 0.625rem 0.875rem;
    border-bottom: 1px solid #2f2f38;
    background: #1c1c23;
  }
  .panel-head h2 {
    font-size: 0.8125rem; font-weight: 600; color: #f2f2f4;
    margin: 0; letter-spacing: -0.005em;
  }
  .panel-head .panel-sub { font-size: 0.75rem; color: #a0a0ad; }
  .panel-body { padding: 0.875rem; }
  .panel-body-flush { padding: 0; }

  /* Key/value grid inside panels */
  .kv { display: grid; grid-template-columns: repeat(auto-fill, minmax(8rem, 1fr)); gap: 0.75rem; font-size: 0.8125rem; }
  .kv dt { font-size: 0.6875rem; color: #a0a0ad; text-transform: uppercase; letter-spacing: 0.06em; font-weight: 600; margin-bottom: 0.125rem; }
  .kv dd { color: #f2f2f4; margin: 0; font-variant-numeric: tabular-nums; }
  .kv dd.mono { font-family: 'JetBrains Mono', monospace; font-size: 0.75rem; color: #c9c9d0; }

  /* Numeric contrast helpers */
  .num-crit { color: #fca5a5; font-weight: 600; }
  .num-strong { color: #f2f2f4; font-weight: 600; }

  /* Nav active link indicator */
  .nav-link { padding: 0.375rem 0; border-bottom: 2px solid transparent; color: #c9c9d0; font-size: 0.8125rem; transition: color 0.12s ease, border-color 0.12s ease; }
  .nav-link:hover { color: #ffffff; }
  .nav-link.active { color: #ffffff; border-bottom-color: #338dff; }

  /* Button primary / secondary */
  .btn { display: inline-flex; align-items: center; gap: 0.375rem; padding: 0.375rem 0.75rem; border-radius: 0.375rem; font-size: 0.75rem; font-weight: 500; transition: all 0.12s ease; }
  .btn-primary { background: #338dff; color: #ffffff; }
  .btn-primary:hover { background: #59b0ff; box-shadow: 0 6px 20px -6px rgba(51,141,255,0.5); }
  .btn-ghost { background: #22222a; color: #e4e4e8; border: 1px solid #2f2f38; }
  .btn-ghost:hover { background: #2f2f38; border-color: #4a4a55; }

  /* Chip */
  .chip { display: inline-flex; align-items: center; padding: 0.125rem 0.5rem; border-radius: 0.3125rem; font-size: 0.6875rem; font-weight: 500; }
`;

const PATHNAME_SCRIPT = `
  (function(){ var els = document.querySelectorAll('[data-nav-link]');
    var cur = window.location.pathname;
    els.forEach(function(a){
      var href = a.getAttribute('href');
      if (href === '/dashboard' ? cur === '/dashboard' : cur.indexOf(href) === 0) a.classList.add('active');
    });
  })();
`;

export function renderLayout(opts: { title: string; crumbs?: Crumb[]; body: string; user?: CurrentUser | null }): string {
  const crumbs = opts.crumbs ?? [];
  const user = opts.user ?? getRequestContext().user;
  const crumbHtml = crumbs.length
    ? `<nav class="text-xs text-surface-400 mb-4 font-mono">${crumbs
        .map((c, i) => {
          const part = c.href
            ? `<a href="${esc(c.href)}" class="hover:text-brand-300 transition-colors">${esc(c.label)}</a>`
            : `<span class="text-surface-200">${esc(c.label)}</span>`;
          return i === 0 ? part : ` <span class="mx-1.5 text-surface-600">/</span> ${part}`;
        })
        .join("")}</nav>`
    : "";
  const navLink = (href: string, label: string) =>
    `<a href="${esc(href)}" data-nav-link class="nav-link">${esc(label)}</a>`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(opts.title)} — DiffSentry</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <script>${TAILWIND_CONFIG}</script>
  <script src="https://cdn.tailwindcss.com/3.4.17"></script>
  <style>${BASE_STYLES}</style>
</head>
<body class="bg-surface-950 text-surface-100 min-h-screen">
  <div class="top-stripe" aria-hidden="true"></div>

  <nav class="border-b border-surface-800 bg-surface-900/80 backdrop-blur sticky top-0 z-50">
    <div class="max-w-[1400px] mx-auto px-6 h-12 flex items-center justify-between">
      <a href="/dashboard" class="flex items-center gap-2 text-brand-400 hover:text-brand-300 transition-colors">
        ${LOGO_SVG}
        <span class="font-semibold text-sm text-white tracking-tight">DiffSentry</span>
      </a>
      <div class="flex items-center gap-6">
        ${navLink("/dashboard", "Repos")}
        ${navLink("/dashboard/findings", "Findings")}
        ${navLink("/dashboard/patterns", "Patterns")}
        ${navLink("/dashboard/settings", "Settings")}
      </div>
      <div class="flex items-center gap-3 text-xs">
        ${
          user
            ? `<span class="text-surface-300 font-mono">@${esc(user.login)}</span>
               <a href="/dashboard/auth/logout" class="text-surface-500 hover:text-surface-200 transition-colors">Sign out</a>`
            : ""
        }
      </div>
    </div>
  </nav>

  <main class="max-w-[1400px] mx-auto px-6 py-6">
    ${crumbHtml}
    ${opts.body}
  </main>

  <script>${PATHNAME_SCRIPT}</script>
</body>
</html>`;
}

/** Format an ISO timestamp as "3h ago" / "2d ago" / short absolute for older. */
export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return "";
  const diff = Date.now() - ts;
  const min = Math.round(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(ts).toISOString().slice(0, 10);
}

const SEVERITY_CLASSES: Record<string, string> = {
  critical: "bg-red-500/20 text-red-200 ring-red-500/40",
  major: "bg-orange-500/20 text-orange-200 ring-orange-500/40",
  minor: "bg-amber-500/20 text-amber-200 ring-amber-500/40",
  nit: "bg-surface-700/60 text-surface-200 ring-surface-600/60",
};
export function severityBadge(sev: string | null | undefined): string {
  const k = (sev ?? "").toLowerCase();
  const cls = SEVERITY_CLASSES[k] ?? "bg-surface-700/60 text-surface-200 ring-surface-600/60";
  return `<span class="inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-semibold ring-1 ring-inset ${cls}">${esc(sev ?? "—")}</span>`;
}

const RISK_CLASSES: Record<string, string> = {
  low: "bg-emerald-500/20 text-emerald-200 ring-emerald-500/40",
  moderate: "bg-amber-500/20 text-amber-200 ring-amber-500/40",
  elevated: "bg-orange-500/20 text-orange-200 ring-orange-500/40",
  high: "bg-red-500/20 text-red-200 ring-red-500/40",
  critical: "bg-red-500/30 text-red-100 ring-red-500/50",
};
export function riskBadge(level: string | null | undefined, score?: number | null): string {
  const k = (level ?? "").toLowerCase();
  const cls = RISK_CLASSES[k] ?? "bg-surface-700/60 text-surface-200 ring-surface-600/60";
  const s = typeof score === "number" ? ` · ${score}` : "";
  return `<span class="inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-semibold ring-1 ring-inset ${cls}">${esc(level ?? "—")}${s}</span>`;
}

/** Compact page header — title + optional subtitle + optional right-slot (actions). */
export function pageHeader(opts: { title: string; subtitle?: string; right?: string }): string {
  return `<header class="mb-5 flex items-end justify-between gap-6">
    <div class="min-w-0">
      <h1 class="text-lg font-semibold text-white tracking-tight">${esc(opts.title)}</h1>
      ${opts.subtitle ? `<p class="text-[13px] text-surface-400 mt-1">${opts.subtitle}</p>` : ""}
    </div>
    ${opts.right ? `<div class="shrink-0">${opts.right}</div>` : ""}
  </header>`;
}
