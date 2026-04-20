import express from "express";
import { logger } from "../logger.js";
import { esc, relativeTime, renderLayout, riskBadge, severityBadge } from "./layout.js";
import {
  getEvents,
  getFindings,
  getHealthCounts,
  getHotPaths,
  getPR,
  getPRReviews,
  getPatternRules,
  getRecentReviews,
  getRepoOverview,
  getSparkline,
  getTopRules,
  queryFindings,
  queryFingerprintGroups,
  repoExists,
  type FindingFilters,
  type FingerprintGroupRow,
  type HealthCounts,
  type PatternRuleRow,
  type RepoOverviewRow,
  type SparklinePoint,
} from "./queries.js";

export function createDashboardRouter(): express.Router {
  const router = express.Router();

  router.get("/", (req, res) => {
    try {
      const sort = typeof req.query.sort === "string" ? req.query.sort : "last_review";
      const rows = sortRepos(getRepoOverview(), sort);
      res.type("html").send(renderReposOverview(rows, sort));
    } catch (err) {
      logger.error({ err }, "dashboard / failed");
      res.status(500).type("html").send(renderError("Failed to load repos overview."));
    }
  });

  router.get("/repo/:owner/:repo", (req, res) => {
    const owner = req.params.owner;
    const repo = req.params.repo;
    try {
      if (!repoExists(owner, repo)) {
        res.status(404).type("html").send(renderNotFound(`No data for ${owner}/${repo}`));
        return;
      }
      const sparkline = getSparkline(owner, repo);
      const hotPaths = getHotPaths(owner, repo);
      const topRules = getTopRules(owner, repo);
      const reviews = getRecentReviews(owner, repo, 50);
      res.type("html").send(renderRepoDetail({ owner, repo, sparkline, hotPaths, topRules, reviews }));
    } catch (err) {
      logger.error({ err, owner, repo }, "dashboard repo detail failed");
      res.status(500).type("html").send(renderError("Failed to load repo detail."));
    }
  });

  router.get("/findings", (req, res) => {
    try {
      const filters = parseFindingFilters(req.query);
      const { rows, total } = queryFindings(filters);
      const groups = queryFingerprintGroups(filters, 20);
      res.type("html").send(renderFindings({ filters, rows, total, groups, query: req.query }));
    } catch (err) {
      logger.error({ err }, "dashboard /findings failed");
      res.status(500).type("html").send(renderError("Failed to load findings."));
    }
  });

  router.get("/patterns", (_req, res) => {
    try {
      const rules = getPatternRules(200);
      res.type("html").send(renderPatterns(rules));
    } catch (err) {
      logger.error({ err }, "dashboard /patterns failed");
      res.status(500).type("html").send(renderError("Failed to load patterns."));
    }
  });

  router.get("/settings", (_req, res) => {
    try {
      const counts = getHealthCounts();
      res.type("html").send(renderSettings(counts));
    } catch (err) {
      logger.error({ err }, "dashboard /settings failed");
      res.status(500).type("html").send(renderError("Failed to load settings."));
    }
  });

  router.get("/repo/:owner/:repo/pr/:number", (req, res) => {
    const owner = req.params.owner;
    const repo = req.params.repo;
    const number = Number.parseInt(req.params.number, 10);
    if (!Number.isFinite(number) || number <= 0) {
      res.status(400).type("html").send(renderError("Invalid PR number."));
      return;
    }
    try {
      const pr = getPR(owner, repo, number);
      const reviews = getPRReviews(owner, repo, number);
      if (!pr && reviews.length === 0) {
        res.status(404).type("html").send(renderNotFound(`No data for ${owner}/${repo}#${number}`));
        return;
      }
      const latest = reviews[0] ?? null;
      const findings = latest ? getFindings(latest.id) : [];
      const events = getEvents(owner, repo, number, 200);
      res.type("html").send(renderPRDetail({ owner, repo, number, pr, reviews, latest, findings, events }));
    } catch (err) {
      logger.error({ err, owner, repo, number }, "dashboard PR detail failed");
      res.status(500).type("html").send(renderError("Failed to load PR detail."));
    }
  });

  return router;
}

// ─── Repos overview ────────────────────────────────────────────────

function sortRepos(rows: RepoOverviewRow[], key: string): RepoOverviewRow[] {
  const cmp: Record<string, (a: RepoOverviewRow, b: RepoOverviewRow) => number> = {
    repo: (a, b) => `${a.owner}/${a.repo}`.localeCompare(`${b.owner}/${b.repo}`),
    prs_reviewed: (a, b) => b.prs_reviewed - a.prs_reviewed,
    findings_7d: (a, b) => b.findings_7d - a.findings_7d,
    critical_7d: (a, b) => b.critical_7d - a.critical_7d,
    last_review: (a, b) => (b.last_review ?? "").localeCompare(a.last_review ?? ""),
  };
  const fn = cmp[key] ?? cmp.last_review;
  return [...rows].sort(fn);
}

