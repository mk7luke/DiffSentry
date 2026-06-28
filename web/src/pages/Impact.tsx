import { useState } from "react";
import type { ReactNode } from "react";
import { useCreateImpactShare, useImpact } from "../api/hooks";
import { useAuth } from "../auth/useAuth";
import { Breadcrumbs } from "../components/Shell";
import { Card } from "../components/primitives";
import { Donut, StackedSeverityBar } from "../components/charts";
import { EmptyState, QueryBoundary } from "../components/states";
import { CheckIcon, ClockIcon, ImpactIcon, RepeatIcon, ShieldIcon } from "../components/icons";
import { buildDaySeries, formatCompact, formatMinutesSaved, percentDelta, relativeTime } from "../lib/format";
import type { DayBin } from "../lib/format";
import type { ImpactReport, ImpactWindow } from "../api/types";

export const IMPACT_RANGES: { key: string; label: string }[] = [
  { key: "7d", label: "7D" },
  { key: "30d", label: "30D" },
  { key: "90d", label: "90D" },
  { key: "365d", label: "12M" },
  { key: "all", label: "All" },
];

// ── Period-over-period delta chip ──────────────────────────────────
function Delta({
  current,
  prev,
  goodWhenUp = true,
}: {
  current: number;
  prev: number | null | undefined;
  goodWhenUp?: boolean;
}) {
  if (prev == null) return null;
  const d = percentDelta(current, prev);
  if (d == null) {
    return current > 0 ? <span className="impact-delta new">▲ new</span> : null;
  }
  const rounded = Math.round(d);
  if (rounded === 0) return <span className="impact-delta flat">± 0%</span>;
  const up = d > 0;
  const good = up === goodWhenUp;
  return (
    <span className={`impact-delta ${good ? "good" : "bad"}`}>
      {up ? "▲" : "▼"} {Math.abs(rounded)}%
    </span>
  );
}

function StatCard({
  label,
  value,
  sub,
  delta,
}: {
  label: string;
  value: string;
  sub?: string;
  delta?: ReactNode;
}) {
  return (
    <div className="impact-stat">
      <div className="impact-stat-label">{label}</div>
      <div className="impact-stat-value">{value}</div>
      <div className="impact-stat-foot">
        {sub ? <span className="impact-stat-sub">{sub}</span> : <span />}
        {delta}
      </div>
    </div>
  );
}

// Daily severity bins → a readable series; long ranges bucket into ~weekly bars.
function buildTrendSeries(report: ImpactReport): DayBin[] {
  // Anchor on the report's own `until` timestamp (not the browser clock) so the
  // trend window stays aligned with the backend metrics even on a skewed clock
  // or a page left open across a day boundary on cached data.
  const until = new Date(report.range.until || report.generatedAt);
  let days: number;
  if (report.range.days != null) {
    days = report.range.days;
  } else if (report.trend.length === 0) {
    days = 30;
  } else {
    const first = Date.parse(`${report.trend[0].day}T00:00:00Z`);
    days = Math.max(7, Math.round((until.getTime() - first) / 86_400_000) + 1);
  }
  let series = buildDaySeries(report.trend, Math.min(days, 3660), until);
  if (series.length > 92) {
    const size = Math.ceil(series.length / 90);
    const out: DayBin[] = [];
    for (let i = 0; i < series.length; i += size) {
      const slice = series.slice(i, i + size);
      out.push(
        slice.reduce(
          (acc, b) => {
            acc.reviews += b.reviews;
            acc.critical += b.critical;
            acc.major += b.major;
            acc.minor += b.minor;
            acc.nit += b.nit;
            return acc;
          },
          { day: slice[0].day, reviews: 0, critical: 0, major: 0, minor: 0, nit: 0 },
        ),
      );
    }
    series = out;
  }
  return series;
}

