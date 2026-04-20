import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { getRecentLogs, logger, type LogEntry } from "../logger.js";
import type { Learning } from "../types.js";
import { esc, relativeTime, renderLayout, riskBadge, runWithRequestContext, severityBadge } from "./layout.js";
import { getCurrentUser } from "./auth.js";
import {
  getEvents,
  getFindings,
  getHealthCounts,
  getHotPaths,
  getInstallationId,
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

export interface DashboardDeps {
  learningsDir: string;
  /** Returns an octokit scoped to the given installation. Optional — config viewer disabled when null. */
  getInstallationOctokit?: (installationId: number) => Promise<import("@octokit/rest").Octokit>;
  /** Optional OAuth runtime — when present, all non-/auth routes require a session. */
  auth?: import("./auth.js").AuthRuntime | null;
}

export function createDashboardRouter(deps: DashboardDeps): express.Router {
  const router = express.Router();
  if (deps.auth) {
    deps.auth.routes(router);
    router.use(deps.auth.middleware);
  }

  // Bind request context (current user) for the duration of each request so
  // renderLayout can surface it in the header without threading through every
  // render function.
  router.use((req, _res, next) => {
    const user = getCurrentUser(req);
    runWithRequestContext({ user: user ? { login: user.login } : null }, next);
  });

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

  router.get("/repo/:owner/:repo", async (req, res) => {
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
      const learnings = await loadLearningsSafe(deps.learningsDir, owner, repo);
      const configYaml = await loadRepoConfigSafe(deps, owner, repo);
      res.type("html").send(
        renderRepoDetail({ owner, repo, sparkline, hotPaths, topRules, reviews, learnings, configYaml }),
      );
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
      const logs = getRecentLogs(100);
      res.type("html").send(renderSettings(counts, logs));
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
  const cls = active ? "text-white font-semibold" : "text-surface-400 hover:text-white";
  const arrow = active ? ' <span class="text-surface-500">↓</span>' : "";
  return `<a href="/dashboard?sort=${esc(key)}" class="${cls}">${esc(label)}${arrow}</a>`;
}

function renderReposOverview(rows: RepoOverviewRow[], sort: string): string {
  const body = rows.length === 0
    ? `<div class="bg-surface-900/40 border border-surface-800/50 rounded-2xl card-glow p-8 text-center text-surface-400">
         No repos recorded yet. Open a PR in an installed repo to populate the database.
       </div>`
    : `<div class="bg-surface-900/40 border border-surface-800/50 rounded-2xl card-glow overflow-hidden">
         <table class="min-w-full text-sm">
           <thead class="bg-surface-900/60 border-b border-surface-800/50">
             <tr>
               <th class="text-left px-4 py-2">${sortHeader("Repo", "repo", sort)}</th>
               <th class="text-right px-4 py-2">${sortHeader("PRs reviewed", "prs_reviewed", sort)}</th>
               <th class="text-right px-4 py-2">${sortHeader("Findings · 7d", "findings_7d", sort)}</th>
               <th class="text-right px-4 py-2">${sortHeader("Critical · 7d", "critical_7d", sort)}</th>
               <th class="text-right px-4 py-2">${sortHeader("Last review", "last_review", sort)}</th>
             </tr>
           </thead>
           <tbody class="divide-y divide-surface-800/40">
             ${rows
               .map((r) => {
                 const href = `/dashboard/repo/${encodeURIComponent(r.owner)}/${encodeURIComponent(r.repo)}`;
                 const critCls = r.critical_7d > 0 ? "text-red-300 font-semibold" : "text-surface-400";
                 return `<tr class="hover:bg-surface-800/40">
                   <td class="px-4 py-2"><a href="${esc(href)}" class="text-white hover:underline">${esc(r.owner)}/${esc(r.repo)}</a></td>
                   <td class="px-4 py-2 text-right tabular-nums">${r.prs_reviewed}</td>
                   <td class="px-4 py-2 text-right tabular-nums">${r.findings_7d}</td>
                   <td class="px-4 py-2 text-right tabular-nums ${critCls}">${r.critical_7d}</td>
                   <td class="px-4 py-2 text-right text-surface-400">${esc(relativeTime(r.last_review))}</td>
                 </tr>`;
               })
               .join("")}
           </tbody>
         </table>
       </div>`;
  return renderLayout({
    title: "Repos",
    crumbs: [{ label: "Repos" }],
    body: `<div class="mb-6">
             <span class="eyebrow">Overview</span>
             <h1 class="text-2xl md:text-3xl font-bold text-white mt-2">Repos</h1>
             <p class="text-sm text-surface-400 mt-1">Every repo the bot has reviewed, with rolling 7-day activity stats.</p>
           </div>${body}`,
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
  learnings: Learning[];
  configYaml: string | null;
}

async function loadLearningsSafe(baseDir: string, owner: string, repo: string): Promise<Learning[]> {
  try {
    const fp = path.join(baseDir, owner, `${repo}.json`);
    const raw = await fs.readFile(fp, "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as Learning[];
  } catch {
    return [];
  }
}

const configCache = new Map<string, { yaml: string | null; ts: number }>();
const CONFIG_TTL_MS = 5 * 60 * 1000;

async function loadRepoConfigSafe(deps: DashboardDeps, owner: string, repo: string): Promise<string | null> {
  const key = `${owner}/${repo}`;
  const now = Date.now();
  const cached = configCache.get(key);
  if (cached && now - cached.ts < CONFIG_TTL_MS) return cached.yaml;
  if (!deps.getInstallationOctokit) return null;
  const id = getInstallationId(owner, repo);
  if (id == null) return null;
  try {
    const octokit = await deps.getInstallationOctokit(id);
    const { data } = await octokit.repos.getContent({ owner, repo, path: ".diffsentry.yaml" });
    if (Array.isArray(data) || data.type !== "file" || !data.content) {
      configCache.set(key, { yaml: null, ts: now });
      return null;
    }
    const content = Buffer.from(data.content, "base64").toString("utf-8");
    configCache.set(key, { yaml: content, ts: now });
    return content;
  } catch (err) {
    logger.debug({ err, owner, repo }, "dashboard: failed to fetch .diffsentry.yaml");
    configCache.set(key, { yaml: null, ts: now });
    return null;
  }
}

function renderSparkline(points: SparklinePoint[]): string {
  if (points.length < 2) {
    return `<div class="text-surface-500 text-sm">Not enough reviews yet for a 90-day chart.</div>`;
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
    <polyline points="${polyline}" fill="none" stroke="#59b0ff" stroke-width="1.2" />
    ${dots}
  </svg>`;
}

function renderRepoDetail(a: RepoDetailArgs): string {
  const title = `${a.owner}/${a.repo}`;
  const sparklineHtml = renderSparkline(a.sparkline);
  const hotPathsHtml = a.hotPaths.length === 0
    ? `<div class="text-surface-500 text-sm">No critical or major findings in the last 90 days.</div>`
    : `<table class="w-full text-sm">
         <thead class="text-surface-400">
           <tr>
             <th class="text-left py-1">Path</th>
             <th class="text-right py-1">Critical</th>
             <th class="text-right py-1">Major</th>
             <th class="text-right py-1">Total</th>
           </tr>
         </thead>
         <tbody class="divide-y divide-surface-800/40">
           ${a.hotPaths
             .map(
               (p) => `<tr>
                 <td class="py-1 font-mono text-xs truncate max-w-md">${esc(p.path)}</td>
                 <td class="py-1 text-right tabular-nums ${p.critical > 0 ? "text-red-300 font-semibold" : ""}">${p.critical}</td>
                 <td class="py-1 text-right tabular-nums">${p.major}</td>
                 <td class="py-1 text-right tabular-nums text-surface-400">${p.total}</td>
               </tr>`,
             )
             .join("")}
         </tbody>
       </table>`;
  const topRulesHtml = a.topRules.length === 0
    ? `<div class="text-surface-500 text-sm">No pattern-rule hits recorded.</div>`
    : `<table class="w-full text-sm">
         <thead class="text-surface-400">
           <tr>
             <th class="text-left py-1">Rule</th>
             <th class="text-left py-1">Source</th>
             <th class="text-right py-1">Hits</th>
             <th class="text-right py-1">Example</th>
           </tr>
         </thead>
         <tbody class="divide-y divide-surface-800/40">
           ${a.topRules
             .map(
               (r) => `<tr>
                 <td class="py-1 font-mono text-xs">${esc(r.rule_name)}</td>
                 <td class="py-1 text-xs text-surface-400">${esc(r.source)}</td>
                 <td class="py-1 text-right tabular-nums">${r.hits}</td>
                 <td class="py-1 text-right">${
                   r.example_pr
                     ? `<a class="text-brand-400 hover:text-brand-300 transition-colors" href="/dashboard/repo/${encodeURIComponent(a.owner)}/${encodeURIComponent(a.repo)}/pr/${r.example_pr}">#${r.example_pr}</a>`
                     : `<span class="text-surface-500">—</span>`
                 }</td>
               </tr>`,
             )
             .join("")}
         </tbody>
       </table>`;
  const reviewsHtml = a.reviews.length === 0
    ? `<div class="text-surface-500 text-sm">No reviews recorded yet.</div>`
    : `<table class="min-w-full text-sm">
         <thead class="bg-surface-900/60 border-b border-surface-800/50 text-surface-400">
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
         <tbody class="divide-y divide-surface-800/40">
           ${a.reviews
             .map((rv) => {
               const href = `/dashboard/repo/${encodeURIComponent(a.owner)}/${encodeURIComponent(a.repo)}/pr/${rv.number}`;
               return `<tr class="hover:bg-surface-800/40">
                 <td class="px-4 py-2"><a href="${esc(href)}" class="text-brand-400 hover:text-brand-300 transition-colors">#${rv.number}</a></td>
                 <td class="px-4 py-2 truncate max-w-md">${esc(rv.title ?? "—")}</td>
                 <td class="px-4 py-2 text-surface-400">${esc(rv.author ?? "—")}</td>
                 <td class="px-4 py-2">${riskBadge(rv.risk_level, rv.risk_score)}</td>
                 <td class="px-4 py-2 text-right tabular-nums">${rv.finding_count}</td>
                 <td class="px-4 py-2 text-xs text-surface-400">${esc(rv.approval ?? "—")}</td>
                 <td class="px-4 py-2 text-right text-surface-400">${esc(relativeTime(rv.created_at))}</td>
               </tr>`;
             })
             .join("")}
         </tbody>
       </table>`;

  const body = `
    <div class="flex items-end justify-between mb-6 gap-4">
      <div>
        <span class="eyebrow">Repo detail</span>
        <h1 class="text-2xl md:text-3xl font-bold text-white mt-2 font-mono tracking-tight">${esc(title)}</h1>
      </div>
      <a href="https://github.com/${esc(a.owner)}/${esc(a.repo)}" class="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-surface-800/60 hover:bg-surface-700/60 border border-surface-700/60 text-xs text-white transition-all" target="_blank" rel="noopener">
        <svg class="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24"><path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/></svg>
        View on GitHub
      </a>
    </div>
    <div class="grid grid-cols-1 gap-6">
      <section class="bg-surface-900/40 border border-surface-800/50 rounded-2xl card-glow p-4">
        <h2 class="text-sm font-semibold text-surface-200 mb-2">Risk — last 90 days</h2>
        ${sparklineHtml}
      </section>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
        <section class="bg-surface-900/40 border border-surface-800/50 rounded-2xl card-glow p-4">
          <h2 class="text-sm font-semibold text-surface-200 mb-3">Hot paths</h2>
          ${hotPathsHtml}
        </section>
        <section class="bg-surface-900/40 border border-surface-800/50 rounded-2xl card-glow p-4">
          <h2 class="text-sm font-semibold text-surface-200 mb-3">Top firing rules</h2>
          ${topRulesHtml}
        </section>
      </div>
      <section class="bg-surface-900/40 border border-surface-800/50 rounded-2xl card-glow overflow-hidden">
        <h2 class="text-sm font-semibold text-surface-200 px-4 py-3 border-b border-surface-800/50">Recent reviews</h2>
        ${reviewsHtml}
      </section>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
        ${renderLearningsCard(a.learnings)}
        ${renderConfigCard(a.configYaml)}
      </div>
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

function renderLearningsCard(learnings: Learning[]): string {
  const body = learnings.length === 0
    ? `<div class="text-surface-500 text-sm">No learnings recorded for this repo. Use <span class="font-mono">@bot learn …</span> on a PR to add one.</div>`
    : `<ul class="divide-y divide-surface-800/40 text-sm max-h-80 overflow-auto">
         ${learnings
           .map(
             (l) => `<li class="py-2 flex items-start gap-3">
               <span class="text-xs text-surface-500 whitespace-nowrap">${esc(relativeTime(l.createdAt))}</span>
               <div class="flex-1 min-w-0">
                 ${l.path ? `<div class="text-xs font-mono text-surface-400 truncate">${esc(l.path)}</div>` : ""}
                 <div class="text-surface-200 break-words">${esc(l.content)}</div>
               </div>
             </li>`,
           )
           .join("")}
       </ul>`;
  return `<section class="bg-surface-900/40 border border-surface-800/50 rounded-2xl card-glow p-4">
    <h2 class="text-sm font-semibold text-surface-200 mb-3">Learnings (${learnings.length})</h2>
    ${body}
  </section>`;
}

function renderConfigCard(yaml: string | null): string {
  if (yaml === null) {
    return `<section class="bg-surface-900/40 border border-surface-800/50 rounded-2xl card-glow p-4">
      <h2 class="text-sm font-semibold text-surface-200 mb-3">.diffsentry.yaml</h2>
      <div class="text-surface-500 text-sm">No config file in this repo (defaults in use) — or the dashboard could not reach the GitHub API.</div>
    </section>`;
  }
  return `<section class="bg-surface-900/40 border border-surface-800/50 rounded-2xl card-glow p-4">
    <h2 class="text-sm font-semibold text-surface-200 mb-3">.diffsentry.yaml</h2>
    <pre class="text-xs font-mono text-brand-200 bg-surface-950/60 border border-surface-800/50 rounded-lg p-3 max-h-80 overflow-auto whitespace-pre">${esc(yaml)}</pre>
  </section>`;
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
    <div class="flex items-start justify-between mb-6 gap-4">
      <div>
        <span class="eyebrow">Pull request #${a.number}</span>
        <h1 class="text-2xl md:text-3xl font-bold text-white mt-2 leading-tight">${esc(a.pr?.title ?? `PR #${a.number}`)}</h1>
        <div class="text-sm text-surface-400 mt-2">
          <span class="font-mono text-surface-300">${esc(a.owner)}/${esc(a.repo)}</span>
          ${a.pr?.author ? ` · by <span class="text-brand-300">@${esc(a.pr.author)}</span>` : ""}
          ${a.pr?.state ? ` · <span class="font-mono text-surface-400">${esc(a.pr.state)}</span>` : ""}
        </div>
      </div>
      <a href="${esc(ghUrl)}" target="_blank" rel="noopener" class="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-surface-800/60 hover:bg-surface-700/60 border border-surface-700/60 text-xs text-white transition-all whitespace-nowrap">
        <svg class="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24"><path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/></svg>
        View on GitHub
      </a>
    </div>`;

  const latestHtml = a.latest
    ? `<section class="bg-surface-900/40 border border-surface-800/50 rounded-2xl card-glow p-4">
         <div class="flex items-center justify-between mb-3">
           <h2 class="text-sm font-semibold text-surface-200">Latest review</h2>
           <div class="flex items-center gap-2 text-xs text-surface-400">
             ${riskBadge(a.latest.risk_level, a.latest.risk_score)}
             <span class="font-mono">${esc((a.latest.sha ?? "").slice(0, 7))}</span>
             <span>${esc(relativeTime(a.latest.created_at))}</span>
           </div>
         </div>
         <dl class="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
           <div><dt class="text-surface-400 text-xs">Profile</dt><dd>${esc(a.latest.profile ?? "—")}</dd></div>
           <div><dt class="text-surface-400 text-xs">Approval</dt><dd>${esc(a.latest.approval ?? "—")}</dd></div>
           <div><dt class="text-surface-400 text-xs">Files processed</dt><dd class="tabular-nums">${a.latest.files_processed ?? 0}</dd></div>
           <div><dt class="text-surface-400 text-xs">Findings</dt><dd class="tabular-nums">${a.latest.finding_count}</dd></div>
         </dl>
         ${
           a.latest.summary
             ? `<div class="mt-3 pt-3 border-t border-surface-800/40">
                  <div class="text-xs text-surface-400 mb-1">Summary</div>
                  <pre class="text-xs whitespace-pre-wrap font-sans text-surface-200 max-h-64 overflow-auto">${esc(a.latest.summary)}</pre>
                </div>`
             : ""
         }
       </section>`
    : `<div class="bg-surface-900/40 border border-surface-800/50 rounded-2xl card-glow p-4 text-surface-500 text-sm">No reviews recorded for this PR.</div>`;

  const findingsHtml = a.findings.length === 0
    ? `<div class="text-surface-500 text-sm px-4 py-3">No findings in the latest review.</div>`
    : `<table class="min-w-full text-sm">
         <thead class="bg-surface-900/60 border-b border-surface-800/50 text-surface-400">
           <tr>
             <th class="text-left px-4 py-2">Severity</th>
             <th class="text-left px-4 py-2">Location</th>
             <th class="text-left px-4 py-2">Title</th>
             <th class="text-left px-4 py-2">Source</th>
           </tr>
         </thead>
         <tbody class="divide-y divide-surface-800/40">
           ${a.findings
             .map(
               (f) => `<tr>
                 <td class="px-4 py-2 align-top">${severityBadge(f.severity)}</td>
                 <td class="px-4 py-2 align-top font-mono text-xs">${esc(f.path ?? "")}${f.line ? `:${f.line}` : ""}</td>
                 <td class="px-4 py-2 align-top">
                   <div class="font-medium">${esc(f.title ?? "—")}</div>
                   ${f.body ? `<details class="mt-1"><summary class="text-xs text-surface-400 cursor-pointer">body</summary><pre class="text-xs whitespace-pre-wrap font-sans text-surface-300 mt-1">${esc(f.body.slice(0, 4000))}</pre></details>` : ""}
                 </td>
                 <td class="px-4 py-2 align-top text-xs text-surface-400">${esc(f.source ?? "—")}</td>
               </tr>`,
             )
             .join("")}
         </tbody>
       </table>`;

  const reviewsList = a.reviews.length <= 1
    ? ""
    : `<section class="bg-surface-900/40 border border-surface-800/50 rounded-2xl card-glow overflow-hidden">
         <h2 class="text-sm font-semibold text-surface-200 px-4 py-3 border-b border-surface-800/50">All reviews (${a.reviews.length})</h2>
         <table class="min-w-full text-sm">
           <thead class="bg-surface-900/60 border-b border-surface-800/50 text-surface-400">
             <tr>
               <th class="text-left px-4 py-2">When</th>
               <th class="text-left px-4 py-2">SHA</th>
               <th class="text-left px-4 py-2">Profile</th>
               <th class="text-left px-4 py-2">Risk</th>
               <th class="text-right px-4 py-2">Findings</th>
               <th class="text-left px-4 py-2">Approval</th>
             </tr>
           </thead>
           <tbody class="divide-y divide-surface-800/40">
             ${a.reviews
               .map(
                 (rv) => `<tr>
                   <td class="px-4 py-2 text-surface-400">${esc(relativeTime(rv.created_at))}</td>
                   <td class="px-4 py-2 font-mono text-xs">${esc((rv.sha ?? "").slice(0, 7))}</td>
                   <td class="px-4 py-2 text-xs">${esc(rv.profile ?? "—")}</td>
                   <td class="px-4 py-2">${riskBadge(rv.risk_level, rv.risk_score)}</td>
                   <td class="px-4 py-2 text-right tabular-nums">${rv.finding_count}</td>
                   <td class="px-4 py-2 text-xs text-surface-400">${esc(rv.approval ?? "—")}</td>
                 </tr>`,
               )
               .join("")}
           </tbody>
         </table>
       </section>`;

  const eventsHtml = a.events.length === 0
    ? `<div class="text-surface-500 text-sm px-4 py-3">No events.</div>`
    : `<ul class="divide-y divide-surface-800/40">
         ${a.events
           .map(
             (ev) => `<li class="px-4 py-2 flex items-center justify-between text-sm">
               <span class="font-mono text-xs text-surface-200">${esc(ev.kind)}</span>
               <span class="text-xs text-surface-400">${esc(relativeTime(ev.ts))}</span>
             </li>`,
           )
           .join("")}
       </ul>`;

  const body = `
    ${prHeader}
    <div class="grid grid-cols-1 gap-6">
      ${latestHtml}
      <section class="bg-surface-900/40 border border-surface-800/50 rounded-2xl card-glow overflow-hidden">
        <h2 class="text-sm font-semibold text-surface-200 px-4 py-3 border-b border-surface-800/50">Findings</h2>
        ${findingsHtml}
      </section>
      ${reviewsList}
      <section class="bg-surface-900/40 border border-surface-800/50 rounded-2xl card-glow overflow-hidden">
        <h2 class="text-sm font-semibold text-surface-200 px-4 py-3 border-b border-surface-800/50">Events</h2>
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
    body: `<div class="bg-surface-900/40 border border-surface-800/50 rounded-2xl card-glow p-8 text-center">
      <div class="text-surface-400 text-sm mb-2">404</div>
      <div class="text-surface-200">${esc(msg)}</div>
      <a href="/dashboard" class="inline-block mt-4 text-sm text-brand-400 hover:text-brand-300 transition-colors">← Back to repos</a>
    </div>`,
  });
}

function renderError(msg: string): string {
  return renderLayout({
    title: "Error",
    body: `<div class="bg-surface-900/40 border border-red-500/30 rounded-2xl p-6">
      <div class="text-red-300 text-sm font-semibold">${esc(msg)}</div>
      <div class="text-surface-400 text-xs mt-1">Check server logs for details.</div>
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
    <form method="get" class="bg-surface-900/40 border border-surface-800/50 rounded-2xl card-glow p-4 grid grid-cols-1 md:grid-cols-6 gap-3 text-sm">
      <label class="flex flex-col text-xs text-surface-400">Severity
        <select name="severity" class="mt-1 border border-surface-700 rounded px-2 py-1 text-sm text-white">
          ${selectOpt("", "any", a.filters.severity)}
          ${selectOpt("critical", "critical", a.filters.severity)}
          ${selectOpt("major", "major", a.filters.severity)}
          ${selectOpt("minor", "minor", a.filters.severity)}
          ${selectOpt("nit", "nit", a.filters.severity)}
        </select>
      </label>
      <label class="flex flex-col text-xs text-surface-400">Source
        <select name="source" class="mt-1 border border-surface-700 rounded px-2 py-1 text-sm text-white">
          ${selectOpt("", "any", a.filters.source)}
          ${selectOpt("ai", "ai", a.filters.source)}
          ${selectOpt("safety", "safety", a.filters.source)}
          ${selectOpt("builtin", "builtin", a.filters.source)}
          ${selectOpt("custom", "custom", a.filters.source)}
        </select>
      </label>
      <label class="flex flex-col text-xs text-surface-400">Repo
        <input name="repo" value="${esc(a.filters.repo ?? "")}" placeholder="owner/repo" class="mt-1 border border-surface-700 rounded px-2 py-1 text-sm text-white" />
      </label>
      <label class="flex flex-col text-xs text-surface-400 md:col-span-2">Search title/path
        <input name="q" value="${esc(a.filters.q ?? "")}" placeholder="e.g. src/server" class="mt-1 border border-surface-700 rounded px-2 py-1 text-sm text-white" />
      </label>
      <label class="flex flex-col text-xs text-surface-400">Age
        <select name="age" class="mt-1 border border-surface-700 rounded px-2 py-1 text-sm text-white">
          ${selectOpt("", "any", ageStr)}
          ${selectOpt("7", "7 days", ageStr)}
          ${selectOpt("30", "30 days", ageStr)}
          ${selectOpt("90", "90 days", ageStr)}
        </select>
      </label>
      <input type="hidden" name="limit" value="${esc(String(limit))}" />
      <div class="md:col-span-6 flex items-center justify-end gap-2">
        <a href="/dashboard/findings" class="text-xs text-surface-400 hover:underline">clear</a>
        <button type="submit" class="bg-brand-600 hover:bg-brand-500 text-white text-xs px-4 py-1.5 rounded-lg font-medium transition-all hover:shadow-lg hover:shadow-brand-600/25">Apply</button>
      </div>
    </form>`;

  const fingerprintClause = a.filters.fingerprint
    ? `<div class="bg-brand-950/40 border border-brand-800/40 rounded-xl px-3 py-2 text-xs text-brand-300">
         Filtering by fingerprint <span class="font-mono text-brand-200">${esc(a.filters.fingerprint)}</span>
         — <a href="/dashboard/findings${queryStringFromFilters(a.filters, { fingerprint: undefined })}" class="underline hover:text-brand-100">remove</a>
       </div>`
    : "";

  const groupsHtml = a.groups.length === 0
    ? ""
    : `<section class="bg-surface-900/40 border border-surface-800/50 rounded-2xl card-glow overflow-hidden">
         <h2 class="text-sm font-semibold text-surface-200 px-4 py-3 border-b border-surface-800/50">Recurring fingerprints</h2>
         <table class="min-w-full text-sm">
           <thead class="bg-surface-900/60 text-surface-400">
             <tr>
               <th class="text-left px-4 py-2">Fingerprint</th>
               <th class="text-left px-4 py-2">Title</th>
               <th class="text-left px-4 py-2">Severity</th>
               <th class="text-right px-4 py-2">Occurrences</th>
               <th class="text-right px-4 py-2">Repos</th>
               <th class="text-right px-4 py-2">Last seen</th>
             </tr>
           </thead>
           <tbody class="divide-y divide-surface-800/40">
             ${a.groups
               .map((g) => {
                 const href = `/dashboard/findings${queryStringFromFilters(a.filters, { fingerprint: g.fingerprint })}`;
                 return `<tr class="hover:bg-surface-800/40">
                   <td class="px-4 py-2 font-mono text-xs"><a class="text-brand-400 hover:text-brand-300 transition-colors" href="${esc(href)}">${esc(g.fingerprint)}</a></td>
                   <td class="px-4 py-2 truncate max-w-md">${esc(g.title ?? "—")}</td>
                   <td class="px-4 py-2">${severityBadge(g.severity)}</td>
                   <td class="px-4 py-2 text-right tabular-nums">${g.occurrences}</td>
                   <td class="px-4 py-2 text-right tabular-nums">${g.repos}</td>
                   <td class="px-4 py-2 text-right text-surface-400">${esc(relativeTime(g.last_seen))}</td>
                 </tr>`;
               })
               .join("")}
           </tbody>
         </table>
       </section>`;

  const tableHtml = a.rows.length === 0
    ? `<div class="bg-surface-900/40 border border-surface-800/50 rounded-2xl card-glow p-8 text-center text-surface-400">No findings match these filters.</div>`
    : `<section class="bg-surface-900/40 border border-surface-800/50 rounded-2xl card-glow overflow-hidden">
         <div class="px-4 py-2 border-b border-surface-800/50 text-xs text-surface-400 flex items-center justify-between">
           <span>${a.rows.length} shown · ${a.total} total</span>
         </div>
         <table class="min-w-full text-sm">
           <thead class="bg-surface-900/60 text-surface-400">
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
           <tbody class="divide-y divide-surface-800/40">
             ${a.rows
               .map((r) => {
                 const prHref = `/dashboard/repo/${encodeURIComponent(r.owner)}/${encodeURIComponent(r.repo)}/pr/${r.number}`;
                 const repoHref = `/dashboard/repo/${encodeURIComponent(r.owner)}/${encodeURIComponent(r.repo)}`;
                 return `<tr class="hover:bg-surface-800/40">
                   <td class="px-4 py-2 text-xs text-surface-400 whitespace-nowrap">${esc(relativeTime(r.created_at))}</td>
                   <td class="px-4 py-2"><a class="text-surface-200 hover:underline" href="${esc(repoHref)}">${esc(r.owner)}/${esc(r.repo)}</a></td>
                   <td class="px-4 py-2"><a class="text-brand-400 hover:text-brand-300 transition-colors" href="${esc(prHref)}">#${r.number}</a></td>
                   <td class="px-4 py-2">${severityBadge(r.severity)}</td>
                   <td class="px-4 py-2 font-mono text-xs truncate max-w-xs">${esc(r.path ?? "")}${r.line ? `:${r.line}` : ""}</td>
                   <td class="px-4 py-2 truncate max-w-md">${esc(r.title ?? "—")}</td>
                   <td class="px-4 py-2 text-xs text-surface-400">${esc(r.source ?? "—")}</td>
                 </tr>`;
               })
               .join("")}
           </tbody>
         </table>
       </section>`;

  const prev = offset > 0
    ? `<a href="/dashboard/findings${queryStringFromFilters(a.filters, { offset: Math.max(0, offset - limit) })}" class="text-xs text-brand-400 hover:text-brand-300 transition-colors">← prev</a>`
    : `<span class="text-xs text-surface-500">← prev</span>`;
  const next = offset + limit < a.total
    ? `<a href="/dashboard/findings${queryStringFromFilters(a.filters, { offset: offset + limit })}" class="text-xs text-brand-400 hover:text-brand-300 transition-colors">next →</a>`
    : `<span class="text-xs text-surface-500">next →</span>`;
  const pager = a.total > limit
    ? `<div class="flex items-center justify-between text-xs text-surface-400 mt-2">
         <div>${prev}</div>
         <div>rows ${offset + 1}–${Math.min(a.total, offset + a.rows.length)} of ${a.total}</div>
         <div>${next}</div>
       </div>`
    : "";

  const body = `
    <div class="mb-6">
      <span class="eyebrow">Cross-repo explorer</span>
      <h1 class="text-2xl md:text-3xl font-bold text-white mt-2">Findings</h1>
      <p class="text-sm text-surface-400 mt-1">Filter across severities, sources, and repos. Grouped by fingerprint to spot repeat offenders.</p>
    </div>
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
    ? `<div class="bg-surface-900/40 border border-surface-800/50 rounded-2xl card-glow p-8 text-center text-surface-400">No pattern-rule hits recorded yet.</div>`
    : `<section class="bg-surface-900/40 border border-surface-800/50 rounded-2xl card-glow overflow-hidden">
         <table class="min-w-full text-sm">
           <thead class="bg-surface-900/60 text-surface-400">
             <tr>
               <th class="text-left px-4 py-2">Rule</th>
               <th class="text-left px-4 py-2">Source</th>
               <th class="text-left px-4 py-2">Repo</th>
               <th class="text-right px-4 py-2">Hits · 30d</th>
               <th class="text-right px-4 py-2">Hits · all time</th>
               <th class="text-right px-4 py-2">Last hit</th>
             </tr>
           </thead>
           <tbody class="divide-y divide-surface-800/40">
             ${rules
               .map((r) => {
                 const repoHref = `/dashboard/repo/${encodeURIComponent(r.owner)}/${encodeURIComponent(r.repo)}`;
                 return `<tr class="hover:bg-surface-800/40">
                   <td class="px-4 py-2 font-mono text-xs">${esc(r.rule_name)}</td>
                   <td class="px-4 py-2 text-xs text-surface-400">${esc(r.source)}</td>
                   <td class="px-4 py-2"><a class="text-surface-200 hover:underline" href="${esc(repoHref)}">${esc(r.owner)}/${esc(r.repo)}</a></td>
                   <td class="px-4 py-2 text-right tabular-nums ${r.hits_30d > 0 ? "text-white font-medium" : "text-surface-500"}">${r.hits_30d}</td>
                   <td class="px-4 py-2 text-right tabular-nums text-surface-400">${r.hits_total}</td>
                   <td class="px-4 py-2 text-right text-xs text-surface-400">${esc(relativeTime(r.last_hit))}</td>
                 </tr>`;
               })
               .join("")}
           </tbody>
         </table>
       </section>`;
  return renderLayout({
    title: "Patterns",
    crumbs: [{ label: "Repos", href: "/dashboard" }, { label: "Patterns" }],
    body: `<div class="mb-6">
             <span class="eyebrow">Rule analytics</span>
             <h1 class="text-2xl md:text-3xl font-bold text-white mt-2">Pattern rules</h1>
             <p class="text-sm text-surface-400 mt-1">Noisy rules are candidates for disabling in <span class="font-mono text-brand-300">.diffsentry.yaml</span>.</p>
           </div>
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

function renderSettings(c: HealthCounts, logs: LogEntry[] = []): string {
  const providerCard = `
    <section class="bg-surface-900/40 border border-surface-800/50 rounded-2xl card-glow p-4">
      <h2 class="text-sm font-semibold text-surface-200 mb-3">Runtime</h2>
      <dl class="grid grid-cols-2 md:grid-cols-3 gap-3 text-sm">
        <div><dt class="text-surface-400 text-xs">AI provider</dt><dd>${esc(process.env.AI_PROVIDER ?? "anthropic")}</dd></div>
        <div><dt class="text-surface-400 text-xs">Node</dt><dd>${esc(process.version)}</dd></div>
        <div><dt class="text-surface-400 text-xs">Port</dt><dd>${esc(process.env.PORT ?? "3005")}</dd></div>
        <div><dt class="text-surface-400 text-xs">Log level</dt><dd>${esc(process.env.LOG_LEVEL ?? "info")}</dd></div>
        <div><dt class="text-surface-400 text-xs">Bot name</dt><dd>${esc(process.env.BOT_NAME ?? "diffsentry")}</dd></div>
        <div><dt class="text-surface-400 text-xs">DB path</dt><dd class="font-mono text-xs">${esc(process.env.DB_PATH ?? "./data/diffsentry.db")}</dd></div>
      </dl>
    </section>`;

  const dbCard = `
    <section class="bg-surface-900/40 border border-surface-800/50 rounded-2xl card-glow p-4">
      <h2 class="text-sm font-semibold text-surface-200 mb-3">Storage</h2>
      <dl class="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
        <div><dt class="text-surface-400 text-xs">Repos</dt><dd class="tabular-nums">${c.repos}</dd></div>
        <div><dt class="text-surface-400 text-xs">PRs</dt><dd class="tabular-nums">${c.prs}</dd></div>
        <div><dt class="text-surface-400 text-xs">Reviews</dt><dd class="tabular-nums">${c.reviews}</dd></div>
        <div><dt class="text-surface-400 text-xs">Findings</dt><dd class="tabular-nums">${c.findings}</dd></div>
        <div><dt class="text-surface-400 text-xs">Pattern hits</dt><dd class="tabular-nums">${c.pattern_hits}</dd></div>
        <div><dt class="text-surface-400 text-xs">Events</dt><dd class="tabular-nums">${c.events}</dd></div>
        <div><dt class="text-surface-400 text-xs">DB size</dt><dd>${esc(bytesHuman(c.db_bytes))}</dd></div>
        <div><dt class="text-surface-400 text-xs">Review span</dt><dd class="text-xs text-surface-400">${esc(c.oldest_review?.slice(0, 10) ?? "—")} → ${esc(c.newest_review?.slice(0, 10) ?? "—")}</dd></div>
      </dl>
    </section>`;

  const note = `
    <section class="bg-brand-950/40 border border-brand-800/40 rounded-2xl p-4 text-sm text-brand-200">
      <div class="flex items-center gap-2 font-semibold mb-1 text-brand-300">
        <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" /></svg>
        Operator-only surface
      </div>
      <div class="text-surface-300">This dashboard is gated behind <span class="font-mono text-brand-300">ENABLE_DASHBOARD=1</span> and GitHub OAuth. Only members of the configured allowlists (logins or orgs) can sign in.</div>
    </section>`;

  const logCard = `
    <section class="bg-surface-900/40 border border-surface-800/50 rounded-2xl card-glow overflow-hidden">
      <div class="px-4 py-3 border-b border-surface-800/50 flex items-center justify-between">
        <h2 class="text-sm font-semibold text-surface-200">Recent warnings &amp; errors</h2>
        <span class="text-xs text-surface-500">${logs.length} entries · newest last</span>
      </div>
      ${
        logs.length === 0
          ? `<div class="px-4 py-6 text-surface-500 text-sm text-center">No warn/error log entries captured since startup.</div>`
          : `<ul class="divide-y divide-surface-800/40 text-sm max-h-96 overflow-auto">
               ${logs
                 .map((e) => {
                   const lvl = e.level === "error" || e.level === "fatal" ? "text-red-300" : "text-amber-300";
                   return `<li class="px-4 py-2 flex items-start gap-3">
                     <span class="text-xs text-surface-500 font-mono whitespace-nowrap">${esc(e.ts.slice(11, 19))}</span>
                     <span class="text-xs font-semibold uppercase ${lvl}">${esc(e.level)}</span>
                     <span class="text-surface-200 break-words">${esc(e.msg)}</span>
                   </li>`;
                 })
                 .join("")}
             </ul>`
      }
    </section>`;

  return renderLayout({
    title: "Settings",
    crumbs: [{ label: "Repos", href: "/dashboard" }, { label: "Settings" }],
    body: `<div class="mb-6">
             <span class="eyebrow">Operator health</span>
             <h1 class="text-2xl md:text-3xl font-bold text-white mt-2">Settings</h1>
             <p class="text-sm text-surface-400 mt-1">Runtime + storage health, plus a live error tail from this process.</p>
           </div>
           <div class="grid grid-cols-1 gap-4">${note}${providerCard}${dbCard}${logCard}</div>`,
  });
}