function sortHeader(label: string, key: string, current: string): string {
  const active = key === current;
  const cls = active ? "text-slate-900 font-semibold" : "text-slate-500 hover:text-slate-900";
  const arrow = active ? ' <span class="text-slate-400">↓</span>' : "";
  return `<a href="/dashboard?sort=${esc(key)}" class="${cls}">${esc(label)}${arrow}</a>`;
}

function renderReposOverview(rows: RepoOverviewRow[], sort: string): string {
  const body = rows.length === 0
    ? `<div class="bg-white border border-slate-200 rounded-lg p-8 text-center text-slate-500">
         No repos recorded yet. Open a PR in an installed repo to populate the database.
       </div>`
    : `<div class="bg-white border border-slate-200 rounded-lg overflow-hidden">
         <table class="min-w-full text-sm">
           <thead class="bg-slate-50 border-b border-slate-200">
             <tr>
               <th class="text-left px-4 py-2">${sortHeader("Repo", "repo", sort)}</th>
               <th class="text-right px-4 py-2">${sortHeader("PRs reviewed", "prs_reviewed", sort)}</th>
               <th class="text-right px-4 py-2">${sortHeader("Findings · 7d", "findings_7d", sort)}</th>
               <th class="text-right px-4 py-2">${sortHeader("Critical · 7d", "critical_7d", sort)}</th>
               <th class="text-right px-4 py-2">${sortHeader("Last review", "last_review", sort)}</th>
             </tr>
           </thead>
           <tbody class="divide-y divide-slate-100">
             ${rows
               .map((r) => {
                 const href = `/dashboard/repo/${encodeURIComponent(r.owner)}/${encodeURIComponent(r.repo)}`;
                 const critCls = r.critical_7d > 0 ? "text-red-700 font-semibold" : "text-slate-500";
                 return `<tr class="hover:bg-slate-50">
                   <td class="px-4 py-2"><a href="${esc(href)}" class="text-slate-900 hover:underline">${esc(r.owner)}/${esc(r.repo)}</a></td>
                   <td class="px-4 py-2 text-right tabular-nums">${r.prs_reviewed}</td>
                   <td class="px-4 py-2 text-right tabular-nums">${r.findings_7d}</td>
                   <td class="px-4 py-2 text-right tabular-nums ${critCls}">${r.critical_7d}</td>
                   <td class="px-4 py-2 text-right text-slate-500">${esc(relativeTime(r.last_review))}</td>
                 </tr>`;
               })
               .join("")}
           </tbody>
         </table>
       </div>`;
  return renderLayout({
    title: "Repos",
    crumbs: [{ label: "Repos" }],
    body: `<h1 class="text-xl font-semibold mb-4">Repos</h1>${body}`,
  });
}

// ─── Repo detail ───────────────────────────────────────────────────

interface RepoDetailArgs {
  owner: string;
  repo: string;
  sparkline: SparklinePoint[];
  hotPaths: ReturnType<typeof getHotPaths>;
  topRules: ReturnType<typeof getTopRules>;
  reviews: ReturnType<typeof getRecentReviews>;
}

function renderSparkline(points: SparklinePoint[]): string {
  if (points.length < 2) {
    return `<div class="text-slate-400 text-sm">Not enough reviews yet for a 90-day chart.</div>`;
  }
  const w = 720;
  const h = 80;
  const pad = 4;
  const max = 100; // risk_score is 0..100
  const n = points.length;
  const coords = points.map((p, i) => {
    const x = pad + (i * (w - 2 * pad)) / Math.max(1, n - 1);
    const score = typeof p.risk_score === "number" ? p.risk_score : 0;
    const y = h - pad - (score / max) * (h - 2 * pad);
    return [x, y, p] as const;
  });
  const polyline = coords.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const dots = coords
    .map(([x, y, p]) => {
      const score = typeof p.risk_score === "number" ? p.risk_score : 0;
      const color = score >= 75 ? "#dc2626" : score >= 55 ? "#ea580c" : score >= 35 ? "#d97706" : score >= 15 ? "#ca8a04" : "#16a34a";
      const title = `#${p.number} · ${score} · ${p.created_at}`;
      return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.5" fill="${color}"><title>${esc(title)}</title></circle>`;
    })
    .join("");
  return `<svg viewBox="0 0 ${w} ${h}" class="w-full h-20" preserveAspectRatio="none">
    <polyline points="${polyline}" fill="none" stroke="#64748b" stroke-width="1.2" />
    ${dots}
  </svg>`;
}