function AcceptanceBar({ w }: { w: ImpactWindow }) {
  const total = w.accepted + w.dismissed + w.pending;
  const pct = (n: number) => (total === 0 ? 0 : (n / total) * 100);
  return (
    <div className="impact-accept">
      <div className="impact-accept-track" role="img" aria-label="Fix acceptance breakdown">
        {w.accepted > 0 && <div className="seg accepted" style={{ width: `${pct(w.accepted).toFixed(1)}%` }} />}
        {w.dismissed > 0 && <div className="seg dismissed" style={{ width: `${pct(w.dismissed).toFixed(1)}%` }} />}
        {w.pending > 0 && <div className="seg pending" style={{ width: `${pct(w.pending).toFixed(1)}%` }} />}
      </div>
      <div className="impact-accept-legend">
        <span className="it accepted">
          <span className="sw" /> Accepted <b>{formatCompact(w.accepted)}</b>
        </span>
        <span className="it dismissed">
          <span className="sw" /> Dismissed <b>{formatCompact(w.dismissed)}</b>
        </span>
        <span className="it pending">
          <span className="sw" /> Open <b>{formatCompact(w.pending)}</b>
        </span>
      </div>
    </div>
  );
}

// ── Time-range selector ────────────────────────────────────────────
// The date-range selector shared by the authed page and the public share view.
function RangeToggle({ range, onRange }: { range: string; onRange: (r: string) => void }) {
  return (
    <div className="seg-toggle" role="tablist" aria-label="Time range">
      {IMPACT_RANGES.map((r) => (
        <button
          key={r.key}
          role="tab"
          aria-selected={r.key === range}
          className={`seg-btn${r.key === range ? " active" : ""}`}
          onClick={() => onRange(r.key)}
        >
          {r.label}
        </button>
      ))}
    </div>
  );
}

/**
 * The full Impact report rendering, reused verbatim by the authed page and the
 * chrome-less public share view. `extraActions` lets each caller add buttons
 * (Print, Copy share link) beside the shared range selector; everything below
 * the header is purely aggregate (counts, severities, time bins) — no source
 * code or per-finding detail — which is what makes it safe to share publicly.
 */
