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

export function renderLayout(opts: { title: string; crumbs?: Crumb[]; body: string; user?: CurrentUser | null }): string {
  const crumbs = opts.crumbs ?? [];
  const user = opts.user ?? getRequestContext().user;
  const crumbHtml = crumbs.length
    ? `<nav class="text-sm text-slate-500 mb-4">${crumbs
        .map((c, i) => {
          const part = c.href
            ? `<a href="${esc(c.href)}" class="hover:text-slate-900 hover:underline">${esc(c.label)}</a>`
            : `<span class="text-slate-700">${esc(c.label)}</span>`;
          return i === 0 ? part : ` <span class="mx-1 text-slate-400">/</span> ${part}`;
        })
        .join("")}</nav>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(opts.title)} — DiffSentry</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
  </style>
</head>
<body class="bg-slate-50 text-slate-900">
  <header class="border-b border-slate-200 bg-white">
    <div class="max-w-7xl mx-auto px-6 py-3 flex items-center gap-6">
      <a href="/dashboard" class="font-semibold text-slate-900 hover:text-slate-700">DiffSentry</a>
      <nav class="flex items-center gap-4 text-sm text-slate-600">
        <a href="/dashboard" class="hover:text-slate-900">Repos</a>
        <a href="/dashboard/findings" class="hover:text-slate-900">Findings</a>
        <a href="/dashboard/patterns" class="hover:text-slate-900">Patterns</a>
        <a href="/dashboard/settings" class="hover:text-slate-900">Settings</a>
      </nav>
      <div class="ml-auto flex items-center gap-3 text-xs">
        <span class="text-slate-400 font-mono">read-only</span>
        ${
          user
            ? `<span class="text-slate-500">@${esc(user.login)}</span>
               <a href="/dashboard/auth/logout" class="text-slate-500 hover:text-slate-900">logout</a>`
            : ""
        }
      </div>
    </div>
  </header>
  <main class="max-w-7xl mx-auto px-6 py-6">
    ${crumbHtml}
    ${opts.body}
  </main>
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
  critical: "bg-red-100 text-red-800 ring-red-200",
  major: "bg-orange-100 text-orange-800 ring-orange-200",
  minor: "bg-amber-100 text-amber-800 ring-amber-200",
  nit: "bg-slate-100 text-slate-700 ring-slate-200",
};
export function severityBadge(sev: string | null | undefined): string {
  const k = (sev ?? "").toLowerCase();
  const cls = SEVERITY_CLASSES[k] ?? "bg-slate-100 text-slate-700 ring-slate-200";
  return `<span class="inline-flex items-center rounded px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${cls}">${esc(sev ?? "—")}</span>`;
}

const RISK_CLASSES: Record<string, string> = {
  low: "bg-emerald-100 text-emerald-800 ring-emerald-200",
  moderate: "bg-amber-100 text-amber-800 ring-amber-200",
  elevated: "bg-orange-100 text-orange-800 ring-orange-200",
  high: "bg-red-100 text-red-800 ring-red-200",
  critical: "bg-red-200 text-red-900 ring-red-300",
};
export function riskBadge(level: string | null | undefined, score?: number | null): string {
  const k = (level ?? "").toLowerCase();
  const cls = RISK_CLASSES[k] ?? "bg-slate-100 text-slate-700 ring-slate-200";
  const s = typeof score === "number" ? ` · ${score}` : "";
  return `<span class="inline-flex items-center rounded px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${cls}">${esc(level ?? "—")}${s}</span>`;
}