function renderRepoDetail(a: RepoDetailArgs): string {
  const title = `${a.owner}/${a.repo}`;
  const sparklineHtml = renderSparkline(a.sparkline);
  const hotPathsHtml = a.hotPaths.length === 0
    ? `<div class="text-slate-400 text-sm">No critical or major findings in the last 90 days.</div>`
    : `<table class="w-full text-sm">
         <thead class="text-slate-500">
           <tr>
             <th class="text-left py-1">Path</th>
             <th class="text-right py-1">Critical</th>
             <th class="text-right py-1">Major</th>
             <th class="text-right py-1">Total</th>
           </tr>
         </thead>
         <tbody class="divide-y divide-slate-100">
           ${a.hotPaths
             .map(
               (p) => `<tr>
                 <td class="py-1 font-mono text-xs truncate max-w-md">${esc(p.path)}</td>
                 <td class="py-1 text-right tabular-nums ${p.critical > 0 ? "text-red-700 font-semibold" : ""}">${p.critical}</td>
                 <td class="py-1 text-right tabular-nums">${p.major}</td>
                 <td class="py-1 text-right tabular-nums text-slate-500">${p.total}</td>
               </tr>`,
             )
             .join("")}
         </tbody>
       </table>`;
  const topRulesHtml = a.topRules.length === 0
    ? `<div class="text-slate-400 text-sm">No pattern-rule hits recorded.</div>`
    : `<table class="w-full text-sm">
         <thead class="text-slate-500">
           <tr>
             <th class="text-left py-1">Rule</th>
             <th class="text-left py-1">Source</th>
             <th class="text-right py-1">Hits</th>
             <th class="text-right py-1">Example</th>
           </tr>
         </thead>
         <tbody class="divide-y divide-slate-100">
           ${a.topRules
             .map(
               (r) => `<tr>
                 <td class="py-1 font-mono text-xs">${esc(r.rule_name)}</td>
                 <td class="py-1 text-xs text-slate-500">${esc(r.source)}</td>
                 <td class="py-1 text-right tabular-nums">${r.hits}</td>
                 <td class="py-1 text-right">${
                   r.example_pr
                     ? `<a class="text-blue-600 hover:underline" href="/dashboard/repo/${encodeURIComponent(a.owner)}/${encodeURIComponent(a.repo)}/pr/${r.example_pr}">#${r.example_pr}</a>`
                     : `<span class="text-slate-400">—</span>`
                 }</td>
               </tr>`,
             )
             .join("")}
         </tbody>
       </table>`;
  const reviewsHtml = a.reviews.length === 0
    ? `<div class="text-slate-400 text-sm">No reviews recorded yet.</div>`
    : `<table class="min-w-full text-sm">
         <thead class="bg-slate-50 border-b border-slate-200 text-slate-500">
           <tr>
             <th class="text-left px-4 py-2">PR</th>
             <th class="text-left px-4 py-2">Title</th>
             <th class="text-left px-4 py-2">Author</th>
             <th class="text-left px-4 py-2">Risk</th>
             <th class="text-right px-4 py-2">Findings</th>
             <th class="text-left px-4 py-2">Approval</th>
             <th class="text-right px-4 py-2">When</th>
           </tr>
         </thead>
         <tbody class="divide-y divide-slate-100">
           ${a.reviews
             .map((rv) => {
               const href = `/dashboard/repo/${encodeURIComponent(a.owner)}/${encodeURIComponent(a.repo)}/pr/${rv.number}`;
               return `<tr class="hover:bg-slate-50">
                 <td class="px-4 py-2"><a href="${esc(href)}" class="text-blue-600 hover:underline">#${rv.number}</a></td>
                 <td class="px-4 py-2 truncate max-w-md">${esc(rv.title ?? "—")}</td>
                 <td class="px-4 py-2 text-slate-500">${esc(rv.author ?? "—")}</td>
                 <td class="px-4 py-2">${riskBadge(rv.risk_level, rv.risk_score)}</td>
                 <td class="px-4 py-2 text-right tabular-nums">${rv.finding_count}</td>
                 <td class="px-4 py-2 text-xs text-slate-500">${esc(rv.approval ?? "—")}</td>
                 <td class="px-4 py-2 text-right text-slate-500">${esc(relativeTime(rv.created_at))}</td>
               </tr>`;
             })
             .join("")}
         </tbody>
       </table>`;

  const body = `
    <div class="flex items-center justify-between mb-4">
      <h1 class="text-xl font-semibold">${esc(title)}</h1>
      <a href="https://github.com/${esc(a.owner)}/${esc(a.repo)}" class="text-xs text-blue-600 hover:underline" target="_blank" rel="noopener">GitHub →</a>
    </div>
    <div class="grid grid-cols-1 gap-6">
      <section class="bg-white border border-slate-200 rounded-lg p-4">
        <h2 class="text-sm font-semibold text-slate-700 mb-2">Risk — last 90 days</h2>
        ${sparklineHtml}
      </section>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
        <section class="bg-white border border-slate-200 rounded-lg p-4">
          <h2 class="text-sm font-semibold text-slate-700 mb-3">Hot paths</h2>
          ${hotPathsHtml}
        </section>
        <section class="bg-white border border-slate-200 rounded-lg p-4">
          <h2 class="text-sm font-semibold text-slate-700 mb-3">Top firing rules</h2>
          ${topRulesHtml}
        </section>
      </div>
      <section class="bg-white border border-slate-200 rounded-lg overflow-hidden">
        <h2 class="text-sm font-semibold text-slate-700 px-4 py-3 border-b border-slate-200">Recent reviews</h2>
        ${reviewsHtml}
      </section>
    </div>
  `;

  return renderLayout({
    title,
    crumbs: [
      { label: "Repos", href: "/dashboard" },
      { label: `${a.owner}/${a.repo}` },
    ],
    body,
  });
}