export function ImpactReportBody({
  report,
  range,
  onRange,
  extraActions,
}: {
  report: ImpactReport;
  range: string;
  onRange: (r: string) => void;
  extraActions?: ReactNode;
}) {
  const c = report.current;
          const p = report.previous;
          const saved = formatMinutesSaved(c.timeSavedMinutes);
          const series = buildTrendSeries(report);
          const totalFindings = c.findings;
          const mergedFindings =
            c.mergedBySeverity.critical + c.mergedBySeverity.major + c.mergedBySeverity.minor + c.mergedBySeverity.nit;
          const acceptancePct = c.acceptanceRate == null ? null : Math.round(c.acceptanceRate * 100);
          const rec = report.recurring;
          const recurDown = rec.secondHalf < rec.firstHalf;
          const hasData = c.reviews > 0 || totalFindings > 0;
          const minutesNote = `${report.minutesPerFinding} min/finding`;

          return (
            <div className="impact-report">
              <header className="page-head">
                <div className="title-block">
                  <h1>Impact report</h1>
                  <p className="subtitle">
                    {report.range.label}
                    {report.repo ? ` · ${report.repo}` : " · all repositories"} · generated{" "}
                    {relativeTime(report.generatedAt) || "just now"}
                  </p>
                </div>
                <div className="actions">
                  <RangeToggle range={range} onRange={onRange} />
                  {extraActions}
                </div>
              </header>

              {/* ── Hero band ─────────────────────────────────────── */}
              <section className="impact-hero">
                <div className="impact-hero-main">
                  <div className="impact-hero-eyebrow">
                    <ImpactIcon /> DiffSentry · {report.range.label}
                  </div>
                  <div className="impact-hero-headline">
                    <span className="big">{formatCompact(c.criticalMajorCaughtBeforeMerge)}</span>
                    <span className="rest">
                      critical &amp; major {c.criticalMajorCaughtBeforeMerge === 1 ? "issue" : "issues"} caught
                      <br />
                      before merge
                    </span>
                  </div>
                  <div className="impact-hero-sub">
                    across <b>{formatCompact(c.mergedPrsCovered)}</b> merged{" "}
                    {c.mergedPrsCovered === 1 ? "PR" : "PRs"} · <b>{formatCompact(c.reviews)}</b> automated{" "}
                    {c.reviews === 1 ? "review" : "reviews"} on <b>{formatCompact(c.repos)}</b>{" "}
                    {c.repos === 1 ? "repo" : "repos"}
                  </div>
                </div>
                <div className="impact-hero-aside">
                  <div className="impact-hero-aside-icon">
                    <ClockIcon />
                  </div>
                  <div className="impact-hero-aside-value">{saved.value}</div>
                  <div className="impact-hero-aside-unit">{saved.unit} of reviewer time saved</div>
                  <div className="impact-hero-aside-note">≈ {minutesNote}</div>
                </div>
              </section>

              {/* ── Headline metric strip ─────────────────────────── */}
              <div className="grid four impact-stats">
                <StatCard
                  label="Reviews run"
                  value={formatCompact(c.reviews)}
                  sub={`${formatCompact(c.prsCovered)} PRs covered`}
                  delta={<Delta current={c.reviews} prev={p?.reviews} />}
                />
                <StatCard
                  label="Findings surfaced"
                  value={formatCompact(totalFindings)}
                  sub={`${formatCompact(c.bySeverity.critical + c.bySeverity.major)} crit + major`}
                  delta={<Delta current={totalFindings} prev={p?.findings} />}
                />
                <StatCard
                  label="Caught before merge"
                  value={formatCompact(c.criticalMajorCaughtBeforeMerge)}
                  sub="crit + major on merged PRs"
                  delta={<Delta current={c.criticalMajorCaughtBeforeMerge} prev={p?.criticalMajorCaughtBeforeMerge} />}
                />
                <StatCard
                  label="Reviewer time saved"
                  value={`${saved.value} ${saved.unit}`}
                  sub={minutesNote}
                  delta={<Delta current={c.timeSavedMinutes} prev={p?.timeSavedMinutes} />}
                />
              </div>

              {/* ── Severity trend ────────────────────────────────── */}
              <div style={{ marginTop: 16 }}>
                <Card
                  title="Findings by severity over time"
                  subtitle={`${formatCompact(totalFindings)} findings · ${report.range.label.toLowerCase()}`}
                  bodyClass="chart"
                >
                  {hasData ? (
                    <StackedSeverityBar series={series} />
                  ) : (
                    <EmptyState
                      title="No reviews in this range"
                      hint="Once DiffSentry reviews a PR, its findings will trend here."
                    />
                  )}
                </Card>
              </div>

              {/* ── Caught-before-merge + acceptance ──────────────── */}
              <div className="grid two" style={{ marginTop: 16 }}>
                <Card
                  title={
                    <span className="impact-card-title">
                      <ShieldIcon /> Caught before merge
                    </span>
                  }
                  subtitle="Severity of findings on PRs that merged"
                >
                  {mergedFindings === 0 ? (
                    <EmptyState title="Nothing caught yet" hint="No findings on merged PRs in this range." />
                  ) : (
                    <Donut
                      slices={[
                        { label: "Critical", value: c.mergedBySeverity.critical, color: "#fb6d82" },
                        { label: "Major", value: c.mergedBySeverity.major, color: "#fb923c" },
                        { label: "Minor", value: c.mergedBySeverity.minor, color: "#fbbf24" },
                        { label: "Nit", value: c.mergedBySeverity.nit, color: "#64748b" },
                      ]}
                    />
                  )}
                </Card>

                <Card
                  title={
                    <span className="impact-card-title">
                      <CheckIcon /> Fix acceptance
                    </span>
                  }
                  subtitle="Findings resolved as accepted"
                >
                  <div className="impact-rate">
                    <div className="impact-rate-num">
                      {acceptancePct == null ? "—" : `${acceptancePct}%`}
                    </div>
                    <div className="impact-rate-cap">
                      {acceptancePct == null
                        ? "No findings triaged yet"
                        : `accepted of ${formatCompact(c.accepted + c.dismissed)} triaged`}
                    </div>
                  </div>
                  <AcceptanceBar w={c} />
                </Card>
              </div>

              {/* ── Recurring prevention + coverage ───────────────── */}
              <div className="grid two" style={{ marginTop: 16 }}>
                <Card
                  title={
                    <span className="impact-card-title">
                      <RepeatIcon /> Recurring issues prevented
                    </span>
                  }
                  subtitle="Repeat bug patterns caught again"
                >
                  <div className="impact-recur">
                    <div className="impact-recur-big">
                      <div className="n">{formatCompact(rec.repeatsPrevented)}</div>
                      <div className="cap">
                        repeat {rec.repeatsPrevented === 1 ? "catch" : "catches"} across{" "}
                        {formatCompact(rec.distinctFingerprints)} recurring{" "}
                        {rec.distinctFingerprints === 1 ? "pattern" : "patterns"}
                      </div>
                    </div>
                    {rec.distinctFingerprints > 0 ? (
                      <div className={`impact-trend-chip ${recurDown ? "good" : "bad"}`}>
                        {recurDown ? "▼ trending down" : rec.secondHalf > rec.firstHalf ? "▲ trending up" : "→ steady"}
                        <span className="sub">
                          {formatCompact(rec.firstHalf)} → {formatCompact(rec.secondHalf)} this period
                        </span>
                      </div>
                    ) : (
                      <div className="impact-trend-chip flat">no repeats yet</div>
                    )}
                  </div>
                </Card>

                <Card title="Coverage summary" subtitle="What this report is built from">
                  <dl className="kv">
                    <div>
                      <dt>Repositories</dt>
                      <dd>{formatCompact(c.repos)}</dd>
                    </div>
                    <div>
                      <dt>PRs covered</dt>
                      <dd>{formatCompact(c.prsCovered)}</dd>
                    </div>
                    <div>
                      <dt>Merged PRs</dt>
                      <dd>{formatCompact(c.mergedPrsCovered)}</dd>
                    </div>
                    <div>
                      <dt>Reviews run</dt>
                      <dd>{formatCompact(c.reviews)}</dd>
                    </div>
                    <div>
                      <dt>Total findings</dt>
                      <dd>{formatCompact(totalFindings)}</dd>
                    </div>
                    <div>
                      <dt>Open / untriaged</dt>
                      <dd>{formatCompact(c.pending)}</dd>
                    </div>
                  </dl>
                </Card>
              </div>

              <p className="impact-foot">
                Reviewer-time saved is an estimate ({minutesNote}, configurable via{" "}
                <code>IMPACT_MINUTES_PER_FINDING</code>). All other numbers are counted directly from the
                reviews, findings, and PR tables for {report.range.label.toLowerCase()}
                {report.repo ? ` in ${report.repo}` : ""}.
              </p>
    </div>
  );
}

