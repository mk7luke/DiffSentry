import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { getRecentLogs, logger, type LogEntry } from "../logger.js";
import { LearningsStore } from "../learnings.js";
import type { Learning } from "../types.js";
import {
  approvalBadge,
  buildDaySeries,
  card,
  donut,
  esc,
  hbar,
  ICON,
  metric,
  miniSparkbar,
  pageHeader,
  relativeTime,
  renderLayout,
  repoHealth,
  riskBadge,
  riskLine,
  runWithRequestContext,
  severityBadge,
  stackedSeverityBar,
  type DayBin,
} from "./layout.js";
import { createCsrf, createNoopCsrf, getCurrentUser, type CsrfRuntime } from "./auth.js";
import { renderMarkdown } from "./markdown.js";
import {
  getApprovalMix,
  getDailyActivity,
  getEvents,
  getFindingsForPR,
  getHealthCounts,
  getHotPaths,
  getInstallationId,
  getIssue,
  getIssueEvents,
  getPR,
  getPRReviews,
  getPatternRules,
  getRecentIssues,
  getRecentPRsWithReviews,
  getRepoOverview,
  getSparkline,
  getTopRules,
  issueExists,
  queryFindings,
  queryFingerprintGroups,
  repoExists,
  type DailyActivityRow,
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
  const learningsStore = new LearningsStore(deps.learningsDir);
  const csrf: CsrfRuntime = deps.auth?.csrf ?? createNoopCsrf();
  if (deps.auth) {
    deps.auth.routes(router);
    router.use(deps.auth.middleware);
  }

  // Form posts from the learnings card (delete + edit). Scoped to this router
  // only so the webhook's raw-body parser is unaffected.
  router.use(express.urlencoded({ extended: false, limit: "32kb" }));
  router.use(csrf.ensure);

  router.use((req, _res, next) => {
    const user = getCurrentUser(req);
    runWithRequestContext({ user: user ? { login: user.login } : null, pathname: req.originalUrl ?? "" }, next);
  });

  router.get("/", (req, res) => {
    try {
      const sort = typeof req.query.sort === "string" ? req.query.sort : "last_review";
      const showInactive = req.query.inactive === "1";
      const rows = sortRepos(getRepoOverview(), sort);
      const activity = getDailyActivity(null, null, 14);
      const activityByRepo = groupActivityByRepo(activity);
      res.type("html").send(renderReposOverview(rows, sort, showInactive, activityByRepo));
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
      const prs = getRecentPRsWithReviews(owner, repo, 50);
      const issues = getRecentIssues(owner, repo, 50);
      const activity = buildDaySeries(toDayBins(getDailyActivity(owner, repo, 30)), 30);
      const approvalMix = getApprovalMix(owner, repo, 30);
      const learnings = await loadLearningsSafe(deps.learningsDir, owner, repo);
      const configYaml = await loadRepoConfigSafe(deps, owner, repo);
      const csrfToken = csrf.tokenFor(req);
      res.type("html").send(
        renderRepoDetail({ owner, repo, sparkline, hotPaths, topRules, prs, issues, activity, approvalMix, learnings, configYaml, csrfToken }),
      );
    } catch (err) {
      logger.error({ err, owner, repo }, "dashboard repo detail failed");
      res.status(500).type("html").send(renderError("Failed to load repo detail."));
    }
  });

  router.post("/repo/:owner/:repo/learnings/:id/delete", csrf.verify, async (req, res) => {
    const { owner, repo, id } = req.params;
    try {
      await learningsStore.removeLearning(`${owner}/${repo}`, id);
    } catch (err) {
      logger.error({ err, owner, repo, id }, "dashboard learning delete failed");
    }
    res.redirect(303, `/dashboard/repo/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}#learnings`);
  });

  router.post("/repo/:owner/:repo/learnings/:id/edit", csrf.verify, async (req, res) => {
    const { owner, repo, id } = req.params;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const content = typeof body.content === "string" ? body.content : "";
    const rawPath = typeof body.path === "string" ? body.path.trim() : "";
    try {
      await learningsStore.updateLearning(`${owner}/${repo}`, id, {
        content,
        path: rawPath.length > 0 ? rawPath : null,
      });
    } catch (err) {
      logger.error({ err, owner, repo, id }, "dashboard learning edit failed");
    }
    res.redirect(303, `/dashboard/repo/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}#learnings`);
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

  router.get("/repo/:owner/:repo/issue/:number", (req, res) => {
    const owner = req.params.owner;
    const repo = req.params.repo;
    const number = Number.parseInt(req.params.number, 10);
    if (!Number.isFinite(number) || number <= 0) {
      res.status(400).type("html").send(renderError("Invalid issue number."));
      return;
    }
    try {
      if (!issueExists(owner, repo, number)) {
        res.status(404).type("html").send(renderNotFound(`No data for ${owner}/${repo}#${number}`));
        return;
      }
      const issue = getIssue(owner, repo, number);
      const events = getIssueEvents(owner, repo, number, 200);
      if (!issue) {
        res.status(404).type("html").send(renderNotFound(`No data for ${owner}/${repo}#${number}`));
        return;
      }
      res.type("html").send(renderIssueDetail({ owner, repo, number, issue, events }));
    } catch (err) {
      logger.error({ err, owner, repo, number }, "dashboard issue detail failed");
      res.status(500).type("html").send(renderError("Failed to load issue detail."));
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
      const findings = getFindingsForPR(owner, repo, number);
      const events = getEvents(owner, repo, number, 200);
      res.type("html").send(renderPRDetail({ owner, repo, number, pr, reviews, latest, findings, events }));
    } catch (err) {
      logger.error({ err, owner, repo, number }, "dashboard PR detail failed");
      res.status(500).type("html").send(renderError("Failed to load PR detail."));
    }
  });

  return router;
}

// ─── Helpers ─────────────────────────────────────────────────────────

function toDayBins(rows: DailyActivityRow[]): DayBin[] {
  return rows.map((r) => ({
    day: r.day,
    reviews: r.reviews,
    critical: r.critical,
    major: r.major,
    minor: r.minor,
    nit: r.nit,
  }));
}

function groupActivityByRepo(rows: DailyActivityRow[]): Map<string, DayBin[]> {
  const out = new Map<string, DayBin[]>();
  for (const r of rows) {
    const key = `${r.owner}/${r.repo}`;
    const arr = out.get(key) ?? [];
    arr.push({ day: r.day, reviews: r.reviews, critical: r.critical, major: r.major, minor: r.minor, nit: r.nit });
    out.set(key, arr);
  }
  return out;
}

// ─── Repos overview ──────────────────────────────────────────────────

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

function sortLink(label: string, key: string, current: string, extraParams = ""): string {
  const active = key === current;
  const arrow = active ? ' <span style="color:var(--accent-bright)">↓</span>' : "";
  const style = active ? "color:var(--text)" : "color:var(--text-3)";
  return `<a href="/dashboard?sort=${esc(key)}${extraParams}" class="btn btn-link" style="${style}">${esc(label)}${arrow}</a>`;
}

function renderReposOverview(
  rows: RepoOverviewRow[],
  sort: string,
  showInactive: boolean,
  activityByRepo: Map<string, DayBin[]>,
): string {
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

  // Aggregate 14-day series across all repos for the hero chart
  const aggregate: DayBin[] = buildDaySeries([], 14);
  for (const bins of activityByRepo.values()) {
    for (const b of bins) {
      const i = aggregate.findIndex((a) => a.day === b.day);
      if (i >= 0) {
        aggregate[i].reviews += b.reviews;
        aggregate[i].critical += b.critical;
        aggregate[i].major += b.major;
        aggregate[i].minor += b.minor;
        aggregate[i].nit += b.nit;
      }
    }
  }

  const toggleSuffix = showInactive ? "" : "&inactive=1";
  const inactiveCount = totals.repos - totals.active;
  const filterLink = showInactive
    ? `<a href="/dashboard?sort=${esc(sort)}" class="btn btn-ghost">Hide inactive (${inactiveCount})</a>`
    : `<a href="/dashboard?sort=${esc(sort)}&inactive=1" class="btn btn-ghost">Show inactive (${inactiveCount})</a>`;

  const sortControls = `
    <div style="display:flex;align-items:center;gap:4px;font-size:11px;color:var(--text-3)">
      <span style="margin-right:4px">Sort:</span>
      ${sortLink("Last review", "last_review", sort, toggleSuffix)}
      ${sortLink("Critical", "critical_7d", sort, toggleSuffix)}
      ${sortLink("Findings", "findings_7d", sort, toggleSuffix)}
      ${sortLink("PRs", "prs_reviewed", sort, toggleSuffix)}
      ${sortLink("Name", "repo", sort, toggleSuffix)}
    </div>`;

  const repoGrid = visibleRows.length === 0
    ? `<div class="card"><div class="empty">
         <div class="title">${rows.length === 0 ? "No repos recorded yet" : "No repos with reviewed PRs yet"}</div>
         <div>${rows.length === 0 ? "Open a PR in an installed repo to populate the database." : "Click “Show inactive” to see dormant installations."}</div>
       </div></div>`
    : `<div class="grid two">${visibleRows
        .map((r) => {
          const href = `/dashboard/repo/${encodeURIComponent(r.owner)}/${encodeURIComponent(r.repo)}`;
          const health = repoHealth(r.prs_reviewed, r.findings_7d, r.critical_7d);
          const series = buildDaySeries(activityByRepo.get(`${r.owner}/${r.repo}`) ?? [], 14);
          const idleCls = r.prs_reviewed === 0 ? " idle" : "";
          const critStat = r.critical_7d > 0
            ? `<span class="stat"><span class="n crit">${r.critical_7d}</span> critical · 7d</span>`
            : `<span class="stat"><span class="n zero">0</span> critical · 7d</span>`;
          const findStat = r.findings_7d > 0
            ? `<span class="stat"><span class="n">${r.findings_7d}</span> findings · 7d</span>`
            : `<span class="stat"><span class="n zero">0</span> findings · 7d</span>`;
          const prStat = `<span class="stat"><span class="n${r.prs_reviewed === 0 ? " zero" : ""}">${r.prs_reviewed}</span> PRs reviewed</span>`;
          return `<a class="repo-card health-${health}${idleCls}" href="${esc(href)}">
            <div>
              <div class="title"><span class="owner">${esc(r.owner)}/</span>${esc(r.repo)}</div>
              <div class="meta">${prStat}${findStat}${critStat}</div>
            </div>
            <div class="right">
              <div class="when">${esc(relativeTime(r.last_review)) || "never"}</div>
            </div>
            ${miniSparkbar(series)}
          </a>`;
        })
        .join("")}</div>`;

  const heroLeft = card({
    title: "Activity · last 14 days",
    subtitle: `${aggregate.reduce((n, d) => n + d.critical + d.major + d.minor + d.nit, 0)} findings across all repos`,
    bodyClass: "chart",
    body: stackedSeverityBar(aggregate),
  });

  const heroRight = `<div class="grid stack">
    ${metric({
      label: "Critical · 7D",
      value: totals.critical,
      tone: totals.critical > 0 ? "danger" : undefined,
      hero: true,
      foot: totals.critical > 0
        ? `<span class="chip danger uppercase"><span class="dot"></span>needs attention</span>`
        : `<span class="chip good uppercase"><span class="dot"></span>clean</span>`,
    })}
    <div class="grid three" style="gap:10px">
      ${metric({ label: "Active repos", value: totals.active })}
      ${metric({ label: "PRs reviewed", value: totals.prs })}
      ${metric({ label: "Findings · 7D", value: totals.findings })}
    </div>
  </div>`;

  return renderLayout({
    title: "Overview",
    crumbs: [{ label: "Repos" }],
    active: "overview",
    body: `
      ${pageHeader({
        title: "Overview",
        subtitle: `${totals.active} active · ${totals.repos} installed · rolling 7-day stats`,
        right: filterLink,
      })}
      <div class="grid hero" style="margin-bottom:20px">
        ${heroLeft}
        ${heroRight}
      </div>
      <div style="display:flex;align-items:center;justify-content:space-between;margin:8px 2px 12px">
        <h2 style="font-size:13px;font-weight:600;color:var(--text);letter-spacing:-0.005em">Repositories</h2>
        ${sortControls}
      </div>
      ${repoGrid}
    `,
  });
}

// ─── Repo detail ─────────────────────────────────────────────────────

interface RepoDetailArgs {
  owner: string;
  repo: string;
  sparkline: SparklinePoint[];
  hotPaths: ReturnType<typeof getHotPaths>;
  topRules: ReturnType<typeof getTopRules>;
  prs: ReturnType<typeof getRecentPRsWithReviews>;
  issues: ReturnType<typeof getRecentIssues>;
  activity: DayBin[];
  approvalMix: ReturnType<typeof getApprovalMix>;
  learnings: Learning[];
  configYaml: string | null;
  csrfToken: string;
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

function renderRepoDetail(a: RepoDetailArgs): string {
  const title = `${a.owner}/${a.repo}`;
  const latestPR = a.prs[0] ?? null;
  const latestRisk = latestPR ? riskBadge(latestPR.latest_risk_level, latestPR.latest_risk_score) : "";
  const findingsTotal = a.activity.reduce((n, d) => n + d.critical + d.major + d.minor + d.nit, 0);

  // Hot paths as horizontal bars — single chart
  const hotPathsMax = Math.max(1, ...a.hotPaths.map((p) => p.total));
  const hotPathsBody = a.hotPaths.length === 0
    ? `<div class="empty"><div class="title">No hot paths</div><div>No critical or major findings in the last 90 days.</div></div>`
    : a.hotPaths
        .map((p) =>
          hbar({
            label: p.path,
            critical: p.critical,
            major: p.major,
            total: p.total,
            max: hotPathsMax,
          }),
        )
        .join("");

  // Top firing rules as compact list
  const topRulesBody = a.topRules.length === 0
    ? `<div class="empty"><div class="title">No rule hits</div><div>Pattern rules haven't matched anything here yet.</div></div>`
    : `<table class="tbl">
         <thead><tr>
           <th>Rule</th><th>Source</th><th class="num">Hits</th><th class="right">Example</th>
         </tr></thead>
         <tbody>
           ${a.topRules
             .map(
               (r) => `<tr>
                 <td class="mono">${esc(r.rule_name)}</td>
                 <td class="muted">${esc(r.source)}</td>
                 <td class="num strong">${r.hits}</td>
                 <td class="right">${
                   r.example_pr
                     ? `<a class="link mono" href="/dashboard/repo/${encodeURIComponent(a.owner)}/${encodeURIComponent(a.repo)}/pr/${r.example_pr}">#${r.example_pr}</a>`
                     : `<span class="muted">—</span>`
                 }</td>
               </tr>`,
             )
             .join("")}
         </tbody>
       </table>`;

  // Recent PRs — one row per PR, aggregated across all review iterations
  const prsBody = a.prs.length === 0
    ? `<div class="empty"><div class="title">No reviews recorded yet</div><div>Open a PR to get one.</div></div>`
    : `<div class="tl">${a.prs
        .map((pr) => {
          const href = `/dashboard/repo/${encodeURIComponent(a.owner)}/${encodeURIComponent(a.repo)}/pr/${pr.number}`;
          const worst = (pr.worst_severity ?? "").toLowerCase();
          const sevCls =
            worst === "critical" ? "sev-critical"
            : worst === "major" ? "sev-major"
            : worst === "minor" ? "sev-minor"
            : pr.latest_approval === "approve" ? "approve"
            : "";
          const findingsChip = pr.total_findings > 0
            ? `<span class="chip neutral tnum">${pr.total_findings} finding${pr.total_findings === 1 ? "" : "s"}</span>`
            : `<span class="chip muted uppercase">clean</span>`;
          const iterChip = pr.review_count > 1
            ? `<span class="chip muted uppercase" title="${pr.review_count} review iterations">${pr.review_count}× reviews</span>`
            : "";
          return `<div class="tl-item ${sevCls}">
            <div class="when">${esc(relativeTime(pr.latest_at))}</div>
            <div class="dot"></div>
            <div class="body">
              <div class="row1">
                <a class="title" href="${esc(href)}">${esc(pr.title ?? `#${pr.number}`)}</a>
                <span class="mono muted">#${pr.number}</span>
              </div>
              <div class="row2">
                ${riskBadge(pr.latest_risk_level, pr.latest_risk_score)}
                ${approvalBadge(pr.latest_approval)}
                ${findingsChip}
                ${iterChip}
                ${pr.author ? `<span class="mono author">@${esc(pr.author)}</span>` : ""}
              </div>
            </div>
          </div>`;
        })
        .join("")}</div>`;

  // Approval donut
  const approveN = a.approvalMix.find((m) => (m.approval ?? "").toLowerCase() === "approve")?.count ?? 0;
  const changesN = a.approvalMix.find((m) => (m.approval ?? "").toLowerCase() === "request_changes")?.count ?? 0;
  const commentN = a.approvalMix.find((m) => ["comment", "commented", "", null].includes((m.approval ?? "").toLowerCase()))?.count ?? 0;
  const approvalBody = (approveN + changesN + commentN) === 0
    ? `<div class="empty"><div class="title">No reviews yet</div><div>Approval ratio will appear after the first review.</div></div>`
    : donut([
        { label: "Changes requested", value: changesN, color: "#fb6d82" },
        { label: "Commented", value: commentN, color: "#9aa0b2" },
        { label: "Approved", value: approveN, color: "#4ade80" },
      ]);

  const gitHubAction = `<a href="https://github.com/${esc(a.owner)}/${esc(a.repo)}" class="btn btn-ghost" target="_blank" rel="noopener">${ICON.github}Open in GitHub</a>`;

  const heroSubtitle = latestPR
    ? `Last review ${esc(relativeTime(latestPR.latest_at))} · ${esc(String(latestPR.total_findings))} finding${latestPR.total_findings === 1 ? "" : "s"}`
    : `No reviews yet`;

  const body = `
    ${pageHeader({
      title,
      subtitle: heroSubtitle,
      right: `${latestRisk}${gitHubAction}`,
    })}

    <div class="grid hero" style="margin-bottom:16px">
      ${card({
        title: "Findings · last 30 days",
        subtitle: `${findingsTotal} across ${a.activity.filter((d) => d.reviews > 0).length} active days`,
        bodyClass: "chart",
        body: stackedSeverityBar(a.activity),
      })}
      <div class="grid stack">
        ${card({
          title: "Risk score · 90d",
          subtitle: `${a.sparkline.length} review${a.sparkline.length === 1 ? "" : "s"}`,
          bodyClass: "chart",
          body: riskLine(a.sparkline),
        })}
        ${card({
          title: "Approval mix · 30d",
          body: approvalBody,
        })}
      </div>
    </div>

    <div class="grid two" style="margin-bottom:16px">
      ${card({
        title: "Hot paths",
        subtitle: "Critical + major · last 90 days",
        bodyClass: "flush",
        body: hotPathsBody,
      })}
      ${card({
        title: "Top firing rules",
        subtitle: "All time",
        bodyClass: "flush",
        body: topRulesBody,
      })}
    </div>

    ${card({
      title: "Recent PRs",
      subtitle: `Latest ${a.prs.length} · grouped by PR`,
      bodyClass: "flush",
      body: prsBody,
    })}

    <div style="margin-top:16px">
      ${card({
        title: "Recent issues",
        subtitle: a.issues.length > 0
          ? `${a.issues.length} tracked · DiffSentry actions across each thread`
          : `Issue activity will appear once the bot triages or replies on one`,
        bodyClass: "flush",
        body: renderIssuesTimeline(a.owner, a.repo, a.issues),
      })}
    </div>

    <div class="grid two" style="margin-top:16px">
      ${renderLearningsCard(a.owner, a.repo, a.learnings, a.csrfToken)}
      ${renderConfigCard(a.configYaml)}
    </div>
  `;

  return renderLayout({
    title,
    crumbs: [
      { label: "Repos", href: "/dashboard" },
      { label: `${a.owner}/${a.repo}` },
    ],
    active: "overview",
    body,
  });
}

function renderLearningsCard(owner: string, repo: string, learnings: Learning[], csrfToken: string): string {
  const action = (id: string, verb: "delete" | "edit") =>
    `/dashboard/repo/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/learnings/${encodeURIComponent(id)}/${verb}`;
  const csrfInput = `<input type="hidden" name="_csrf" value="${esc(csrfToken)}"/>`;

  const body = learnings.length === 0
    ? `<div class="empty"><div class="title">No learnings yet</div><div>Use <span class="mono" style="color:var(--accent-bright)">@bot learn …</span> on a PR to teach the reviewer.</div></div>`
    : `<ul id="learnings" style="list-style:none;margin:0;padding:0;max-height:420px;overflow:auto">
         ${learnings
           .map((l) => {
             const editForm = `
               <details style="margin-top:8px">
                 <summary class="btn btn-link" style="font-size:11px;color:var(--text-3);cursor:pointer;list-style:none;padding:0">edit</summary>
                 <form method="post" action="${esc(action(l.id, "edit"))}" style="margin-top:8px;display:grid;gap:6px">
                   ${csrfInput}
                   <textarea name="content" rows="3" style="width:100%;font-family:var(--font-mono);font-size:12px;background:var(--bg-deep);color:var(--text-1);border:1px solid var(--line);border-radius:4px;padding:6px;resize:vertical">${esc(l.content)}</textarea>
                   <input name="path" value="${esc(l.path ?? "")}" placeholder="Optional file glob (e.g. static/sales-app/**)" style="width:100%;font-family:var(--font-mono);font-size:11.5px;background:var(--bg-deep);color:var(--text-1);border:1px solid var(--line);border-radius:4px;padding:5px 6px"/>
                   <div style="display:flex;justify-content:flex-end">
                     <button type="submit" class="btn btn-ghost" style="font-size:11px">Save</button>
                   </div>
                 </form>
               </details>`;
             const deleteForm = `
               <form method="post" action="${esc(action(l.id, "delete"))}" style="margin:0">
                 ${csrfInput}
                 <button type="submit" class="btn btn-link" style="font-size:11px;color:var(--text-3)" title="Delete this learning" onclick="return confirm('Delete this learning?')">delete</button>
               </form>`;
             return `<li style="display:grid;grid-template-columns:68px 1fr auto;gap:12px;padding:10px 14px;border-bottom:1px solid var(--line-soft);font-size:13px;align-items:start">
               <span class="mono muted" style="font-size:10.5px;padding-top:2px">${esc(relativeTime(l.createdAt))}</span>
               <div style="min-width:0">
                 ${l.path ? `<div class="mono muted" style="font-size:11px;margin-bottom:3px">${esc(l.path)}</div>` : ""}
                 <div style="color:var(--text-1);word-break:break-word">${esc(l.content)}</div>
                 ${editForm}
               </div>
               ${deleteForm}
             </li>`;
           })
           .join("")}
       </ul>`;
  return card({
    title: `Learnings (${learnings.length})`,
    subtitle: "From @bot learn",
    bodyClass: "flush",
    body,
  });
}

function renderConfigCard(yaml: string | null): string {
  if (yaml === null) {
    return card({
      title: ".diffsentry.yaml",
      subtitle: "Repo defaults",
      body: `<div class="empty"><div class="title">Using defaults</div><div>No <span class="mono">.diffsentry.yaml</span> in this repo.</div></div>`,
    });
  }
  return card({
    title: ".diffsentry.yaml",
    subtitle: "Cached 5m from GitHub",
    body: `<pre style="font-family:var(--font-mono);font-size:11.5px;color:var(--text-1);background:var(--bg-deep);border:1px solid var(--line);border-radius:6px;padding:12px;max-height:320px;overflow:auto;margin:0;white-space:pre">${esc(yaml)}</pre>`,
  });
}

// ─── Issues ──────────────────────────────────────────────────────────

const ISSUE_ACTION_LABELS: Record<string, string> = {
  auto_summary: "auto-summary",
  summary_regen: "summary regen",
  plan: "plan",
  chat: "chat reply",
  learn: "learning saved",
  paused: "paused",
  resumed: "resumed",
  help: "help posted",
  config: "config posted",
  needs_detail: "needs detail",
};

function issueActionLabel(action: string | null): string {
  if (!action) return "—";
  return ISSUE_ACTION_LABELS[action] ?? action.replace(/_/g, " ");
}

function issueStateClass(state: string | null | undefined): string {
  const k = (state ?? "").toLowerCase();
  if (k === "open") return "good";
  if (k === "closed") return "muted";
  return "muted";
}

function renderIssuesTimeline(owner: string, repo: string, issues: ReturnType<typeof getRecentIssues>): string {
  if (issues.length === 0) {
    return `<div class="empty"><div class="title">No issue activity yet</div><div>The bot hasn't triaged or replied on an issue in this repo.</div></div>`;
  }
  return `<div class="tl">${issues
    .map((iss) => {
      const href = `/dashboard/repo/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issue/${iss.number}`;
      const action = (iss.last_action_kind ?? "").toLowerCase();
      const dotCls =
        action === "auto_summary" || action === "summary_regen" ? "approve"
        : action === "plan" ? "sev-minor"
        : action === "needs_detail" ? "sev-major"
        : "";
      const stateChip = iss.state
        ? `<span class="chip ${issueStateClass(iss.state)} uppercase">${esc(iss.state)}</span>`
        : "";
      const actionChip = iss.last_action_kind
        ? `<span class="chip neutral uppercase">${esc(issueActionLabel(iss.last_action_kind))}</span>`
        : `<span class="chip muted uppercase">no action</span>`;
      const actionCountChip = iss.action_count > 1
        ? `<span class="chip muted uppercase" title="${iss.action_count} bot interactions">${iss.action_count}× actions</span>`
        : "";
      const commentChip = iss.comment_count > 0
        ? `<span class="chip muted tnum">${iss.comment_count} comment${iss.comment_count === 1 ? "" : "s"}</span>`
        : "";
      const when = iss.last_action_at ?? iss.first_seen_at;
      return `<div class="tl-item ${dotCls}">
        <div class="when">${esc(relativeTime(when))}</div>
        <div class="dot"></div>
        <div class="body">
          <div class="row1">
            <a class="title" href="${esc(href)}">${esc(iss.title ?? `#${iss.number}`)}</a>
            <span class="mono muted">#${iss.number}</span>
          </div>
          <div class="row2">
            ${stateChip}
            ${actionChip}
            ${commentChip}
            ${actionCountChip}
            ${iss.author ? `<span class="mono author">@${esc(iss.author)}</span>` : ""}
          </div>
        </div>
      </div>`;
    })
    .join("")}</div>`;
}

interface IssueDetailArgs {
  owner: string;
  repo: string;
  number: number;
  issue: NonNullable<ReturnType<typeof getIssue>>;
  events: ReturnType<typeof getIssueEvents>;
}

function renderIssueDetail(a: IssueDetailArgs): string {
  const ghUrl = a.issue.url ?? `https://github.com/${a.owner}/${a.repo}/issues/${a.number}`;
  const stateChip = a.issue.state
    ? `<span class="chip ${issueStateClass(a.issue.state)} uppercase">${esc(a.issue.state)}</span>`
    : "";
  const labels = (() => {
    try {
      const parsed = a.issue.labels_json ? JSON.parse(a.issue.labels_json) : [];
      if (!Array.isArray(parsed)) return [] as string[];
      return parsed.filter((x): x is string => typeof x === "string");
    } catch {
      return [] as string[];
    }
  })();

  const subtitle = `<span class="mono" style="color:var(--text-2)">${esc(a.owner)}/${esc(a.repo)}</span> <span style="color:var(--text-4)">·</span> <span class="mono">#${a.number}</span>${a.issue.author ? ` <span style="color:var(--text-4)">·</span> <span class="mono" style="color:var(--accent-bright)">@${esc(a.issue.author)}</span>` : ""} ${stateChip}`;

  const header = pageHeader({
    title: a.issue.title ?? `Issue #${a.number}`,
    subtitle,
    right: `<a href="${esc(ghUrl)}" class="btn btn-ghost" target="_blank" rel="noopener">${ICON.github}Open in GitHub</a>`,
  });

  const overviewBody = `<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px">
      ${stateChip}
      ${a.issue.last_action_kind ? `<span class="chip neutral uppercase">last: ${esc(issueActionLabel(a.issue.last_action_kind))}</span>` : ""}
      ${labels.map((l) => `<span class="chip muted uppercase">${esc(l)}</span>`).join("")}
    </div>
    <dl class="kv">
      <div><dt>Bot actions</dt><dd>${a.issue.action_count}</dd></div>
      <div><dt>Comments</dt><dd>${a.issue.comment_count}</dd></div>
      <div><dt>Opened</dt><dd>${esc(a.issue.created_at?.slice(0, 10) ?? "—")}</dd></div>
      <div><dt>First seen</dt><dd>${esc(relativeTime(a.issue.first_seen_at))}</dd></div>
      <div><dt>Last action</dt><dd>${esc(a.issue.last_action_at ? relativeTime(a.issue.last_action_at) : "—")}</dd></div>
    </dl>`;

  const summaryCard = a.issue.last_summary
    ? card({
        title: "Latest triage summary",
        subtitle: `Auto-generated · regenerable with @bot summary`,
        body: `<div data-md-wrap>
          <div class="md-body md-rendered" style="max-height:420px;overflow:auto">${renderMarkdown(a.issue.last_summary)}</div>
        </div>`,
      })
    : "";

  const planCard = a.issue.last_plan
    ? card({
        title: "Latest implementation plan",
        subtitle: `From @bot plan`,
        body: `<div data-md-wrap>
          <div class="md-body md-rendered" style="max-height:420px;overflow:auto">${renderMarkdown(a.issue.last_plan)}</div>
        </div>`,
      })
    : "";

  const bodyCard = a.issue.body
    ? card({
        title: "Issue body",
        subtitle: a.issue.body.length > 4000 ? `${a.issue.body.length.toLocaleString()} chars · truncated` : undefined,
        body: `<div class="md-body md-rendered" style="max-height:420px;overflow:auto">${renderMarkdown(a.issue.body.slice(0, 8000))}</div>`,
      })
    : "";

  const eventsBody = a.events.length === 0
    ? `<div class="empty"><div class="title">No bot events yet</div><div>This issue was persisted but the bot hasn't acted on it.</div></div>`
    : `<ul style="list-style:none;margin:0;padding:0;max-height:420px;overflow:auto">
         ${a.events
           .map((ev) => {
             const action = ev.kind.replace(/^issue\./, "");
             return `<li style="display:flex;align-items:center;justify-content:space-between;padding:7px 14px;border-bottom:1px solid var(--line-soft);font-size:12.5px">
               <span class="mono" style="color:var(--text-1)">${esc(issueActionLabel(action))}</span>
               <span class="mono muted" style="font-size:10.5px">${esc(relativeTime(ev.ts))}</span>
             </li>`;
           })
           .join("")}
       </ul>`;

  const body = `
    ${header}
    <div class="grid stack">
      ${card({ title: "Overview", body: overviewBody })}
      ${summaryCard}
      ${planCard}
      ${bodyCard}
      ${card({
        title: "Bot activity",
        subtitle: `${a.events.length} action${a.events.length === 1 ? "" : "s"} on this issue`,
        bodyClass: "flush",
        body: eventsBody,
      })}
    </div>
  `;

  return renderLayout({
    title: `${a.owner}/${a.repo} #${a.number}`,
    crumbs: [
      { label: "Repos", href: "/dashboard" },
      { label: `${a.owner}/${a.repo}`, href: `/dashboard/repo/${encodeURIComponent(a.owner)}/${encodeURIComponent(a.repo)}` },
      { label: `#${a.number}` },
    ],
    active: "overview",
    body,
  });
}

// ─── PR detail ───────────────────────────────────────────────────────

interface PRDetailArgs {
  owner: string;
  repo: string;
  number: number;
  pr: ReturnType<typeof getPR>;
  reviews: ReturnType<typeof getPRReviews>;
  latest: ReturnType<typeof getPRReviews>[number] | null;
  findings: ReturnType<typeof getFindingsForPR>;
  events: ReturnType<typeof getEvents>;
}

function renderPRDetail(a: PRDetailArgs): string {
  const ghUrl = `https://github.com/${a.owner}/${a.repo}/pull/${a.number}`;
  const stateChip = a.pr?.state
    ? `<span class="chip ${a.pr.state === "open" ? "good" : "muted"} uppercase">${esc(a.pr.state)}</span>`
    : "";

  const subtitle = `<span class="mono" style="color:var(--text-2)">${esc(a.owner)}/${esc(a.repo)}</span> <span style="color:var(--text-4)">·</span> <span class="mono">#${a.number}</span>${a.pr?.author ? ` <span style="color:var(--text-4)">·</span> <span class="mono" style="color:var(--accent-bright)">@${esc(a.pr.author)}</span>` : ""} ${stateChip}`;

  const header = pageHeader({
    title: a.pr?.title ?? `PR #${a.number}`,
    subtitle,
    right: `<a href="${esc(ghUrl)}" class="btn btn-ghost" target="_blank" rel="noopener">${ICON.github}Open in GitHub</a>`,
  });

  const latestBody = a.latest
    ? `<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px">
         ${riskBadge(a.latest.risk_level, a.latest.risk_score)}
         <span class="chip neutral uppercase">${esc(a.latest.profile ?? "—")}</span>
         ${approvalBadge(a.latest.approval)}
       </div>
       <dl class="kv">
         <div><dt>Files processed</dt><dd>${a.latest.files_processed ?? 0}</dd></div>
         <div><dt>Findings</dt><dd>${a.latest.finding_count}</dd></div>
         <div><dt>Skipped · similar</dt><dd>${a.latest.files_skipped_similar ?? 0}</dd></div>
         <div><dt>Skipped · trivial</dt><dd>${a.latest.files_skipped_trivial ?? 0}</dd></div>
       </dl>
       ${
         a.latest.summary
           ? `<div style="margin-top:14px;padding-top:14px;border-top:1px solid var(--line-soft)">
                <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
                  <div class="chip muted uppercase">Summary</div>
                  <button type="button" class="btn btn-link" style="font-size:11px" onclick="var m=this.closest('[data-md-wrap]'); m.classList.toggle('show-raw');">toggle raw</button>
                </div>
                <div data-md-wrap>
                  <div class="md-body md-rendered" style="max-height:320px;overflow:auto">${renderMarkdown(a.latest.summary)}</div>
                  <pre class="md-raw mono" style="display:none;font-size:11.5px;white-space:pre-wrap;color:var(--text-1);line-height:1.55;max-height:320px;overflow:auto;margin:0">${esc(a.latest.summary)}</pre>
                </div>
              </div>`
           : ""
       }`
    : `<div class="empty"><div class="title">No reviews for this PR</div><div>Trigger a review to get started.</div></div>`;

  const latestCard = a.latest
    ? card({
        title: "Latest review",
        subtitle: `${esc((a.latest.sha ?? "").slice(0, 7))} · ${esc(relativeTime(a.latest.created_at))}`,
        body: latestBody,
      })
    : `<div class="card">${latestBody}</div>`;

  const latestReviewId = a.latest?.id ?? null;
  const findingsBody = a.findings.length === 0
    ? `<div class="empty"><div class="title">No findings</div><div>Nothing flagged across any review of this PR.</div></div>`
    : `<table class="tbl rail">
         <thead><tr>
           <th>Severity</th><th>Location</th><th>Title</th><th>Review</th><th>Source</th>
         </tr></thead>
         <tbody>
           ${a.findings
             .map(
               (f) => {
                 const isLatest = latestReviewId !== null && f.review_id === latestReviewId;
                 const sha = (f.review_sha ?? "").slice(0, 7);
                 const reviewCell = `<span class="mono" style="color:${isLatest ? "var(--accent-bright)" : "var(--text-3)"}" title="${esc(f.review_at)}">${esc(sha || "—")}</span>${isLatest ? ` <span class="chip muted uppercase" style="margin-left:4px">latest</span>` : ` <span class="muted" style="font-size:10.5px;margin-left:4px">${esc(relativeTime(f.review_at))}</span>`}`;
                 return `<tr data-sev="${esc((f.severity ?? "").toLowerCase())}">
                   <td>${severityBadge(f.severity)}</td>
                   <td class="mono">${esc(f.path ?? "")}${f.line ? `<span class="line-num">:${f.line}</span>` : ""}</td>
                   <td>
                     <div class="strong">${esc(f.title ?? "—")}</div>
                     ${f.body ? `<details style="margin-top:4px"><summary style="font-size:11px;color:var(--text-3);cursor:pointer">Show rendered body</summary><div class="md-body" style="margin-top:8px;padding-left:12px;border-left:2px solid var(--line)">${renderMarkdown(f.body.slice(0, 4000))}</div></details>` : ""}
                   </td>
                   <td class="nowrap">${reviewCell}</td>
                   <td class="muted">${esc(f.source ?? "—")}</td>
                 </tr>`;
               },
             )
             .join("")}
         </tbody>
       </table>`;

  const allReviewsBody = a.reviews.length <= 1
    ? ""
    : card({
        title: `All reviews (${a.reviews.length})`,
        bodyClass: "flush",
        body: `<table class="tbl">
          <thead><tr>
            <th class="right">When</th><th>SHA</th><th>Profile</th><th>Risk</th><th class="num">Findings</th><th>Approval</th>
          </tr></thead>
          <tbody>
            ${a.reviews
              .map(
                (rv) => `<tr>
                  <td class="right muted">${esc(relativeTime(rv.created_at))}</td>
                  <td class="mono" style="color:var(--accent-bright)">${esc((rv.sha ?? "").slice(0, 7))}</td>
                  <td class="muted">${esc(rv.profile ?? "—")}</td>
                  <td>${riskBadge(rv.risk_level, rv.risk_score)}</td>
                  <td class="num ${rv.finding_count > 0 ? "strong" : "zero"}">${rv.finding_count}</td>
                  <td>${approvalBadge(rv.approval)}</td>
                </tr>`,
              )
              .join("")}
          </tbody>
        </table>`,
      });

  const eventsBody = a.events.length === 0
    ? `<div class="empty"><div class="title">No events</div><div>PR hooks haven't fired yet.</div></div>`
    : `<ul style="list-style:none;margin:0;padding:0;max-height:380px;overflow:auto">
         ${a.events
           .map(
             (ev) => `<li style="display:flex;align-items:center;justify-content:space-between;padding:7px 14px;border-bottom:1px solid var(--line-soft);font-size:12.5px">
               <span class="mono" style="color:var(--text-1)">${esc(ev.kind)}</span>
               <span class="mono muted" style="font-size:10.5px">${esc(relativeTime(ev.ts))}</span>
             </li>`,
           )
           .join("")}
       </ul>`;

  const body = `
    ${header}
    <div class="grid stack">
      ${latestCard}
      ${card({
        title: "Findings",
        subtitle: a.findings.length > 0
          ? `${a.findings.length} across ${a.reviews.length} review${a.reviews.length === 1 ? "" : "s"}`
          : undefined,
        bodyClass: "flush",
        body: findingsBody,
      })}
      ${allReviewsBody}
      ${card({
        title: "Events",
        subtitle: `${a.events.length} most recent`,
        bodyClass: "flush",
        body: eventsBody,
      })}
    </div>
  `;

  return renderLayout({
    title: `${a.owner}/${a.repo} #${a.number}`,
    crumbs: [
      { label: "Repos", href: "/dashboard" },
      { label: `${a.owner}/${a.repo}`, href: `/dashboard/repo/${encodeURIComponent(a.owner)}/${encodeURIComponent(a.repo)}` },
      { label: `#${a.number}` },
    ],
    active: "overview",
    body,
  });
}

// ─── Error pages ─────────────────────────────────────────────────────

function renderNotFound(msg: string): string {
  return renderLayout({
    title: "Not found",
    active: "",
    body: `<div class="card"><div class="empty">
      <div class="mono" style="color:var(--text-3);font-size:11px;letter-spacing:0.12em;margin-bottom:8px">404 · NOT FOUND</div>
      <div class="title">${esc(msg)}</div>
      <div style="margin-top:14px"><a href="/dashboard" class="btn btn-ghost">← Back to repos</a></div>
    </div></div>`,
  });
}

function renderError(msg: string): string {
  return renderLayout({
    title: "Error",
    active: "",
    body: `<div class="card tone-danger"><div class="card-body">
      <div style="display:flex;align-items:flex-start;gap:10px">
        <span style="color:var(--sev-crit);flex-shrink:0">${ICON.alert}</span>
        <div>
          <div style="color:var(--sev-crit);font-weight:600;font-size:13px">${esc(msg)}</div>
          <div class="muted" style="font-size:12px;margin-top:3px">Check server logs for details.</div>
        </div>
      </div>
    </div></div>`,
  });
}

// ─── Findings explorer ───────────────────────────────────────────────

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

  const activeFilterCount = [
    a.filters.severity,
    a.filters.source,
    a.filters.repo,
    a.filters.q,
    a.filters.fingerprint,
    a.filters.ageDays,
  ].filter((v) => v !== undefined && v !== "").length;

  const filterForm = `<form method="get" class="card">
    <div class="filterbar">
      <label class="field">Severity
        <select name="severity">
          ${selectOpt("", "any", a.filters.severity)}
          ${selectOpt("critical", "critical", a.filters.severity)}
          ${selectOpt("major", "major", a.filters.severity)}
          ${selectOpt("minor", "minor", a.filters.severity)}
          ${selectOpt("nit", "nit", a.filters.severity)}
        </select>
      </label>
      <label class="field">Source
        <select name="source">
          ${selectOpt("", "any", a.filters.source)}
          ${selectOpt("ai", "ai", a.filters.source)}
          ${selectOpt("safety", "safety", a.filters.source)}
          ${selectOpt("builtin", "builtin", a.filters.source)}
          ${selectOpt("custom", "custom", a.filters.source)}
        </select>
      </label>
      <label class="field">Repo
        <input name="repo" value="${esc(a.filters.repo ?? "")}" placeholder="owner/repo" />
      </label>
      <label class="field wide">Search path / title
        <input name="q" value="${esc(a.filters.q ?? "")}" placeholder="e.g. src/server" />
      </label>
      <label class="field">Age
        <select name="age">
          ${selectOpt("", "any", ageStr)}
          ${selectOpt("7", "7 days", ageStr)}
          ${selectOpt("30", "30 days", ageStr)}
          ${selectOpt("90", "90 days", ageStr)}
        </select>
      </label>
    </div>
    <input type="hidden" name="limit" value="${esc(String(limit))}" />
    <div class="filter-foot">
      <span class="hint">${activeFilterCount > 0 ? `${activeFilterCount} filter${activeFilterCount === 1 ? "" : "s"} active` : "No filters active"}</span>
      <div style="display:flex;gap:8px">
        <a href="/dashboard/findings" class="btn btn-link">Clear</a>
        <button type="submit" class="btn btn-primary">Apply filters</button>
      </div>
    </div>
  </form>`;

  const fingerprintClause = a.filters.fingerprint
    ? card({
        tone: "accent",
        bodyClass: "tight",
        body: `<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:12.5px">
          <span>Filtering by fingerprint <span class="mono" style="color:var(--accent-bright)">${esc(a.filters.fingerprint)}</span></span>
          <a href="/dashboard/findings${queryStringFromFilters(a.filters, { fingerprint: undefined })}" class="btn btn-link">Clear fingerprint</a>
        </div>`,
      })
    : "";

  const groupsCard = a.groups.length === 0
    ? ""
    : card({
        title: "Recurring fingerprints",
        subtitle: `${a.groups.length} groups · 2+ occurrences`,
        bodyClass: "flush",
        body: `<table class="tbl">
          <thead><tr>
            <th>Fingerprint</th><th>Title</th><th>Severity</th><th class="num">Occurrences</th><th class="num">Repos</th><th class="right">Last seen</th>
          </tr></thead>
          <tbody>
            ${a.groups
              .map((g) => {
                const href = `/dashboard/findings${queryStringFromFilters(a.filters, { fingerprint: g.fingerprint })}`;
                return `<tr>
                  <td><a class="link mono" href="${esc(href)}">${esc(g.fingerprint)}</a></td>
                  <td class="truncate" style="max-width:36ch">${esc(g.title ?? "—")}</td>
                  <td>${severityBadge(g.severity)}</td>
                  <td class="num strong">${g.occurrences}</td>
                  <td class="num">${g.repos}</td>
                  <td class="right muted">${esc(relativeTime(g.last_seen))}</td>
                </tr>`;
              })
              .join("")}
          </tbody>
        </table>`,
      });

  const tableCard = a.rows.length === 0
    ? `<div class="card"><div class="empty">
         <div class="title">No findings match these filters</div>
         <div>Loosen a filter or <a class="link" href="/dashboard/findings">clear all</a>.</div>
       </div></div>`
    : card({
        title: "Findings",
        subtitle: `${a.rows.length} shown · ${a.total} total`,
        bodyClass: "flush",
        body: `<table class="tbl rail">
          <thead><tr>
            <th class="right">When</th><th>Repo</th><th>PR</th><th>Severity</th><th>Location</th><th>Title</th><th>Source</th>
          </tr></thead>
          <tbody>
            ${a.rows
              .map((r) => {
                const prHref = `/dashboard/repo/${encodeURIComponent(r.owner)}/${encodeURIComponent(r.repo)}/pr/${r.number}`;
                const repoHref = `/dashboard/repo/${encodeURIComponent(r.owner)}/${encodeURIComponent(r.repo)}`;
                return `<tr data-sev="${esc((r.severity ?? "").toLowerCase())}">
                  <td class="right muted mono nowrap">${esc(relativeTime(r.created_at))}</td>
                  <td><a class="link" href="${esc(repoHref)}">${esc(r.owner)}/${esc(r.repo)}</a></td>
                  <td><a class="link mono" href="${esc(prHref)}">#${r.number}</a></td>
                  <td>${severityBadge(r.severity)}</td>
                  <td class="mono truncate" style="max-width:32ch">${esc(r.path ?? "")}${r.line ? `<span class="line-num">:${r.line}</span>` : ""}</td>
                  <td class="truncate strong" style="max-width:40ch">${esc(r.title ?? "—")}</td>
                  <td class="muted">${esc(r.source ?? "—")}</td>
                </tr>`;
              })
              .join("")}
          </tbody>
        </table>`,
      });

  const prev = offset > 0
    ? `<a href="/dashboard/findings${queryStringFromFilters(a.filters, { offset: Math.max(0, offset - limit) })}" class="btn btn-ghost">← Prev</a>`
    : `<span class="btn btn-ghost disabled">← Prev</span>`;
  const next = offset + limit < a.total
    ? `<a href="/dashboard/findings${queryStringFromFilters(a.filters, { offset: offset + limit })}" class="btn btn-ghost">Next →</a>`
    : `<span class="btn btn-ghost disabled">Next →</span>`;
  const pager = a.total > limit
    ? `<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:12px;color:var(--text-3);padding:4px 2px">
         ${prev}
         <div class="mono">rows ${offset + 1}–${Math.min(a.total, offset + a.rows.length)} of ${a.total}</div>
         ${next}
       </div>`
    : "";

  const body = `
    ${pageHeader({
      title: "Findings",
      subtitle: `${a.total} total · filter across severities, sources, and repos. Grouped by fingerprint to spot repeat offenders.`,
    })}
    <div class="grid stack">
      ${filterForm}
      ${fingerprintClause}
      ${groupsCard}
      ${tableCard}
      ${pager}
    </div>
  `;

  return renderLayout({
    title: "Findings",
    crumbs: [{ label: "Repos", href: "/dashboard" }, { label: "Findings" }],
    active: "findings",
    body,
  });
}

// ─── Patterns ────────────────────────────────────────────────────────

function renderPatterns(rules: PatternRuleRow[]): string {
  const thirtyDayTotal = rules.reduce((n, r) => n + r.hits_30d, 0);
  const allTimeTotal = rules.reduce((n, r) => n + r.hits_total, 0);

  // Aggregate per rule across repos for the bar chart
  const byRule = new Map<string, { name: string; source: string; hits30: number; hitsAll: number }>();
  for (const r of rules) {
    const key = `${r.rule_name}||${r.source}`;
    const prev = byRule.get(key);
    if (prev) {
      prev.hits30 += r.hits_30d;
      prev.hitsAll += r.hits_total;
    } else {
      byRule.set(key, { name: r.rule_name, source: r.source, hits30: r.hits_30d, hitsAll: r.hits_total });
    }
  }
  const topRules = [...byRule.values()].sort((a, b) => b.hits30 - a.hits30 || b.hitsAll - a.hitsAll).slice(0, 10);
  const maxHits = Math.max(1, ...topRules.map((r) => r.hits30 || r.hitsAll));

  const distBody = topRules.length === 0
    ? `<div class="empty"><div class="title">No rule hits recorded yet</div><div>Pattern rules will show here once they match something.</div></div>`
    : topRules
        .map((r) => {
          const shown = r.hits30 || r.hitsAll;
          const pct = (shown / maxHits) * 100;
          return `<div class="hbar-row">
            <div class="label">
              <span class="path">${esc(r.name)}</span>
              <div class="hb-track">
                <div class="hb-seg ${r.hits30 > 0 ? "major" : ""}" style="width:${pct.toFixed(1)}%;background:${r.hits30 > 0 ? "var(--sev-major)" : "var(--text-4)"}"></div>
              </div>
            </div>
            <div class="num">${shown}</div>
          </div>`;
        })
        .join("");

  const tableCard = rules.length === 0
    ? `<div class="card"><div class="empty">
         <div class="title">No pattern-rule hits recorded yet</div>
         <div>Built-in rules, the safety scanner, and custom patterns will appear here once they fire.</div>
       </div></div>`
    : card({
        title: "Pattern rules",
        subtitle: `${rules.length} rules · ${thirtyDayTotal} hits · 30d · ${allTimeTotal} all time`,
        bodyClass: "flush",
        body: `<table class="tbl">
          <thead><tr>
            <th>Rule</th><th>Source</th><th>Repo</th><th class="num">Hits · 30d</th><th class="num">Hits · all time</th><th class="right">Last hit</th>
          </tr></thead>
          <tbody>
            ${rules
              .map((r) => {
                const repoHref = `/dashboard/repo/${encodeURIComponent(r.owner)}/${encodeURIComponent(r.repo)}`;
                return `<tr>
                  <td class="mono strong">${esc(r.rule_name)}</td>
                  <td><span class="chip ${r.source === "safety" ? "sev-crit" : r.source === "custom" ? "accent" : "muted"} uppercase">${esc(r.source)}</span></td>
                  <td><a class="link" href="${esc(repoHref)}">${esc(r.owner)}/${esc(r.repo)}</a></td>
                  <td class="num ${r.hits_30d > 0 ? "strong" : "zero"}">${r.hits_30d}</td>
                  <td class="num muted">${r.hits_total}</td>
                  <td class="right muted mono">${esc(relativeTime(r.last_hit))}</td>
                </tr>`;
              })
              .join("")}
          </tbody>
        </table>`,
      });

  const distCard = card({
    title: "Hit distribution",
    subtitle: "Top 10 rules · 30d (fallback all-time)",
    bodyClass: "flush",
    body: distBody,
  });

  const body = `
    ${pageHeader({
      title: "Pattern rules",
      subtitle: `Built-in, safety-scanner, and custom rules. Disable noisy ones in <span class="mono" style="color:var(--accent-bright)">.diffsentry.yaml</span>.`,
    })}
    <div class="grid stack">
      ${distCard}
      ${tableCard}
    </div>
  `;

  return renderLayout({
    title: "Patterns",
    crumbs: [{ label: "Repos", href: "/dashboard" }, { label: "Patterns" }],
    active: "patterns",
    body,
  });
}

// ─── Settings / health ───────────────────────────────────────────────

function bytesHuman(n: number | null): string {
  if (n === null) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

function renderSettings(c: HealthCounts, logs: LogEntry[] = []): string {
  const noteCard = card({
    tone: "accent",
    bodyClass: "tight",
    body: `<div style="display:flex;align-items:flex-start;gap:12px;padding:6px 2px">
      <span style="color:var(--accent-bright);flex-shrink:0;width:18px;height:18px">${ICON.check}</span>
      <div>
        <div style="color:var(--text);font-weight:600;font-size:13.5px;margin-bottom:2px">Operator-only surface</div>
        <div style="color:var(--text-2);font-size:12.5px">Gated behind <span class="mono" style="color:var(--accent-bright)">ENABLE_DASHBOARD=1</span> and GitHub OAuth. Only users in <span class="mono" style="color:var(--accent-bright)">DASHBOARD_ALLOWED_LOGINS</span> or member orgs can sign in.</div>
      </div>
    </div>`,
  });

  const providerCard = card({
    title: "Runtime",
    subtitle: "Process-level config",
    body: `<dl class="kv">
      <div><dt>AI provider</dt><dd>${esc(process.env.AI_PROVIDER ?? "anthropic")}</dd></div>
      <div><dt>Node</dt><dd class="mono">${esc(process.version)}</dd></div>
      <div><dt>Port</dt><dd>${esc(process.env.PORT ?? "3005")}</dd></div>
      <div><dt>Log level</dt><dd>${esc(process.env.LOG_LEVEL ?? "info")}</dd></div>
      <div><dt>Bot name</dt><dd>${esc(process.env.BOT_NAME ?? "diffsentry")}</dd></div>
      <div><dt>DB path</dt><dd class="mono">${esc(process.env.DB_PATH ?? "./data/diffsentry.db")}</dd></div>
    </dl>`,
  });

  const dbCard = card({
    title: "Storage",
    subtitle: `SQLite · ${bytesHuman(c.db_bytes)}`,
    body: `<dl class="kv">
      <div><dt>Repos</dt><dd>${c.repos}</dd></div>
      <div><dt>PRs</dt><dd>${c.prs}</dd></div>
      <div><dt>Reviews</dt><dd>${c.reviews}</dd></div>
      <div><dt>Findings</dt><dd>${c.findings}</dd></div>
      <div><dt>Issues</dt><dd>${c.issues}</dd></div>
      <div><dt>Pattern hits</dt><dd>${c.pattern_hits}</dd></div>
      <div><dt>Events</dt><dd>${c.events}</dd></div>
      <div><dt>DB size</dt><dd>${esc(bytesHuman(c.db_bytes))}</dd></div>
      <div><dt>Review span</dt><dd class="mono">${esc(c.oldest_review?.slice(0, 10) ?? "—")} → ${esc(c.newest_review?.slice(0, 10) ?? "—")}</dd></div>
    </dl>`,
  });

  const logCard = card({
    title: "Recent warnings & errors",
    subtitle: `${logs.length} entries · newest last`,
    bodyClass: "flush",
    body: logs.length === 0
      ? `<div class="empty"><div class="title">No warn/error entries</div><div>Nothing captured since startup.</div></div>`
      : logs
          .map(
            (e) => `<div class="logrow">
              <span class="ts">${esc(e.ts.slice(11, 19))}</span>
              <span class="lvl ${esc(e.level)}">${esc(e.level)}</span>
              <span class="msg">${esc(e.msg)}</span>
            </div>`,
          )
          .join(""),
  });

  return renderLayout({
    title: "Settings",
    crumbs: [{ label: "Repos", href: "/dashboard" }, { label: "Settings" }],
    active: "settings",
    body: `${pageHeader({
             title: "Settings",
             subtitle: "Runtime + storage health, plus a live error tail from this process.",
           })}
           <div class="grid stack">
             ${noteCard}
             <div class="grid two">${providerCard}${dbCard}</div>
             ${logCard}
           </div>`,
  });
}