// ─── PR detail ─────────────────────────────────────────────────────

interface PRDetailArgs {
  owner: string;
  repo: string;
  number: number;
  pr: ReturnType<typeof getPR>;
  reviews: ReturnType<typeof getPRReviews>;
  latest: ReturnType<typeof getPRReviews>[number] | null;
  findings: ReturnType<typeof getFindings>;
  events: ReturnType<typeof getEvents>;
}

function renderPRDetail(a: PRDetailArgs): string {
  const ghUrl = `https://github.com/${a.owner}/${a.repo}/pull/${a.number}`;
  const prHeader = `
    <div class="flex items-start justify-between mb-4 gap-4">
      <div>
        <h1 class="text-xl font-semibold">${esc(a.pr?.title ?? `PR #${a.number}`)}</h1>
        <div class="text-sm text-slate-500 mt-1">
          <span class="font-mono">${esc(a.owner)}/${esc(a.repo)}</span>
          · #${a.number}
          ${a.pr?.author ? ` · by <span class="text-slate-700">${esc(a.pr.author)}</span>` : ""}
          ${a.pr?.state ? ` · ${esc(a.pr.state)}` : ""}
        </div>
      </div>
      <a href="${esc(ghUrl)}" target="_blank" rel="noopener" class="text-xs text-blue-600 hover:underline whitespace-nowrap">View on GitHub →</a>
    </div>`;

  const latestHtml = a.latest
    ? `<section class="bg-white border border-slate-200 rounded-lg p-4">
         <div class="flex items-center justify-between mb-3">
           <h2 class="text-sm font-semibold text-slate-700">Latest review</h2>
           <div class="flex items-center gap-2 text-xs text-slate-500">
             ${riskBadge(a.latest.risk_level, a.latest.risk_score)}
             <span class="font-mono">${esc((a.latest.sha ?? "").slice(0, 7))}</span>
             <span>${esc(relativeTime(a.latest.created_at))}</span>
           </div>
         </div>
         <dl class="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
           <div><dt class="text-slate-500 text-xs">Profile</dt><dd>${esc(a.latest.profile ?? "—")}</dd></div>
           <div><dt class="text-slate-500 text-xs">Approval</dt><dd>${esc(a.latest.approval ?? "—")}</dd></div>
           <div><dt class="text-slate-500 text-xs">Files processed</dt><dd class="tabular-nums">${a.latest.files_processed ?? 0}</dd></div>
           <div><dt class="text-slate-500 text-xs">Findings</dt><dd class="tabular-nums">${a.latest.finding_count}</dd></div>
         </dl>
         ${
           a.latest.summary
             ? `<div class="mt-3 pt-3 border-t border-slate-100">
                  <div class="text-xs text-slate-500 mb-1">Summary</div>
                  <pre class="text-xs whitespace-pre-wrap font-sans text-slate-700 max-h-64 overflow-auto">${esc(a.latest.summary)}</pre>
                </div>`
             : ""
         }
       </section>`
    : `<div class="bg-white border border-slate-200 rounded-lg p-4 text-slate-400 text-sm">No reviews recorded for this PR.</div>`;

  const findingsHtml = a.findings.length === 0
    ? `<div class="text-slate-400 text-sm px-4 py-3">No findings in the latest review.</div>`
    : `<table class="min-w-full text-sm">
         <thead class="bg-slate-50 border-b border-slate-200 text-slate-500">
           <tr>
             <th class="text-left px-4 py-2">Severity</th>
             <th class="text-left px-4 py-2">Location</th>
             <th class="text-left px-4 py-2">Title</th>
             <th class="text-left px-4 py-2">Source</th>
           </tr>
         </thead>
         <tbody class="divide-y divide-slate-100">
           ${a.findings
             .map(
               (f) => `<tr>
                 <td class="px-4 py-2 align-top">${severityBadge(f.severity)}</td>
                 <td class="px-4 py-2 align-top font-mono text-xs">${esc(f.path ?? "")}${f.line ? `:${f.line}` : ""}</td>
                 <td class="px-4 py-2 align-top">
                   <div class="font-medium">${esc(f.title ?? "—")}</div>
                   ${f.body ? `<details class="mt-1"><summary class="text-xs text-slate-500 cursor-pointer">body</summary><pre class="text-xs whitespace-pre-wrap font-sans text-slate-600 mt-1">${esc(f.body.slice(0, 4000))}</pre></details>` : ""}
                 </td>
                 <td class="px-4 py-2 align-top text-xs text-slate-500">${esc(f.source ?? "—")}</td>
               </tr>`,
             )
             .join("")}
         </tbody>
       </table>`;

  const reviewsList = a.reviews.length <= 1
    ? ""
    : `<section class="bg-white border border-slate-200 rounded-lg overflow-hidden">
         <h2 class="text-sm font-semibold text-slate-700 px-4 py-3 border-b border-slate-200">All reviews (${a.reviews.length})</h2>
         <table class="min-w-full text-sm">
           <thead class="bg-slate-50 border-b border-slate-200 text-slate-500">
             <tr>
               <th class="text-left px-4 py-2">When</th>
               <th class="text-left px-4 py-2">SHA</th>
               <th class="text-left px-4 py-2">Profile</th>
               <th class="text-left px-4 py-2">Risk</th>
               <th class="text-right px-4 py-2">Findings</th>
               <th class="text-left px-4 py-2">Approval</th>
             </tr>
           </thead>
           <tbody class="divide-y divide-slate-100">
             ${a.reviews
               .map(
                 (rv) => `<tr>
                   <td class="px-4 py-2 text-slate-500">${esc(relativeTime(rv.created_at))}</td>
                   <td class="px-4 py-2 font-mono text-xs">${esc((rv.sha ?? "").slice(0, 7))}</td>
                   <td class="px-4 py-2 text-xs">${esc(rv.profile ?? "—")}</td>
                   <td class="px-4 py-2">${riskBadge(rv.risk_level, rv.risk_score)}</td>
                   <td class="px-4 py-2 text-right tabular-nums">${rv.finding_count}</td>
                   <td class="px-4 py-2 text-xs text-slate-500">${esc(rv.approval ?? "—")}</td>
                 </tr>`,
               )
               .join("")}
           </tbody>
         </table>
       </section>`;

  const eventsHtml = a.events.length === 0
    ? `<div class="text-slate-400 text-sm px-4 py-3">No events.</div>`
    : `<ul class="divide-y divide-slate-100">
         ${a.events
           .map(
             (ev) => `<li class="px-4 py-2 flex items-center justify-between text-sm">
               <span class="font-mono text-xs text-slate-700">${esc(ev.kind)}</span>
               <span class="text-xs text-slate-500">${esc(relativeTime(ev.ts))}</span>
             </li>`,
           )
           .join("")}
       </ul>`;

  const body = `
    ${prHeader}
    <div class="grid grid-cols-1 gap-6">
      ${latestHtml}
      <section class="bg-white border border-slate-200 rounded-lg overflow-hidden">
        <h2 class="text-sm font-semibold text-slate-700 px-4 py-3 border-b border-slate-200">Findings</h2>
        ${findingsHtml}
      </section>
      ${reviewsList}
      <section class="bg-white border border-slate-200 rounded-lg overflow-hidden">
        <h2 class="text-sm font-semibold text-slate-700 px-4 py-3 border-b border-slate-200">Events</h2>
        ${eventsHtml}
      </section>
    </div>
  `;

  return renderLayout({
    title: `${a.owner}/${a.repo} #${a.number}`,
    crumbs: [
      { label: "Repos", href: "/dashboard" },
      { label: `${a.owner}/${a.repo}`, href: `/dashboard/repo/${encodeURIComponent(a.owner)}/${encodeURIComponent(a.repo)}` },
      { label: `#${a.number}` },
    ],
    body,
  });
}