/**
 * "Copy share link" — mints a public, revocable share link for the current
 * report scope (admins only) and copies it to the clipboard. The link is minted
 * once and reused on subsequent clicks, so repeated copies don't spawn shares.
 */
function CopyShareLinkButton({ report }: { report: ImpactReport }) {
  const create = useCreateImpactShare();
  // Cache the minted link keyed to the report scope it was minted for, so the
  // copied link always matches the visible report. If the user re-windows the
  // range (or the repo scope differs), mint a fresh share rather than copying a
  // stale link that opens at a different default.
  const [cached, setCached] = useState<{ repo: string | null; range: string; url: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const rangeKey = report.range.days == null ? "all" : `${report.range.days}d`;

  async function copyToClipboard(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked (e.g. insecure context) — fall back to a prompt so the
      // operator can still grab the link.
      window.prompt("Copy this share link:", value);
    }
  }

  async function onClick() {
    if (cached && cached.repo === report.repo && cached.range === rangeKey) {
      await copyToClipboard(cached.url);
      return;
    }
    const res = await create.mutateAsync({ repo: report.repo, range: rangeKey });
    setCached({ repo: report.repo, range: rangeKey, url: res.url });
    await copyToClipboard(res.url);
  }

  return (
    <button
      className="btn btn-ghost"
      onClick={() => void onClick()}
      disabled={create.isPending}
      title="Create a public, revocable link to this aggregate impact report"
    >
      {create.isPending ? "Creating link…" : copied ? "Link copied ✓" : "Copy share link"}
    </button>
  );
}

export function ImpactPage() {
  const [range, setRange] = useState("30d");
  const query = useImpact(range);
  // Mirror the server contract directly: the share routes are requireRole('admin'),
  // so gate the control on the admin role rather than reusing an unrelated
  // capability flag (there is no `capabilities.admin`).
  const { role } = useAuth();

  return (
    <>
      <Breadcrumbs crumbs={[{ label: "Impact" }]} />
      <QueryBoundary query={query} loadingLabel="Computing impact…">
        {(report) => (
          <ImpactReportBody
            report={report}
            range={range}
            onRange={setRange}
            extraActions={
              <>
                {role === "admin" && <CopyShareLinkButton report={report} />}
                <button className="btn btn-ghost" onClick={() => window.print()}>
                  Print
                </button>
              </>
            }
          />
        )}
      </QueryBoundary>
    </>
  );
}
