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
// IMPORTANT: These styles do not rely on Tailwind — the CDN can be blocked
// by CSP, cached stale, or slow to JIT custom colors, and that must not
// make the dashboard unreadable. Every text / bg / border color the
// dashboard uses is shimmed here so a page is legible without Tailwind.
const BASE_STYLES = `
  html, body { height: 100%; }
  html { background: #0d0d12; color-scheme: dark; }
  body {
    font-family: 'Inter', system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
    background: #0d0d12;
    color: #e4e4e8;
  }
  h1, h2, h3, h4, h5 { color: #f2f2f4; }

  /* ── Fallback shims for Tailwind utilities the dashboard depends on ──
     Written without @apply so they work with or without the CDN. */
  .text-white, [class~="text-white"] { color: #f2f2f4 !important; }
  .text-surface-100 { color: #f2f2f4; }
  .text-surface-200 { color: #e4e4e8; }
  .text-surface-300 { color: #c9c9d0; }
  .text-surface-400 { color: #a0a0ad; }
  .text-surface-500 { color: #6e6e7a; }
  .text-surface-600 { color: #4a4a55; }
  .text-brand-100 { color: #d9edff; }
  .text-brand-200 { color: #bce0ff; }
  .text-brand-300 { color: #8ecdff; }
  .text-brand-400 { color: #59b0ff; }
  .text-brand-500 { color: #338dff; }
  .bg-surface-950 { background-color: #0d0d12; }
  .bg-surface-900 { background-color: #16161c; }
  .bg-surface-800 { background-color: #22222a; }
  .bg-surface-700 { background-color: #2f2f38; }
  .bg-brand-600 { background-color: #1a6df5; }
  .bg-brand-950 { background-color: #142757; }
  .border-surface-800 { border-color: #22222a; }
  .border-surface-700 { border-color: #2f2f38; }
  .border-brand-800 { border-color: #1746b6; }
  .hover\\:text-white:hover { color: #f2f2f4; }
  .hover\\:text-surface-200:hover { color: #e4e4e8; }
  .hover\\:text-brand-100:hover { color: #d9edff; }
  .hover\\:text-brand-300:hover { color: #8ecdff; }
  .hover\\:bg-surface-700:hover { background-color: #2f2f38; }
  .hover\\:bg-brand-500:hover { background-color: #338dff; }
  .text-red-100 { color: #fecaca; }
  .text-red-200 { color: #fca5a5; }
  .text-red-300 { color: #fca5a5; }
  .text-amber-200 { color: #fde68a; }
  .text-amber-300 { color: #fcd34d; }
  .text-emerald-200 { color: #a7f3d0; }
  .text-emerald-300 { color: #86efac; }
  .text-orange-200 { color: #fed7aa; }
  .text-orange-300 { color: #fdba74; }

  /* GitHub-like rendered markdown container — scoped so it never leaks
     into the chrome. Used for review summaries and finding bodies. */
  .md-body { color: #e4e4e8; font-size: 0.875rem; line-height: 1.55; word-wrap: break-word; }
  .md-body > :first-child { margin-top: 0; }
  .md-body > :last-child { margin-bottom: 0; }
  .md-body h1, .md-body h2, .md-body h3, .md-body h4, .md-body h5, .md-body h6 {
    color: #f2f2f4; font-weight: 600; line-height: 1.25;
    margin: 1.25em 0 0.6em; letter-spacing: -0.005em;
  }
  .md-body h1 { font-size: 1.2rem; padding-bottom: 0.3em; border-bottom: 1px solid #2f2f38; }
  .md-body h2 { font-size: 1.05rem; padding-bottom: 0.2em; border-bottom: 1px solid #2f2f38; }
  .md-body h3 { font-size: 0.95rem; }
  .md-body h4 { font-size: 0.875rem; }
  .md-body h5, .md-body h6 { font-size: 0.8125rem; color: #c9c9d0; }
  .md-body p { margin: 0.5em 0 0.75em; }
  .md-body a { color: #8ecdff; text-decoration: underline; text-decoration-thickness: 1px; text-underline-offset: 2px; }
  .md-body a:hover { color: #bce0ff; }
  .md-body strong { color: #f2f2f4; font-weight: 600; }
  .md-body em { color: #d9d9de; }
  .md-body code {
    background: #22222a; padding: 0.15em 0.4em; border-radius: 4px;
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: 0.85em; color: #f2f2f4; white-space: break-spaces;
  }
  .md-body pre {
    background: #0d0d12; border: 1px solid #2f2f38; border-radius: 6px;
    padding: 0.75em 1em; overflow-x: auto; margin: 0.75em 0;
    font-size: 0.75rem; line-height: 1.5;
  }
  .md-body pre code { background: transparent; padding: 0; border-radius: 0; font-size: inherit; white-space: pre; }
  .md-body blockquote {
    border-left: 3px solid #338dff; padding: 0.15em 1em;
    color: #c9c9d0; margin: 0.75em 0; background: rgba(51,141,255,0.04);
  }
  .md-body ul, .md-body ol { margin: 0.5em 0 0.75em; padding-left: 1.75em; }
  .md-body li { margin: 0.2em 0; }
  .md-body li > p { margin: 0.25em 0; }
  .md-body ul ul, .md-body ol ol, .md-body ul ol, .md-body ol ul { margin: 0.15em 0; }
  .md-body details {
    border: 1px solid #2f2f38; border-radius: 6px;
    padding: 0.5em 0.9em; margin: 0.6em 0; background: #16161c;
  }
  .md-body details[open] { background: #1c1c23; }
  .md-body summary {
    cursor: pointer; color: #c9c9d0; font-weight: 500;
    margin: 0; list-style: none; user-select: none;
  }
  .md-body summary::-webkit-details-marker { display: none; }
  .md-body summary::before { content: "▸ "; color: #6e6e7a; }
  .md-body details[open] > summary::before { content: "▾ "; color: #59b0ff; }
  .md-body summary:hover { color: #f2f2f4; }
  .md-body details[open] > summary { margin-bottom: 0.5em; padding-bottom: 0.5em; border-bottom: 1px solid #2f2f38; }
  .md-body table {
    width: 100%; border-collapse: collapse;
    margin: 0.75em 0; font-size: 0.8125rem;
  }
  .md-body table th, .md-body table td {
    text-align: left; padding: 0.4em 0.75em; border: 1px solid #2f2f38;
  }
  .md-body table th { background: #1c1c23; color: #f2f2f4; font-weight: 600; }
  .md-body table tr:nth-child(even) { background: rgba(47,47,56,0.2); }
  .md-body hr { border: 0; border-top: 1px solid #2f2f38; margin: 1.25em 0; }
  .md-body img { max-width: 100%; border-radius: 4px; }
  .md-body input[type="checkbox"] {
    margin-right: 0.4em; accent-color: #338dff;
    vertical-align: middle; width: 0.9em; height: 0.9em;
  }
  .md-body .task-list-item { list-style: none; margin-left: -1.5em; }

  /* Raw/rendered markdown toggle wrapper (used on the PR summary card) */
  [data-md-wrap] .md-raw { display: none !important; }
  [data-md-wrap].show-raw .md-rendered { display: none !important; }
  [data-md-wrap].show-raw .md-raw { display: block !important; }

  /* Compact layout helpers that also don't depend on Tailwind */
  .muted-dim { color: #6e6e7a; }
  .num-crit { color: #fca5a5; font-weight: 600; }
  .num-strong { color: #f2f2f4; font-weight: 600; }
  .mono, .font-mono { font-family: 'JetBrains Mono', ui-monospace, monospace; }

  /* Minimal layout utility shims — used only if the Tailwind CDN fails.
     Each is a best-effort equivalent of the Tailwind class. Where Tailwind
     loads, it overrides via equal specificity + later source order. */
  .flex { display: flex; }
  .inline-flex { display: inline-flex; }
  .grid { display: grid; }
  .block { display: block; }
  .hidden { display: none; }
  .items-center { align-items: center; }
  .items-start { align-items: flex-start; }
  .items-end { align-items: flex-end; }
  .justify-between { justify-content: space-between; }
  .justify-end { justify-content: flex-end; }
  .justify-center { justify-content: center; }
  .gap-1 { gap: 0.25rem; }
  .gap-2 { gap: 0.5rem; }
  .gap-3 { gap: 0.75rem; }
  .gap-4 { gap: 1rem; }
  .gap-5 { gap: 1.25rem; }
  .gap-6 { gap: 1.5rem; }
  .grid-cols-1 { grid-template-columns: repeat(1, minmax(0, 1fr)); }
  .grid-cols-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  @media (min-width: 768px) {
    .md\\:grid-cols-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .md\\:grid-cols-3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .md\\:grid-cols-4 { grid-template-columns: repeat(4, minmax(0, 1fr)); }
    .md\\:grid-cols-6 { grid-template-columns: repeat(6, minmax(0, 1fr)); }
    .md\\:flex { display: flex; }
  }
  .p-2 { padding: 0.5rem; }
  .p-3 { padding: 0.75rem; }
  .p-4 { padding: 1rem; }
  .p-6 { padding: 1.5rem; }
  .p-8 { padding: 2rem; }
  .px-3 { padding-left: 0.75rem; padding-right: 0.75rem; }
  .px-4 { padding-left: 1rem; padding-right: 1rem; }
  .px-6 { padding-left: 1.5rem; padding-right: 1.5rem; }
  .py-1 { padding-top: 0.25rem; padding-bottom: 0.25rem; }
  .py-2 { padding-top: 0.5rem; padding-bottom: 0.5rem; }
  .py-3 { padding-top: 0.75rem; padding-bottom: 0.75rem; }
  .py-4 { padding-top: 1rem; padding-bottom: 1rem; }
  .py-6 { padding-top: 1.5rem; padding-bottom: 1.5rem; }
  .py-8 { padding-top: 2rem; padding-bottom: 2rem; }
  .mb-1 { margin-bottom: 0.25rem; }
  .mb-2 { margin-bottom: 0.5rem; }
  .mb-3 { margin-bottom: 0.75rem; }
  .mb-4 { margin-bottom: 1rem; }
  .mb-5 { margin-bottom: 1.25rem; }
  .mb-6 { margin-bottom: 1.5rem; }
  .mt-1 { margin-top: 0.25rem; }
  .mt-2 { margin-top: 0.5rem; }
  .mt-3 { margin-top: 0.75rem; }
  .mt-4 { margin-top: 1rem; }
  .ml-auto { margin-left: auto; }
  .h-12 { height: 3rem; }
  .h-16 { height: 4rem; }
  .w-3 { width: 0.75rem; }
  .w-3\\.5 { width: 0.875rem; }
  .w-4 { width: 1rem; }
  .w-5 { width: 1.25rem; }
  .w-6 { width: 1.5rem; }
  .w-8 { width: 2rem; }
  .h-3 { height: 0.75rem; }
  .h-3\\.5 { height: 0.875rem; }
  .h-4 { height: 1rem; }
  .h-5 { height: 1.25rem; }
  .h-6 { height: 1.5rem; }
  .h-8 { height: 2rem; }
  .text-xs { font-size: 0.75rem; line-height: 1rem; }
  .text-sm { font-size: 0.875rem; line-height: 1.25rem; }
  .text-base { font-size: 1rem; line-height: 1.5rem; }
  .text-lg { font-size: 1.125rem; line-height: 1.75rem; }
  .text-xl { font-size: 1.25rem; line-height: 1.75rem; }
  .text-2xl { font-size: 1.5rem; line-height: 2rem; }
  .font-medium { font-weight: 500; }
  .font-semibold { font-weight: 600; }
  .font-bold { font-weight: 700; }
  .tracking-tight { letter-spacing: -0.015em; }
  .tracking-wider { letter-spacing: 0.05em; }
  .uppercase { text-transform: uppercase; }
  .tabular-nums { font-variant-numeric: tabular-nums; }
  .text-left { text-align: left; }
  .text-right { text-align: right; }
  .text-center { text-align: center; }
  .rounded { border-radius: 0.25rem; }
  .rounded-md { border-radius: 0.375rem; }
  .rounded-lg { border-radius: 0.5rem; }
  .rounded-xl { border-radius: 0.75rem; }
  .rounded-full { border-radius: 9999px; }
  .border { border: 1px solid; }
  .border-b { border-bottom: 1px solid; }
  .border-t { border-top: 1px solid; }
  .min-w-0 { min-width: 0; }
  .max-w-7xl { max-width: 80rem; }
  .max-w-md { max-width: 28rem; }
  .max-w-xs { max-width: 20rem; }
  .max-h-64 { max-height: 16rem; }
  .max-h-80 { max-height: 20rem; }
  .max-h-96 { max-height: 24rem; }
  .truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .whitespace-nowrap { white-space: nowrap; }
  .whitespace-pre-wrap { white-space: pre-wrap; }
  .whitespace-pre { white-space: pre; }
  .overflow-hidden { overflow: hidden; }
  .overflow-auto { overflow: auto; }
  .overflow-x-auto { overflow-x: auto; }
  .break-words { overflow-wrap: break-word; word-wrap: break-word; }
  .shrink-0 { flex-shrink: 0; }
  .flex-1 { flex: 1 1 0%; }
  .min-h-screen { min-height: 100vh; }
  .sticky { position: sticky; }
  .top-0 { top: 0; }
  .z-50 { z-index: 50; }
  .transition-colors { transition-property: color, background-color, border-color; transition-duration: 0.12s; }
  .backdrop-blur { backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); }
  .leading-tight { line-height: 1.25; }
  .leading-relaxed { line-height: 1.625; }
  .cursor-pointer { cursor: pointer; }
  .divide-y > * + * { border-top: 1px solid #22222a; }
  .divide-surface-800 > * + * { border-top-color: #22222a; }


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