// ─── Error pages ────────────────────────────────────────────────────

function renderNotFound(msg: string): string {
  return renderLayout({
    title: "Not found",
    body: `<div class="bg-white border border-slate-200 rounded-lg p-8 text-center">
      <div class="text-slate-500 text-sm mb-2">404</div>
      <div class="text-slate-700">${esc(msg)}</div>
      <a href="/dashboard" class="inline-block mt-4 text-sm text-blue-600 hover:underline">← Back to repos</a>
    </div>`,
  });
}

function renderError(msg: string): string {
  return renderLayout({
    title: "Error",
    body: `<div class="bg-white border border-red-200 rounded-lg p-6">
      <div class="text-red-700 text-sm font-semibold">${esc(msg)}</div>
      <div class="text-slate-500 text-xs mt-1">Check server logs for details.</div>
    </div>`,
  });
}

// ─── Findings explorer ────────────────────────────────────────────

function parseFindingFilters(q: Record<string, unknown>): FindingFilters {
  const str = (k: string) => {
    const v = q[k];
    return typeof v === "string" && v.length > 0 ? v : undefined;
  };
  const num = (k: string) => {
    const v = q[k];
    if (typeof v !== "string") return undefined;
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) ? n : undefined;
  };
  return {
    severity: str("severity"),
    source: str("source"),
    repo: str("repo"),
    q: str("q"),
    fingerprint: str("fingerprint"),
    ageDays: num("age") ?? undefined,
    limit: num("limit") ?? 100,
    offset: num("offset") ?? 0,
  };
}

function queryStringFromFilters(filters: FindingFilters, overrides: Partial<FindingFilters> = {}): string {
  const merged: Record<string, string> = {};
  const put = (k: string, v: unknown) => {
    if (v !== undefined && v !== null && v !== "") merged[k] = String(v);
  };
  put("severity", filters.severity);
  put("source", filters.source);
  put("repo", filters.repo);
  put("q", filters.q);
  put("fingerprint", filters.fingerprint);
  put("age", filters.ageDays);
  for (const [k, v] of Object.entries(overrides)) {
    const out = k === "ageDays" ? "age" : k;
    if (v === undefined || v === null || v === "") delete merged[out];
    else merged[out] = String(v);
  }
  const qs = new URLSearchParams(merged).toString();
  return qs ? `?${qs}` : "";
}

