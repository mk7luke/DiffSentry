import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestContext {
  user: { login: string } | null;
}

const als = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return als.run(ctx, fn);
}

export function getRequestContext(): RequestContext {
  return als.getStore() ?? { user: null };
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

const LOGO_SVG = `<svg class="w-8 h-8" viewBox="0 0 536.47 603.92" aria-hidden="true">
  <path fill="currentColor" d="M268.5,603.92l-20.91-9.38c-52.32-23.47-92.73-49.8-135.59-87.15l-4.73-4.12c-11.43-9.96-21.23-20.67-30.91-32.29-27.54-33.04-48.51-70.17-60.28-111.6-6.77-23.85-10.93-47.15-13.25-71.67l-2.51-26.52-.24-13.23-.07-157.57c38.42-5.4,74.93-13.75,111.72-23.56l32.28-10.16c43.05-14.96,84.19-33.91,124.25-56.66,27.33,15.02,54.88,28.48,83.72,40.65,47.68,20.13,96.79,33.9,147.61,43.15l36.88,6.54-.1,85.75-.77,85.38c-.26,28.47-3.73,56.26-11.57,83.52l-5.79,20.14c-12.87,44.76-39.64,86.03-71.1,119.91-31.24,33.64-69.83,61.49-109.55,84.35-22.43,12.91-45,23.23-69.08,34.52ZM147.17,488.52c2.4,2.21,4.48,4.05,6.83,5.74l35.64,25.66c8.86,6.38,28.81,18.38,38.59,23.13l39.87,19.35c17.05-8.29,33.15-15.63,49.46-25.02,85.9-49.43,157.12-118.34,173.56-220.35,5.1-31.44,7.33-61.97,7.32-93.96l-.02-100.75c-83.18-14.52-156.14-39.09-230.34-78.19l-18.94,9.74c-68.9,33.69-134.48,55.7-211.11,68.48v100.67c0,15.97.48,30.85,1.59,46.54l2.29,23.71c2.42,25.08,11.06,61.19,20.89,84.67,4.83,11.54,10.78,22.67,17.11,33.59,6.35,10.94,29.09,41.03,37.68,49.18l19.54,18.55,10.04,9.26Z"/>
  <path fill="currentColor" d="M257.35,403.5l-7.47,21.73-38.54-.06,24.45-75.46,32.02-99.95,16.03-50.21,7.02-23.02,38.7.14-19.65,62.36c-2.16,4.7-3.07,9.53-4.62,14.39l-16.17,50.51-31.78,99.58Z"/>
  <polygon fill="currentColor" points="180.11 363 142.47 362.94 142.27 316.11 96.54 315.92 96.47 278.26 142.29 278.45 142.66 231.04 180.17 231.13 180.08 278.19 225.93 278.34 225.99 316.11 180.25 315.98 180.11 363"/>
  <rect fill="currentColor" x="360.68" y="238.68" width="38.9" height="117.72" transform="translate(82.38 677.5) rotate(-89.97)"/>
</svg>`;

const TAILWIND_CONFIG = `window.tailwind = window.tailwind || {};
window.tailwind.config = {
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
      colors: {
        brand: {
          50: '#eef7ff', 100: '#d9edff', 200: '#bce0ff', 300: '#8ecdff',
          400: '#59b0ff', 500: '#338dff', 600: '#1a6df5', 700: '#1457e1',
          800: '#1746b6', 900: '#193d8f', 950: '#142757',
        },
        surface: {
          50: '#f7f7f8', 100: '#eeeef0', 200: '#d9d9de', 300: '#b8b8c1',
          400: '#91919f', 500: '#737384', 600: '#5d5d6c', 700: '#4c4c58',
          800: '#41414b', 900: '#393941', 950: '#18181b',
        },
      },
    },
  },
};`;

const BASE_STYLES = `
  html { background: #0a0a0f; }
  body { background: transparent; font-family: 'Inter', system-ui, sans-serif; }
  ::-webkit-scrollbar { width: 8px; height: 8px; }
  ::-webkit-scrollbar-track { background: #18181b; }
  ::-webkit-scrollbar-thumb { background: #393941; border-radius: 4px; }
  ::-webkit-scrollbar-thumb:hover { background: #4c4c58; }

  /* Drifting mesh + cursor-tracking glow (same as the static site) */
  .bg-mesh {
    position: fixed; inset: -10%; pointer-events: none; z-index: -1;
    background:
      radial-gradient(900px 700px at 18% -6%, rgba(51, 141, 255, 0.12), transparent 55%),
      radial-gradient(780px 620px at 86% 32%, rgba(138, 92, 255, 0.08), transparent 58%),
      radial-gradient(1100px 800px at 50% 118%, rgba(51, 141, 255, 0.07), transparent 60%),
      linear-gradient(180deg, #0a0a0f 0%, #0d0d15 50%, #0a0a0f 100%);
    animation: meshDrift 28s ease-in-out infinite alternate;
  }
  @keyframes meshDrift {
    0%   { transform: translate(-1.5%, -0.8%) scale(1); }
    100% { transform: translate( 1.5%,  0.8%) scale(1.02); }
  }
  .bg-glow {
    position: fixed; inset: 0; pointer-events: none; z-index: -1;
    background: radial-gradient(520px circle at var(--mx, 50%) var(--my, 30%), rgba(89, 176, 255, 0.10), transparent 60%);
    transition: background 0.12s ease;
  }
  @media (prefers-reduced-motion: reduce) {
    .bg-mesh { animation: none; }
    .bg-glow { display: none; }
  }

  .gradient-text {
    background: linear-gradient(135deg, #338dff 0%, #59b0ff 50%, #8ecdff 100%);
    -webkit-background-clip: text; -webkit-text-fill-color: transparent;
    background-clip: text;
  }
  .nav-blur { backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); }

  /* Card hover halo */
  .card-glow { transition: border-color 0.2s ease, box-shadow 0.3s ease; }
  .card-glow:hover {
    border-color: rgba(51, 141, 255, 0.35);
    box-shadow: 0 0 30px rgba(51, 141, 255, 0.10), 0 0 60px rgba(51, 141, 255, 0.05);
  }

  /* Section eyebrow label */
  .eyebrow {
    display: inline-flex; align-items: center; gap: 0.55rem;
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.7rem; font-weight: 600; letter-spacing: 0.1em;
    text-transform: uppercase; color: #59b0ff;
  }
  .eyebrow::before {
    content: ''; width: 0.4rem; height: 0.4rem; border-radius: 50%;
    background: #59b0ff; box-shadow: 0 0 10px rgba(89, 176, 255, 0.55);
  }

  /* Focus ring */
  a:focus-visible, button:focus-visible, [role="button"]:focus-visible {
    outline: 2px solid #59b0ff; outline-offset: 2px; border-radius: 0.375rem;
  }

  /* Form inputs on dark */
  input[type="text"], input:not([type]), select {
    background-color: rgba(24, 24, 27, 0.6);
    border-color: rgba(65, 65, 75, 0.6);
    color: #d9d9de;
  }
  input::placeholder { color: #737384; }
  input:focus, select:focus { border-color: rgba(51, 141, 255, 0.5); outline: none; }

  /* Section title "card" helper */
  .panel { background: rgba(24, 24, 27, 0.55); border: 1px solid rgba(65, 65, 75, 0.55); border-radius: 1rem; }
  .panel-head { border-bottom: 1px solid rgba(65, 65, 75, 0.45); }
`;

const CURSOR_GLOW_SCRIPT = `
  (function(){
    var glow = document.querySelector('.bg-glow');
    if (!glow) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    document.addEventListener('mousemove', function(e){
      var x = (e.clientX / window.innerWidth) * 100;
      var y = (e.clientY / window.innerHeight) * 100;
      glow.style.setProperty('--mx', x + '%');
      glow.style.setProperty('--my', y + '%');
    }, { passive: true });
  })();
`;

export function renderLayout(opts: { title: string; crumbs?: Crumb[]; body: string; user?: CurrentUser | null }): string {
  const crumbs = opts.crumbs ?? [];
  const user = opts.user ?? getRequestContext().user;
  const crumbHtml = crumbs.length
    ? `<nav class="text-xs text-surface-400 mb-5 font-mono">${crumbs
        .map((c, i) => {
          const part = c.href
            ? `<a href="${esc(c.href)}" class="hover:text-brand-300 transition-colors">${esc(c.label)}</a>`
            : `<span class="text-surface-200">${esc(c.label)}</span>`;
          return i === 0 ? part : ` <span class="mx-1.5 text-surface-600">/</span> ${part}`;
        })
        .join("")}</nav>`
    : "";
  const navLink = (href: string, label: string) =>
    `<a href="${esc(href)}" class="text-sm text-surface-300 hover:text-white transition-colors">${esc(label)}</a>`;
  return `<!doctype html>
<html lang="en" class="scroll-smooth">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(opts.title)} — DiffSentry</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <script>${TAILWIND_CONFIG}</script>
  <script src="https://cdn.tailwindcss.com/3.4.17"></script>
  <style>${BASE_STYLES}</style>
</head>
<body class="bg-surface-950 text-surface-200 font-sans antialiased min-h-screen">
  <div class="bg-mesh" aria-hidden="true"></div>
  <div class="bg-glow" aria-hidden="true"></div>

  <nav class="sticky top-0 w-full z-50 nav-blur bg-surface-950/80 border-b border-surface-800/50">
    <div class="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
      <a href="/dashboard" class="flex items-center gap-3 text-brand-400 hover:text-brand-300 transition-colors">
        ${LOGO_SVG}
        <span class="font-bold text-base text-white font-mono tracking-tight">Diff<span class="text-brand-400">Sentry</span></span>
      </a>
      <div class="hidden md:flex items-center gap-7">
        ${navLink("/dashboard", "Repos")}
        ${navLink("/dashboard/findings", "Findings")}
        ${navLink("/dashboard/patterns", "Patterns")}
        ${navLink("/dashboard/settings", "Settings")}
      </div>
      <div class="flex items-center gap-3 text-xs">
        <span class="hidden sm:inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-brand-950/50 border border-brand-800/40 text-brand-400 font-mono">
          <span class="w-1.5 h-1.5 rounded-full bg-brand-400 animate-pulse"></span>read-only
        </span>
        ${
          user
            ? `<span class="text-surface-300 font-mono">@${esc(user.login)}</span>
               <a href="/dashboard/auth/logout" class="text-surface-400 hover:text-white transition-colors">logout</a>`
            : ""
        }
      </div>
    </div>
  </nav>

  <main class="max-w-7xl mx-auto px-6 py-8">
    ${crumbHtml}
    ${opts.body}
  </main>

  <script>${CURSOR_GLOW_SCRIPT}</script>
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
  critical: "bg-red-500/15 text-red-300 ring-red-500/30",
  major: "bg-orange-500/15 text-orange-300 ring-orange-500/30",
  minor: "bg-amber-500/15 text-amber-300 ring-amber-500/30",
  nit: "bg-surface-700/40 text-surface-300 ring-surface-600/40",
};
export function severityBadge(sev: string | null | undefined): string {
  const k = (sev ?? "").toLowerCase();
  const cls = SEVERITY_CLASSES[k] ?? "bg-surface-700/40 text-surface-300 ring-surface-600/40";
  return `<span class="inline-flex items-center rounded px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${cls}">${esc(sev ?? "—")}</span>`;
}

const RISK_CLASSES: Record<string, string> = {
  low: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30",
  moderate: "bg-amber-500/15 text-amber-300 ring-amber-500/30",
  elevated: "bg-orange-500/15 text-orange-300 ring-orange-500/30",
  high: "bg-red-500/15 text-red-300 ring-red-500/30",
  critical: "bg-red-500/25 text-red-200 ring-red-500/40",
};
export function riskBadge(level: string | null | undefined, score?: number | null): string {
  const k = (level ?? "").toLowerCase();
  const cls = RISK_CLASSES[k] ?? "bg-surface-700/40 text-surface-300 ring-surface-600/40";
  const s = typeof score === "number" ? ` · ${score}` : "";
  return `<span class="inline-flex items-center rounded px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${cls}">${esc(level ?? "—")}${s}</span>`;
}
