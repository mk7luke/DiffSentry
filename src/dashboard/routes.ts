import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { getRecentLogs, logger, type LogEntry } from "../logger.js";
import type { Learning } from "../types.js";
import { esc, pageHeader, relativeTime, renderLayout, riskBadge, runWithRequestContext, severityBadge } from "./layout.js";
import { getCurrentUser } from "./auth.js";
import { renderMarkdown } from "./markdown.js";
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
    runWithRequestContext({ user: user ? { login: user.login } : null, pathname: req.originalUrl ?? "" }, next);
  });

  router.get("/", (req, res) => {
    try {
      const sort = typeof req.query.sort === "string" ? req.query.sort : "last_review";
      const showInactive = req.query.inactive === "1";
      const rows = sortRepos(getRepoOverview(), sort);
      res.type("html").send(renderReposOverview(rows, sort, showInactive));
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

function sortHeader(label: string, key: string, current: string, extraParams = ""): string {
  const active = key === current;
  const cls = active ? "text-white" : "text-surface-400 hover:text-white";
  const arrow = active ? ' <span class="text-brand-400">↓</span>' : "";
  return `<a href="/dashboard?sort=${esc(key)}${extraParams}" class="${cls} transition-colors">${esc(label)}${arrow}</a>`;
}

function renderReposOverview(rows: RepoOverviewRow[], sort: string, showInactive: boolean): string {
  const visibleRows = showInactive ? rows : rows.filter((r) => r.prs_reviewed > 0);
  const totals = rows.reduce(
    (acc, r) => {
      acc.repos += 1;
      if (r.prs_reviewed > 0) acc.active += 1;
      acc.prs += r.prs_reviewed;
      acc.findings += r.findings_7d;
      acc.critical += r.critical_7d;
      return acc;
    },
    { repos: 0, active: 0, prs: 0, findings: 0, critical: 0 },
  );

  const stat = (label: string, value: string, accent = false) => `
    <div class="panel p-3.5">
      <div class="text-[11px] uppercase tracking-wider text-surface-400 font-semibold mb-1">${esc(label)}</div>
      <div class="text-2xl font-semibold tabular-nums ${accent ? "text-red-300" : "text-white"}">${esc(value)}</div>
    </div>`;

  const toggleSuffix = showInactive ? "" : "&inactive=1";
  const filterLink = showInactive
    ? `<a href="/dashboard?sort=${esc(sort)}" class="btn btn-ghost">Hide inactive (${totals.repos - totals.active})</a>`
    : `<a href="/dashboard?sort=${esc(sort)}&inactive=1" class="btn btn-ghost">Show inactive (${totals.repos - totals.active})</a>`;

  const table = visibleRows.length === 0
    ? `<div class="panel">
         <div class="panel-body text-center text-surface-400 py-8">
           ${rows.length === 0
             ? "No repos recorded yet. Open a PR in an installed repo to populate the database."
             : "No repos with reviewed PRs yet."}
         </div>
       </div>`
    : `<div class="panel panel-body-flush">
         <div class="overflow-x-auto">
           <table class="dash-table">
             <thead>
               <tr>
                 <th>${sortHeader("Repo", "repo", sort, toggleSuffix)}</th>
                 <th class="num">${sortHeader("PRs reviewed", "prs_reviewed", sort, toggleSuffix)}</th>
                 <th class="num">${sortHeader("Findings · 7d", "findings_7d", sort, toggleSuffix)}</th>
                 <th class="num">${sortHeader("Critical · 7d", "critical_7d", sort, toggleSuffix)}</th>
                 <th class="right">${sortHeader("Last review", "last_review", sort, toggleSuffix)}</th>
               </tr>
             </thead>
             <tbody>
               ${visibleRows
                 .map((r) => {
                   const href = `/dashboard/repo/${encodeURIComponent(r.owner)}/${encodeURIComponent(r.repo)}`;
                   const zero = r.prs_reviewed === 0;
                   const prsCls = zero ? "zero" : "";
                   const findCls = r.findings_7d === 0 ? "zero" : "";
                   const critCls = r.critical_7d > 0 ? "num-crit" : r.critical_7d === 0 ? "text-surface-500" : "";
                   return `<tr>
                     <td>
                       <a href="${esc(href)}" class="link font-medium">${esc(r.owner)}/${esc(r.repo)}</a>
                     </td>
                     <td class="num ${prsCls}">${r.prs_reviewed}</td>
                     <td class="num ${findCls}">${r.findings_7d}</td>
                     <td class="num ${critCls}">${r.critical_7d}</td>
                     <td class="right muted">${esc(relativeTime(r.last_review)) || "—"}</td>
                   </tr>`;
                 })
                 .join("")}
             </tbody>
           </table>
         </div>
       </div>`;

  return renderLayout({
    title: "Repos",
    crumbs: [{ label: "Repos" }],
    body: `
      ${pageHeader({
        title: "Repos",
        subtitle: `${totals.active} active · ${totals.repos} installed · rolling 7-day stats`,
        right: filterLink,
      })}
      <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
        ${stat("Active repos", String(totals.active))}
        ${stat("PRs reviewed", String(totals.prs))}
        ${stat("Findings · 7d", String(totals.findings))}
        ${stat("Critical · 7d", String(totals.critical), totals.critical > 0)}
      </div>
      ${table}
    `,
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
    return `<div class="text-surface-400 text-sm py-6 text-center">Not enough reviews yet for a 90-day chart.</div>`;
  }
  const w = 720;
  const h = 90;
  const pad = 6;
  const max = 100; // risk_score is 0..100
  const n = points.length;
  const coords = points.map((p, i) => {
    const x = pad + (i * (w - 2 * pad)) / Math.max(1, n - 1);
    const score = typeof p.risk_score === "number" ? p.risk_score : 0;
    const y = h - pad - (score / max) * (h - 2 * pad);
    return [x, y, p] as const;
  });
  const polyline = coords.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const areaPoly = `${pad},${h - pad} ` + polyline + ` ${(w - pad).toFixed(1)},${h - pad}`;
  const dots = coords
    .map(([x, y, p]) => {
      const score = typeof p.risk_score === "number" ? p.risk_score : 0;
      const color = score >= 75 ? "#fca5a5" : score >= 55 ? "#fdba74" : score >= 35 ? "#fcd34d" : score >= 15 ? "#fde68a" : "#86efac";
      const title = `#${p.number} · ${score} · ${p.created_at.slice(0, 10)}`;
      return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.5" fill="${color}" stroke="#0d0d12" stroke-width="1"><title>${esc(title)}</title></circle>`;
    })
    .join("");
  return `<svg viewBox="0 0 ${w} ${h}" class="w-full h-24" preserveAspectRatio="none">
    <defs>
      <linearGradient id="sparkFill" x1="0" x2="0" y1="0" y2="1">
        <stop offset="0%" stop-color="#338dff" stop-opacity="0.25"/>
        <stop offset="100%" stop-color="#338dff" stop-opacity="0"/>
      </linearGradient>
    </defs>
    <polygon points="${areaPoly}" fill="url(#sparkFill)" />
    <polyline points="${polyline}" fill="none" stroke="#59b0ff" stroke-width="1.4" />
    ${dots}
  </svg>`;
}

const GH_ICON = `<svg class="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24"><path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/></svg>`;

function panelHead(title: string, right = ""): string {
  return `<div class="panel-head"><h2>${esc(title)}</h2>${right ? `<div class="panel-sub">${right}</div>` : ""}</div>`;
}

function renderRepoDetail(a: RepoDetailArgs): string {
  const title = `${a.owner}/${a.repo}`;
  const sparklineHtml = renderSparkline(a.sparkline);

  const hotPathsHtml = a.hotPaths.length === 0
    ? `<div class="panel-body text-surface-400 text-sm">No critical or major findings in the last 90 days.</div>`
    : `<div class="panel-body-flush"><table class="dash-table">
         <thead><tr>
           <th>Path</th><th class="num">Critical</th><th class="num">Major</th><th class="num">Total</th>
         </tr></thead>
         <tbody>
           ${a.hotPaths
             .map(
               (p) => `<tr>
                 <td class="font-mono text-xs truncate max-w-md">${esc(p.path)}</td>
                 <td class="num ${p.critical > 0 ? "num-crit" : "zero"}">${p.critical}</td>
                 <td class="num ${p.major > 0 ? "num-strong" : "zero"}">${p.major}</td>
                 <td class="num muted">${p.total}</td>
               </tr>`,
             )
             .join("")}
         </tbody>
       </table></div>`;

  const topRulesHtml = a.topRules.length === 0
    ? `<div class="panel-body text-surface-400 text-sm">No pattern-rule hits recorded.</div>`
    : `<div class="panel-body-flush"><table class="dash-table">
         <thead><tr>
           <th>Rule</th><th>Source</th><th class="num">Hits</th><th class="right">Example</th>
         </tr></thead>
         <tbody>
           ${a.topRules
             .map(
               (r) => `<tr>
                 <td class="font-mono text-xs">${esc(r.rule_name)}</td>
                 <td class="muted text-xs">${esc(r.source)}</td>
                 <td class="num num-strong">${r.hits}</td>
                 <td class="right">${
                   r.example_pr
                     ? `<a class="link" href="/dashboard/repo/${encodeURIComponent(a.owner)}/${encodeURIComponent(a.repo)}/pr/${r.example_pr}">#${r.example_pr}</a>`
                     : `<span class="text-surface-500">—</span>`
                 }</td>
               </tr>`,
             )
             .join("")}
         </tbody>
       </table></div>`;

  const reviewsHtml = a.reviews.length === 0
    ? `<div class="panel-body text-surface-400 text-sm">No reviews recorded yet.</div>`
    : `<div class="panel-body-flush overflow-x-auto"><table class="dash-table">
         <thead><tr>
           <th>PR</th><th>Title</th><th>Author</th><th>Risk</th><th class="num">Findings</th><th>Approval</th><th class="right">When</th>
         </tr></thead>
         <tbody>
           ${a.reviews
             .map((rv) => {
               const href = `/dashboard/repo/${encodeURIComponent(a.owner)}/${encodeURIComponent(a.repo)}/pr/${rv.number}`;
               return `<tr>
                 <td><a href="${esc(href)}" class="link">#${rv.number}</a></td>
                 <td class="truncate max-w-md">${esc(rv.title ?? "—")}</td>
                 <td class="muted">${rv.author ? `@${esc(rv.author)}` : "—"}</td>
                 <td>${riskBadge(rv.risk_level, rv.risk_score)}</td>
                 <td class="num ${rv.finding_count > 0 ? "num-strong" : "zero"}">${rv.finding_count}</td>
                 <td class="text-xs muted">${esc(rv.approval ?? "—")}</td>
                 <td class="right muted">${esc(relativeTime(rv.created_at))}</td>
               </tr>`;
             })
             .join("")}
         </tbody>
       </table></div>`;

  const gitHubAction = `<a href="https://github.com/${esc(a.owner)}/${esc(a.repo)}" class="btn btn-ghost" target="_blank" rel="noopener">${GH_ICON}Open in GitHub</a>`;

  const body = `
    ${pageHeader({
      title,
      subtitle: `Reviewed ${a.reviews.length} time${a.reviews.length === 1 ? "" : "s"} · ${a.sparkline.length} datapoint${a.sparkline.length === 1 ? "" : "s"} in the last 90 days`,
      right: gitHubAction,
    })}
    <div class="grid grid-cols-1 gap-4">
      <section class="panel">
        ${panelHead("Risk — last 90 days", `0–100 risk score per review`)}
        <div class="panel-body">${sparklineHtml}</div>
      </section>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <section class="panel">
          ${panelHead("Hot paths", "Critical + major findings · last 90 days")}
          ${hotPathsHtml}
        </section>
        <section class="panel">
          ${panelHead("Top firing rules", "All time")}
          ${topRulesHtml}
        </section>
      </div>
      <section class="panel">
        ${panelHead("Recent reviews", `Latest ${a.reviews.length}`)}
        ${reviewsHtml}
      </section>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
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
    ? `<div class="panel-body text-surface-400 text-sm">No learnings recorded for this repo. Use <span class="font-mono text-brand-300">@bot learn …</span> on a PR to add one.</div>`
    : `<ul class="divide-y divide-surface-800 text-sm max-h-80 overflow-auto">
         ${learnings
           .map(
             (l) => `<li class="px-3.5 py-2.5 flex items-start gap-3">
               <span class="text-[11px] text-surface-500 whitespace-nowrap font-mono mt-0.5">${esc(relativeTime(l.createdAt))}</span>
               <div class="flex-1 min-w-0">
                 ${l.path ? `<div class="text-[11px] font-mono text-surface-400 truncate mb-0.5">${esc(l.path)}</div>` : ""}
                 <div class="text-surface-100 break-words">${esc(l.content)}</div>
               </div>
             </li>`,
           )
           .join("")}
       </ul>`;
  return `<section class="panel">
    ${panelHead(`Learnings (${learnings.length})`, "From @bot learn")}
    ${body}
  </section>`;
}

function renderConfigCard(yaml: string | null): string {
  if (yaml === null) {
    return `<section class="panel">
      ${panelHead(".diffsentry.yaml", "Repo defaults")}
      <div class="panel-body text-surface-400 text-sm">No config file in this repo — defaults are in use.</div>
    </section>`;
  }
  return `<section class="panel">
    ${panelHead(".diffsentry.yaml", "Cached 5m from GitHub")}
    <div class="panel-body"><pre class="text-xs font-mono text-brand-200 bg-surface-950 border border-surface-800 rounded p-3 max-h-80 overflow-auto whitespace-pre">${esc(yaml)}</pre></div>
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

  const header = pageHeader({
    title: a.pr?.title ?? `PR #${a.number}`,
    subtitle: `<span class="font-mono text-surface-300">${esc(a.owner)}/${esc(a.repo)}</span> <span class="text-surface-600">·</span> #${a.number}${a.pr?.author ? ` <span class="text-surface-600">·</span> by <span class="text-brand-300">@${esc(a.pr.author)}</span>` : ""}${a.pr?.state ? ` <span class="text-surface-600">·</span> <span class="font-mono">${esc(a.pr.state)}</span>` : ""}`,
    right: `<a href="${esc(ghUrl)}" class="btn btn-ghost" target="_blank" rel="noopener">${GH_ICON}Open in GitHub</a>`,
  });

  const latestHtml = a.latest
    ? `<section class="panel">
         ${panelHead("Latest review", `${esc((a.latest.sha ?? "").slice(0, 7))} · ${esc(relativeTime(a.latest.created_at))}`)}
         <div class="panel-body">
           <div class="flex items-center gap-2 mb-4">
             ${riskBadge(a.latest.risk_level, a.latest.risk_score)}
             <span class="chip bg-surface-800 text-surface-300">${esc(a.latest.profile ?? "—")}</span>
             <span class="chip bg-surface-800 text-surface-300">${esc(a.latest.approval ?? "—")}</span>
           </div>
           <dl class="kv">
             <div><dt>Files processed</dt><dd>${a.latest.files_processed ?? 0}</dd></div>
             <div><dt>Findings</dt><dd>${a.latest.finding_count}</dd></div>
             <div><dt>Skipped · similar</dt><dd>${a.latest.files_skipped_similar ?? 0}</dd></div>
             <div><dt>Skipped · trivial</dt><dd>${a.latest.files_skipped_trivial ?? 0}</dd></div>
           </dl>
           ${
             a.latest.summary
               ? `<div class="mt-4 pt-4 border-t border-surface-800">
                    <div class="flex items-center justify-between mb-2">
                      <div class="text-[11px] uppercase tracking-wider text-surface-400 font-semibold">Summary</div>
                      <button type="button" class="text-[11px] text-surface-500 hover:text-surface-200" onclick="var m=this.closest('[data-md-wrap]'); m.classList.toggle('show-raw');">toggle raw</button>
                    </div>
                    <div data-md-wrap>
                      <div class="md-body md-rendered max-h-80 overflow-auto">${renderMarkdown(a.latest.summary)}</div>
                      <pre class="md-raw text-xs whitespace-pre-wrap font-mono text-surface-200 leading-relaxed max-h-80 overflow-auto" style="display:none;">${esc(a.latest.summary)}</pre>
                    </div>
                  </div>`
               : ""
           }
         </div>
       </section>`
    : `<div class="panel"><div class="panel-body text-surface-400 text-sm">No reviews recorded for this PR.</div></div>`;

  const findingsHtml = a.findings.length === 0
    ? `<div class="panel-body text-surface-400 text-sm">No findings in the latest review.</div>`
    : `<div class="panel-body-flush"><table class="dash-table">
         <thead><tr>
           <th>Severity</th><th>Location</th><th>Title</th><th>Source</th>
         </tr></thead>
         <tbody>
           ${a.findings
             .map(
               (f) => `<tr>
                 <td>${severityBadge(f.severity)}</td>
                 <td class="font-mono text-xs">${esc(f.path ?? "")}${f.line ? `<span class="text-surface-500">:${f.line}</span>` : ""}</td>
                 <td>
                   <div class="text-surface-100 font-medium">${esc(f.title ?? "—")}</div>
                   ${f.body ? `<details class="mt-1"><summary class="text-[11px] text-surface-400 cursor-pointer hover:text-surface-200">Show rendered body</summary><div class="md-body mt-2 pl-3 border-l border-surface-800">${renderMarkdown(f.body.slice(0, 4000))}</div></details>` : ""}
                 </td>
                 <td class="text-xs muted">${esc(f.source ?? "—")}</td>
               </tr>`,
             )
             .join("")}
         </tbody>
       </table></div>`;

  const reviewsList = a.reviews.length <= 1
    ? ""
    : `<section class="panel">
         ${panelHead(`All reviews (${a.reviews.length})`)}
         <div class="panel-body-flush"><table class="dash-table">
           <thead><tr>
             <th class="right">When</th><th>SHA</th><th>Profile</th><th>Risk</th><th class="num">Findings</th><th>Approval</th>
           </tr></thead>
           <tbody>
             ${a.reviews
               .map(
                 (rv) => `<tr>
                   <td class="right muted">${esc(relativeTime(rv.created_at))}</td>
                   <td class="font-mono text-xs text-brand-300">${esc((rv.sha ?? "").slice(0, 7))}</td>
                   <td class="text-xs muted">${esc(rv.profile ?? "—")}</td>
                   <td>${riskBadge(rv.risk_level, rv.risk_score)}</td>
                   <td class="num ${rv.finding_count > 0 ? "num-strong" : "zero"}">${rv.finding_count}</td>
                   <td class="text-xs muted">${esc(rv.approval ?? "—")}</td>
                 </tr>`,
               )
               .join("")}
           </tbody>
         </table></div>
       </section>`;

  const eventsHtml = a.events.length === 0
    ? `<div class="panel-body text-surface-400 text-sm">No events.</div>`
    : `<ul class="divide-y divide-surface-800 max-h-96 overflow-auto">
         ${a.events
           .map(
             (ev) => `<li class="px-3.5 py-2 flex items-center justify-between text-sm">
               <span class="font-mono text-xs text-surface-200">${esc(ev.kind)}</span>
               <span class="text-[11px] text-surface-500 font-mono">${esc(relativeTime(ev.ts))}</span>
             </li>`,
           )
           .join("")}
       </ul>`;

  const body = `
    ${header}
    <div class="grid grid-cols-1 gap-4">
      ${latestHtml}
      <section class="panel">
        ${panelHead("Findings", a.findings.length > 0 ? `${a.findings.length} in latest review` : "")}
        ${findingsHtml}
      </section>
      ${reviewsList}
      <section class="panel">
        ${panelHead("Events", `${a.events.length} most recent`)}
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
    body: `<div class="panel">
      <div class="panel-body text-center py-10">
        <div class="text-xs text-surface-400 font-mono mb-2">404 · NOT FOUND</div>
        <div class="text-surface-100 text-sm mb-4">${esc(msg)}</div>
        <a href="/dashboard" class="btn btn-ghost">← Back to repos</a>
      </div>
    </div>`,
  });
}

function renderError(msg: string): string {
  return renderLayout({
    title: "Error",
    body: `<div class="panel" style="border-color:rgba(239,68,68,0.4);">
      <div class="panel-body">
        <div class="text-red-300 text-sm font-semibold">${esc(msg)}</div>
        <div class="text-surface-400 text-xs mt-1">Check server logs for details.</div>
      </div>
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
    <form method="get" class="panel">
      <div class="panel-body">
        <div class="grid grid-cols-1 md:grid-cols-6 gap-3">
          <label class="flex flex-col text-[11px] uppercase tracking-wider text-surface-400 font-semibold gap-1">Severity
            <select name="severity">
              ${selectOpt("", "any", a.filters.severity)}
              ${selectOpt("critical", "critical", a.filters.severity)}
              ${selectOpt("major", "major", a.filters.severity)}
              ${selectOpt("minor", "minor", a.filters.severity)}
              ${selectOpt("nit", "nit", a.filters.severity)}
            </select>
          </label>
          <label class="flex flex-col text-[11px] uppercase tracking-wider text-surface-400 font-semibold gap-1">Source
            <select name="source">
              ${selectOpt("", "any", a.filters.source)}
              ${selectOpt("ai", "ai", a.filters.source)}
              ${selectOpt("safety", "safety", a.filters.source)}
              ${selectOpt("builtin", "builtin", a.filters.source)}
              ${selectOpt("custom", "custom", a.filters.source)}
            </select>
          </label>
          <label class="flex flex-col text-[11px] uppercase tracking-wider text-surface-400 font-semibold gap-1">Repo
            <input name="repo" value="${esc(a.filters.repo ?? "")}" placeholder="owner/repo" />
          </label>
          <label class="flex flex-col text-[11px] uppercase tracking-wider text-surface-400 font-semibold gap-1 md:col-span-2">Search path / title
            <input name="q" value="${esc(a.filters.q ?? "")}" placeholder="e.g. src/server" />
          </label>
          <label class="flex flex-col text-[11px] uppercase tracking-wider text-surface-400 font-semibold gap-1">Age
            <select name="age">
              ${selectOpt("", "any", ageStr)}
              ${selectOpt("7", "7 days", ageStr)}
              ${selectOpt("30", "30 days", ageStr)}
              ${selectOpt("90", "90 days", ageStr)}
            </select>
          </label>
        </div>
        <input type="hidden" name="limit" value="${esc(String(limit))}" />
        <div class="flex items-center justify-end gap-2 mt-3">
          <a href="/dashboard/findings" class="text-[11px] text-surface-400 hover:text-surface-200 transition-colors">Clear</a>
          <button type="submit" class="btn btn-primary">Apply filters</button>
        </div>
      </div>
    </form>`;

  const fingerprintClause = a.filters.fingerprint
    ? `<div class="panel">
         <div class="panel-body flex items-center justify-between text-xs">
           <span class="text-surface-300">Filtering by fingerprint <span class="font-mono text-brand-300">${esc(a.filters.fingerprint)}</span></span>
           <a href="/dashboard/findings${queryStringFromFilters(a.filters, { fingerprint: undefined })}" class="text-surface-400 hover:text-white transition-colors">Clear fingerprint</a>
         </div>
       </div>`
    : "";

  const groupsHtml = a.groups.length === 0
    ? ""
    : `<section class="panel">
         ${panelHead("Recurring fingerprints", `${a.groups.length} groups`)}
         <div class="panel-body-flush"><table class="dash-table">
           <thead><tr>
             <th>Fingerprint</th><th>Title</th><th>Severity</th><th class="num">Occurrences</th><th class="num">Repos</th><th class="right">Last seen</th>
           </tr></thead>
           <tbody>
             ${a.groups
               .map((g) => {
                 const href = `/dashboard/findings${queryStringFromFilters(a.filters, { fingerprint: g.fingerprint })}`;
                 return `<tr>
                   <td><a class="link font-mono text-xs" href="${esc(href)}">${esc(g.fingerprint)}</a></td>
                   <td class="truncate max-w-md">${esc(g.title ?? "—")}</td>
                   <td>${severityBadge(g.severity)}</td>
                   <td class="num num-strong">${g.occurrences}</td>
                   <td class="num">${g.repos}</td>
                   <td class="right muted">${esc(relativeTime(g.last_seen))}</td>
                 </tr>`;
               })
               .join("")}
           </tbody>
         </table></div>
       </section>`;

  const tableHtml = a.rows.length === 0
    ? `<div class="panel"><div class="panel-body text-surface-400 text-sm text-center py-8">No findings match these filters.</div></div>`
    : `<section class="panel">
         ${panelHead("Findings", `${a.rows.length} shown · ${a.total} total`)}
         <div class="panel-body-flush overflow-x-auto"><table class="dash-table">
           <thead><tr>
             <th class="right">When</th><th>Repo</th><th>PR</th><th>Severity</th><th>Location</th><th>Title</th><th>Source</th>
           </tr></thead>
           <tbody>
             ${a.rows
               .map((r) => {
                 const prHref = `/dashboard/repo/${encodeURIComponent(r.owner)}/${encodeURIComponent(r.repo)}/pr/${r.number}`;
                 const repoHref = `/dashboard/repo/${encodeURIComponent(r.owner)}/${encodeURIComponent(r.repo)}`;
                 return `<tr>
                   <td class="right muted text-xs whitespace-nowrap">${esc(relativeTime(r.created_at))}</td>
                   <td><a class="link" href="${esc(repoHref)}">${esc(r.owner)}/${esc(r.repo)}</a></td>
                   <td><a class="link" href="${esc(prHref)}">#${r.number}</a></td>
                   <td>${severityBadge(r.severity)}</td>
                   <td class="font-mono text-xs truncate max-w-xs">${esc(r.path ?? "")}${r.line ? `<span class="text-surface-500">:${r.line}</span>` : ""}</td>
                   <td class="truncate max-w-md">${esc(r.title ?? "—")}</td>
                   <td class="text-xs muted">${esc(r.source ?? "—")}</td>
                 </tr>`;
               })
               .join("")}
           </tbody>
         </table></div>
       </section>`;

  const prev = offset > 0
    ? `<a href="/dashboard/findings${queryStringFromFilters(a.filters, { offset: Math.max(0, offset - limit) })}" class="btn btn-ghost">← Prev</a>`
    : `<span class="btn btn-ghost opacity-40 pointer-events-none">← Prev</span>`;
  const next = offset + limit < a.total
    ? `<a href="/dashboard/findings${queryStringFromFilters(a.filters, { offset: offset + limit })}" class="btn btn-ghost">Next →</a>`
    : `<span class="btn btn-ghost opacity-40 pointer-events-none">Next →</span>`;
  const pager = a.total > limit
    ? `<div class="flex items-center justify-between text-xs text-surface-400 mt-1">
         ${prev}
         <div class="font-mono">rows ${offset + 1}–${Math.min(a.total, offset + a.rows.length)} of ${a.total}</div>
         ${next}
       </div>`
    : "";

  const body = `
    ${pageHeader({
      title: "Findings",
      subtitle: `${a.total} total · filter across severities, sources, and repos. Grouped by fingerprint to spot repeat offenders.`,
    })}
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
  const thirtyDayTotal = rules.reduce((n, r) => n + r.hits_30d, 0);
  const allTimeTotal = rules.reduce((n, r) => n + r.hits_total, 0);
  const body = rules.length === 0
    ? `<div class="panel"><div class="panel-body text-center text-surface-400 py-8">No pattern-rule hits recorded yet.</div></div>`
    : `<section class="panel">
         ${panelHead("Pattern rules", `${rules.length} rules · ${thirtyDayTotal} hits · 30d · ${allTimeTotal} all time`)}
         <div class="panel-body-flush overflow-x-auto"><table class="dash-table">
           <thead><tr>
             <th>Rule</th><th>Source</th><th>Repo</th><th class="num">Hits · 30d</th><th class="num">Hits · all time</th><th class="right">Last hit</th>
           </tr></thead>
           <tbody>
             ${rules
               .map((r) => {
                 const repoHref = `/dashboard/repo/${encodeURIComponent(r.owner)}/${encodeURIComponent(r.repo)}`;
                 return `<tr>
                   <td class="font-mono text-xs text-surface-100">${esc(r.rule_name)}</td>
                   <td class="text-xs muted">${esc(r.source)}</td>
                   <td><a class="link" href="${esc(repoHref)}">${esc(r.owner)}/${esc(r.repo)}</a></td>
                   <td class="num ${r.hits_30d > 0 ? "num-strong" : "zero"}">${r.hits_30d}</td>
                   <td class="num muted">${r.hits_total}</td>
                   <td class="right muted text-xs">${esc(relativeTime(r.last_hit))}</td>
                 </tr>`;
               })
               .join("")}
           </tbody>
         </table></div>
       </section>`;
  return renderLayout({
    title: "Patterns",
    crumbs: [{ label: "Repos", href: "/dashboard" }, { label: "Patterns" }],
    body: `${pageHeader({
             title: "Pattern rules",
             subtitle: `Built-in, safety-scanner, and custom rules. Disable noisy ones in <span class="font-mono text-brand-300">.diffsentry.yaml</span>.`,
           })}
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
    <section class="panel">
      ${panelHead("Runtime", "Process-level config")}
      <div class="panel-body">
        <dl class="kv">
          <div><dt>AI provider</dt><dd>${esc(process.env.AI_PROVIDER ?? "anthropic")}</dd></div>
          <div><dt>Node</dt><dd class="mono">${esc(process.version)}</dd></div>
          <div><dt>Port</dt><dd>${esc(process.env.PORT ?? "3005")}</dd></div>
          <div><dt>Log level</dt><dd>${esc(process.env.LOG_LEVEL ?? "info")}</dd></div>
          <div><dt>Bot name</dt><dd>${esc(process.env.BOT_NAME ?? "diffsentry")}</dd></div>
          <div><dt>DB path</dt><dd class="mono">${esc(process.env.DB_PATH ?? "./data/diffsentry.db")}</dd></div>
        </dl>
      </div>
    </section>`;

  const dbCard = `
    <section class="panel">
      ${panelHead("Storage", `SQLite · ${esc(bytesHuman(c.db_bytes))}`)}
      <div class="panel-body">
        <dl class="kv">
          <div><dt>Repos</dt><dd>${c.repos}</dd></div>
          <div><dt>PRs</dt><dd>${c.prs}</dd></div>
          <div><dt>Reviews</dt><dd>${c.reviews}</dd></div>
          <div><dt>Findings</dt><dd>${c.findings}</dd></div>
          <div><dt>Pattern hits</dt><dd>${c.pattern_hits}</dd></div>
          <div><dt>Events</dt><dd>${c.events}</dd></div>
          <div><dt>DB size</dt><dd>${esc(bytesHuman(c.db_bytes))}</dd></div>
          <div><dt>Review span</dt><dd class="mono">${esc(c.oldest_review?.slice(0, 10) ?? "—")} → ${esc(c.newest_review?.slice(0, 10) ?? "—")}</dd></div>
        </dl>
      </div>
    </section>`;

  const note = `
    <section class="panel" style="border-color:#1746b6;background:linear-gradient(180deg,rgba(23,70,182,0.15),transparent 70%);">
      <div class="panel-body">
        <div class="flex items-start gap-3">
          <svg class="w-4 h-4 text-brand-400 mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
          <div>
            <div class="text-sm font-semibold text-surface-100 mb-0.5">Operator-only surface</div>
            <div class="text-[13px] text-surface-300">Gated behind <span class="font-mono text-brand-300">ENABLE_DASHBOARD=1</span> and GitHub OAuth. Only users in <span class="font-mono text-brand-300">DASHBOARD_ALLOWED_LOGINS</span> or member orgs can sign in.</div>
          </div>
        </div>
      </div>
    </section>`;

  const logCard = `
    <section class="panel">
      ${panelHead("Recent warnings & errors", `${logs.length} entries · newest last`)}
      ${
        logs.length === 0
          ? `<div class="panel-body text-surface-400 text-sm text-center py-6">No warn/error log entries captured since startup.</div>`
          : `<ul class="divide-y divide-surface-800 text-sm max-h-96 overflow-auto">
               ${logs
                 .map((e) => {
                   const lvl = e.level === "error" || e.level === "fatal" ? "text-red-300" : "text-amber-300";
                   return `<li class="px-3.5 py-2 flex items-start gap-3">
                     <span class="text-[11px] text-surface-500 font-mono whitespace-nowrap">${esc(e.ts.slice(11, 19))}</span>
                     <span class="text-[10px] font-semibold uppercase tracking-wider ${lvl} w-12 shrink-0">${esc(e.level)}</span>
                     <span class="text-surface-100 break-words flex-1">${esc(e.msg)}</span>
                   </li>`;
                 })
                 .join("")}
             </ul>`
      }
    </section>`;

  return renderLayout({
    title: "Settings",
    crumbs: [{ label: "Repos", href: "/dashboard" }, { label: "Settings" }],
    body: `${pageHeader({
             title: "Settings",
             subtitle: "Runtime + storage health, plus a live error tail from this process.",
           })}
           <div class="grid grid-cols-1 gap-4">${note}${providerCard}${dbCard}${logCard}</div>`,
  });
}