interface FindingsPageArgs {
  filters: FindingFilters;
  rows: ReturnType<typeof queryFindings>["rows"];
  total: number;
  groups: FingerprintGroupRow[];
  query: Record<string, unknown>;
}

function renderFindings(a: FindingsPageArgs): string {
  const limit = Math.min(Math.max(a.filters.limit ?? 100, 1), 500);
  const offset = Math.max(a.filters.offset ?? 0, 0);

  const selectOpt = (val: string, label: string, current?: string) =>
    `<option value="${esc(val)}"${val === (current ?? "") ? " selected" : ""}>${esc(label)}</option>`;

  const ageStr = a.filters.ageDays ? String(a.filters.ageDays) : "";

  const filterForm = `
    <form method="get" class="bg-white border border-slate-200 rounded-lg p-4 grid grid-cols-1 md:grid-cols-6 gap-3 text-sm">
      <label class="flex flex-col text-xs text-slate-500">Severity
        <select name="severity" class="mt-1 border border-slate-300 rounded px-2 py-1 text-sm text-slate-900">
          ${selectOpt("", "any", a.filters.severity)}
          ${selectOpt("critical", "critical", a.filters.severity)}
          ${selectOpt("major", "major", a.filters.severity)}
          ${selectOpt("minor", "minor", a.filters.severity)}
          ${selectOpt("nit", "nit", a.filters.severity)}
        </select>
      </label>
      <label class="flex flex-col text-xs text-slate-500">Source
        <select name="source" class="mt-1 border border-slate-300 rounded px-2 py-1 text-sm text-slate-900">
          ${selectOpt("", "any", a.filters.source)}
          ${selectOpt("ai", "ai", a.filters.source)}
          ${selectOpt("safety", "safety", a.filters.source)}
          ${selectOpt("builtin", "builtin", a.filters.source)}
          ${selectOpt("custom", "custom", a.filters.source)}
        </select>
      </label>
      <label class="flex flex-col text-xs text-slate-500">Repo
        <input name="repo" value="${esc(a.filters.repo ?? "")}" placeholder="owner/repo" class="mt-1 border border-slate-300 rounded px-2 py-1 text-sm text-slate-900" />
      </label>
      <label class="flex flex-col text-xs text-slate-500 md:col-span-2">Search title/path
        <input name="q" value="${esc(a.filters.q ?? "")}" placeholder="e.g. src/server" class="mt-1 border border-slate-300 rounded px-2 py-1 text-sm text-slate-900" />
      </label>
      <label class="flex flex-col text-xs text-slate-500">Age
        <select name="age" class="mt-1 border border-slate-300 rounded px-2 py-1 text-sm text-slate-900">
          ${selectOpt("", "any", ageStr)}
          ${selectOpt("7", "7 days", ageStr)}
          ${selectOpt("30", "30 days", ageStr)}
          ${selectOpt("90", "90 days", ageStr)}
        </select>
      </label>
      <input type="hidden" name="limit" value="${esc(String(limit))}" />
      <div class="md:col-span-6 flex items-center justify-end gap-2">
        <a href="/dashboard/findings" class="text-xs text-slate-500 hover:underline">clear</a>
        <button type="submit" class="bg-slate-900 text-white text-xs px-3 py-1.5 rounded hover:bg-slate-700">Apply</button>
      </div>
    </form>`;

  const fingerprintClause = a.filters.fingerprint
    ? `<div class="bg-amber-50 border border-amber-200 rounded px-3 py-2 text-xs text-amber-800">
         Filtering by fingerprint <span class="font-mono">${esc(a.filters.fingerprint)}</span>
         — <a href="/dashboard/findings${queryStringFromFilters(a.filters, { fingerprint: undefined })}" class="underline">remove</a>
       </div>`
    : "";

  const groupsHtml = a.groups.length === 0
    ? ""
    : `<section class="bg-white border border-slate-200 rounded-lg overflow-hidden">
         <h2 class="text-sm font-semibold text-slate-700 px-4 py-3 border-b border-slate-200">Recurring fingerprints</h2>
         <table class="min-w-full text-sm">
           <thead class="bg-slate-50 text-slate-500">
             <tr>
               <th class="text-left px-4 py-2">Fingerprint</th>
               <th class="text-left px-4 py-2">Title</th>
               <th class="text-left px-4 py-2">Severity</th>
               <th class="text-right px-4 py-2">Occurrences</th>
               <th class="text-right px-4 py-2">Repos</th>
               <th class="text-right px-4 py-2">Last seen</th>
             </tr>
           </thead>
           <tbody class="divide-y divide-slate-100">
             ${a.groups
               .map((g) => {
                 const href = `/dashboard/findings${queryStringFromFilters(a.filters, { fingerprint: g.fingerprint })}`;
                 return `<tr class="hover:bg-slate-50">
                   <td class="px-4 py-2 font-mono text-xs"><a class="text-blue-600 hover:underline" href="${esc(href)}">${esc(g.fingerprint)}</a></td>
                   <td class="px-4 py-2 truncate max-w-md">${esc(g.title ?? "—")}</td>
                   <td class="px-4 py-2">${severityBadge(g.severity)}</td>
                   <td class="px-4 py-2 text-right tabular-nums">${g.occurrences}</td>
                   <td class="px-4 py-2 text-right tabular-nums">${g.repos}</td>
                   <td class="px-4 py-2 text-right text-slate-500">${esc(relativeTime(g.last_seen))}</td>
                 </tr>`;
               })
               .join("")}
           </tbody>
         </table>
       </section>`;

  const tableHtml = a.rows.length === 0
    ? `<div class="bg-white border border-slate-200 rounded-lg p-8 text-center text-slate-500">No findings match these filters.</div>`
    : `<section class="bg-white border border-slate-200 rounded-lg overflow-hidden">
         <div class="px-4 py-2 border-b border-slate-200 text-xs text-slate-500 flex items-center justify-between">
           <span>${a.rows.length} shown · ${a.total} total</span>
         </div>
         <table class="min-w-full text-sm">
           <thead class="bg-slate-50 text-slate-500">
             <tr>
               <th class="text-left px-4 py-2">When</th>
               <th class="text-left px-4 py-2">Repo</th>
               <th class="text-left px-4 py-2">PR</th>
               <th class="text-left px-4 py-2">Severity</th>
               <th class="text-left px-4 py-2">Location</th>
               <th class="text-left px-4 py-2">Title</th>
               <th class="text-left px-4 py-2">Source</th>
             </tr>
           </thead>
           <tbody class="divide-y divide-slate-100">
             ${a.rows
               .map((r) => {
                 const prHref = `/dashboard/repo/${encodeURIComponent(r.owner)}/${encodeURIComponent(r.repo)}/pr/${r.number}`;
                 const repoHref = `/dashboard/repo/${encodeURIComponent(r.owner)}/${encodeURIComponent(r.repo)}`;
                 return `<tr class="hover:bg-slate-50">
                   <td class="px-4 py-2 text-xs text-slate-500 whitespace-nowrap">${esc(relativeTime(r.created_at))}</td>
                   <td class="px-4 py-2"><a class="text-slate-700 hover:underline" href="${esc(repoHref)}">${esc(r.owner)}/${esc(r.repo)}</a></td>
                   <td class="px-4 py-2"><a class="text-blue-600 hover:underline" href="${esc(prHref)}">#${r.number}</a></td>
                   <td class="px-4 py-2">${severityBadge(r.severity)}</td>
                   <td class="px-4 py-2 font-mono text-xs truncate max-w-xs">${esc(r.path ?? "")}${r.line ? `:${r.line}` : ""}</td>
                   <td class="px-4 py-2 truncate max-w-md">${esc(r.title ?? "—")}</td>
                   <td class="px-4 py-2 text-xs text-slate-500">${esc(r.source ?? "—")}</td>
                 </tr>`;
               })
               .join("")}
           </tbody>
         </table>
       </section>`;

  const prev = offset > 0
    ? `<a href="/dashboard/findings${queryStringFromFilters(a.filters, { offset: Math.max(0, offset - limit) })}" class="text-xs text-blue-600 hover:underline">← prev</a>`
    : `<span class="text-xs text-slate-400">← prev</span>`;
  const next = offset + limit < a.total
    ? `<a href="/dashboard/findings${queryStringFromFilters(a.filters, { offset: offset + limit })}" class="text-xs text-blue-600 hover:underline">next →</a>`
    : `<span class="text-xs text-slate-400">next →</span>`;
  const pager = a.total > limit
    ? `<div class="flex items-center justify-between text-xs text-slate-500 mt-2">
         <div>${prev}</div>
         <div>rows ${offset + 1}–${Math.min(a.total, offset + a.rows.length)} of ${a.total}</div>
         <div>${next}</div>
       </div>`
    : "";

  const body = `
    <h1 class="text-xl font-semibold mb-4">Findings</h1>
    <div class="grid grid-cols-1 gap-4">
      ${filterForm}
      ${fingerprintClause}
      ${groupsHtml}
      ${tableHtml}
      ${pager}
    </div>
  `;

  return renderLayout({
    title: "Findings",
    crumbs: [{ label: "Repos", href: "/dashboard" }, { label: "Findings" }],
    body,
  });
}

// ─── Patterns ─────────────────────────────────────────────────────

function renderPatterns(rules: PatternRuleRow[]): string {
  const body = rules.length === 0
    ? `<div class="bg-white border border-slate-200 rounded-lg p-8 text-center text-slate-500">No pattern-rule hits recorded yet.</div>`
    : `<section class="bg-white border border-slate-200 rounded-lg overflow-hidden">
         <table class="min-w-full text-sm">
           <thead class="bg-slate-50 text-slate-500">
             <tr>
               <th class="text-left px-4 py-2">Rule</th>
               <th class="text-left px-4 py-2">Source</th>
               <th class="text-left px-4 py-2">Repo</th>
               <th class="text-right px-4 py-2">Hits · 30d</th>
               <th class="text-right px-4 py-2">Hits · all time</th>
               <th class="text-right px-4 py-2">Last hit</th>
             </tr>
           </thead>
           <tbody class="divide-y divide-slate-100">
             ${rules
               .map((r) => {
                 const repoHref = `/dashboard/repo/${encodeURIComponent(r.owner)}/${encodeURIComponent(r.repo)}`;
                 return `<tr class="hover:bg-slate-50">
                   <td class="px-4 py-2 font-mono text-xs">${esc(r.rule_name)}</td>
                   <td class="px-4 py-2 text-xs text-slate-500">${esc(r.source)}</td>
                   <td class="px-4 py-2"><a class="text-slate-700 hover:underline" href="${esc(repoHref)}">${esc(r.owner)}/${esc(r.repo)}</a></td>
                   <td class="px-4 py-2 text-right tabular-nums ${r.hits_30d > 0 ? "text-slate-900 font-medium" : "text-slate-400"}">${r.hits_30d}</td>
                   <td class="px-4 py-2 text-right tabular-nums text-slate-500">${r.hits_total}</td>
                   <td class="px-4 py-2 text-right text-xs text-slate-500">${esc(relativeTime(r.last_hit))}</td>
                 </tr>`;
               })
               .join("")}
           </tbody>
         </table>
       </section>`;
  return renderLayout({
    title: "Patterns",
    crumbs: [{ label: "Repos", href: "/dashboard" }, { label: "Patterns" }],
    body: `<h1 class="text-xl font-semibold mb-4">Pattern rules</h1>
           <p class="text-sm text-slate-500 mb-4">Noisy rules are candidates for disabling in <span class="font-mono">.diffsentry.yaml</span>.</p>
           ${body}`,
  });
}

// ─── Settings / health ────────────────────────────────────────────

function bytesHuman(n: number | null): string {
  if (n === null) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

function renderSettings(c: HealthCounts): string {
  const providerCard = `
    <section class="bg-white border border-slate-200 rounded-lg p-4">
      <h2 class="text-sm font-semibold text-slate-700 mb-3">Runtime</h2>
      <dl class="grid grid-cols-2 md:grid-cols-3 gap-3 text-sm">
        <div><dt class="text-slate-500 text-xs">AI provider</dt><dd>${esc(process.env.AI_PROVIDER ?? "anthropic")}</dd></div>
        <div><dt class="text-slate-500 text-xs">Node</dt><dd>${esc(process.version)}</dd></div>
        <div><dt class="text-slate-500 text-xs">Port</dt><dd>${esc(process.env.PORT ?? "3005")}</dd></div>
        <div><dt class="text-slate-500 text-xs">Log level</dt><dd>${esc(process.env.LOG_LEVEL ?? "info")}</dd></div>
        <div><dt class="text-slate-500 text-xs">Bot name</dt><dd>${esc(process.env.BOT_NAME ?? "diffsentry")}</dd></div>
        <div><dt class="text-slate-500 text-xs">DB path</dt><dd class="font-mono text-xs">${esc(process.env.DB_PATH ?? "./data/diffsentry.db")}</dd></div>
      </dl>
    </section>`;

  const dbCard = `
    <section class="bg-white border border-slate-200 rounded-lg p-4">
      <h2 class="text-sm font-semibold text-slate-700 mb-3">Storage</h2>
      <dl class="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
        <div><dt class="text-slate-500 text-xs">Repos</dt><dd class="tabular-nums">${c.repos}</dd></div>
        <div><dt class="text-slate-500 text-xs">PRs</dt><dd class="tabular-nums">${c.prs}</dd></div>
        <div><dt class="text-slate-500 text-xs">Reviews</dt><dd class="tabular-nums">${c.reviews}</dd></div>
        <div><dt class="text-slate-500 text-xs">Findings</dt><dd class="tabular-nums">${c.findings}</dd></div>
        <div><dt class="text-slate-500 text-xs">Pattern hits</dt><dd class="tabular-nums">${c.pattern_hits}</dd></div>
        <div><dt class="text-slate-500 text-xs">Events</dt><dd class="tabular-nums">${c.events}</dd></div>
        <div><dt class="text-slate-500 text-xs">DB size</dt><dd>${esc(bytesHuman(c.db_bytes))}</dd></div>
        <div><dt class="text-slate-500 text-xs">Review span</dt><dd class="text-xs text-slate-500">${esc(c.oldest_review?.slice(0, 10) ?? "—")} → ${esc(c.newest_review?.slice(0, 10) ?? "—")}</dd></div>
      </dl>
    </section>`;

  const note = `
    <section class="bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm text-amber-900">
      <div class="font-semibold mb-1">Operator-only surface</div>
      <div>This dashboard is gated behind <span class="font-mono">ENABLE_DASHBOARD=1</span>. OAuth gating lands in PRD step 6 — until then, do not expose this server to the internet.</div>
    </section>`;

  return renderLayout({
    title: "Settings",
    crumbs: [{ label: "Repos", href: "/dashboard" }, { label: "Settings" }],
    body: `<h1 class="text-xl font-semibold mb-4">Settings</h1>
           <div class="grid grid-cols-1 gap-4">${note}${providerCard}${dbCard}</div>`,
  });
}
