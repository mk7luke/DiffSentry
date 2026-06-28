import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useFindings, useRepos } from "../api/hooks";
import { Breadcrumbs } from "../components/Shell";
import { Card, PageHeader } from "../components/primitives";
import { SeverityBadge } from "../components/badges";
import { EmptyState, ErrorState, LoadingState } from "../components/states";
import { relativeTime } from "../lib/format";
import {
  useEventStream,
  useStreamStatus,
  type FindingSurfacedPayload,
  type StreamEnvelope,
  type StreamStatus,
} from "../realtime/useEventStream";
import type { FindingExplorerRow } from "../api/types";

// ─────────────────────────────────────────────────────────────────────────────
// Feed — a human-friendly, reverse-chronological stream of findings across the
// whole org. Backfill the most-recent matches from GET /api/v1/findings, then
// live-prepend new ones as `finding.surfaced` events arrive on the SSE bus. New
// rows animate in at the top. Filter by severity / repo / author.
//
// Read-only and offline-tolerant: the backfill rides React Query's persisted
// cache (so the last-viewed feed survives a reload offline) and the SSE stream
// simply stays dormant until the connection returns.
// ─────────────────────────────────────────────────────────────────────────────

const MAX_LIVE = 200; // ring cap so an always-open tab can't grow unbounded
const PAGE = 50;

const SEVERITIES = ["critical", "major", "minor", "nit"];

interface FeedItem {
  key: string;
  owner: string;
  repo: string;
  number: number;
  title: string | null;
  severity: string | null;
  author: string | null;
  path: string | null;
  line: number | null;
  ts: string;
  sortTs: number;
  /** True for rows that arrived live this session — drives the entry animation. */
  isLive: boolean;
}

function rowToItem(r: FindingExplorerRow): FeedItem {
  return {
    key: `f:${r.id}`,
    owner: r.owner,
    repo: r.repo,
    number: r.number,
    title: r.title,
    severity: r.severity,
    author: r.author,
    path: r.path,
    line: r.line,
    ts: r.created_at,
    sortTs: Date.parse(r.created_at) || 0,
    isLive: false,
  };
}

function envToItem(env: StreamEnvelope): FeedItem | null {
  if (env.topic !== "finding.surfaced") return null;
  const p = env.payload as FindingSurfacedPayload;
  // The live event carries a per-review breakdown, not an individual finding, so
  // it has no id / path / line / author — only the headline (worst severity +
  // a representative title) and the PR coordinates. That's enough to surface it.
  return {
    key: `live:${env.id}`,
    owner: p.owner,
    repo: p.repo,
    number: p.number,
    title: p.sample ?? (p.total > 1 ? `${p.total} findings` : "New finding"),
    severity: p.worst,
    author: null,
    path: null,
    line: null,
    ts: env.ts,
    sortTs: Date.parse(env.ts) || Date.now(),
    isLive: true,
  };
}

export function FeedPage() {
  const [severity, setSeverity] = useState("");
  const [repo, setRepo] = useState("");
  const [author, setAuthor] = useState("");
  // Author input is debounced into `authorQuery` so each keystroke doesn't
  // refetch the backfill.
  const [authorQuery, setAuthorQuery] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const [now, setNow] = useState(() => Date.now());

  const repos = useRepos();
  const status = useStreamStatus();

  useEffect(() => {
    const t = setTimeout(() => setAuthorQuery(author.trim()), 300);
    return () => clearTimeout(t);
  }, [author]);

  const backfill = useFindings({
    severity: severity || undefined,
    repo: repo || undefined,
    author: authorQuery || undefined,
    limit,
  });

  // Live rows arrive newest-first; kept separate from the React Query backfill
  // and reset whenever the filter scope changes (a fresh backfill owns the set).
  const [live, setLive] = useState<FeedItem[]>([]);
  useEffect(() => {
    setLive([]);
    setLimit(PAGE);
  }, [severity, repo, authorQuery]);

  // Latest filter values read inside a *stable* onEvent so the SSE subscription
  // is set up once and a delivered event always matches the current scope.
  const filterRef = useRef({ severity, repo, authorQuery });
  useEffect(() => {
    filterRef.current = { severity, repo, authorQuery };
  }, [severity, repo, authorQuery]);

  const onEvent = useCallback((env: StreamEnvelope) => {
    const item = envToItem(env);
    if (!item) return;
    const { severity, repo, authorQuery } = filterRef.current;
    // Mirror the backfill's server-side filtering on the live tail. A live event
    // exposes only the *worst* severity for the review, so a severity filter
    // matches against that; and it carries no author, so an author filter can't
    // be satisfied live — drop it rather than show an unverifiable row.
    if (severity && (item.severity ?? "").toLowerCase() !== severity) return;
    if (repo && `${item.owner}/${item.repo}` !== repo) return;
    if (authorQuery) return;
    setLive((prev) => {
      const next = prev.length >= MAX_LIVE ? prev.slice(0, MAX_LIVE - 1) : prev;
      return [item, ...next];
    });
  }, []);
  useEventStream(onEvent);

  // Ticking clock so "3m ago" labels stay current without per-row timers.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    if (typeof t === "object" && "unref" in t) (t as { unref?: () => void }).unref?.();
    return () => clearInterval(t);
  }, []);

  const baseItems = useMemo(() => (backfill.data?.rows ?? []).map(rowToItem), [backfill.data]);

  // Live (in front) + backfill → dedupe by key → newest first.
  const merged = useMemo(() => {
    const byKey = new Map<string, FeedItem>();
    for (const it of live) byKey.set(it.key, it);
    for (const it of baseItems) byKey.set(it.key, it);
    return Array.from(byKey.values()).sort((a, b) => b.sortTs - a.sortTs);
  }, [live, baseItems]);

  const total = backfill.data?.total ?? 0;
  const hasFilters = !!(severity || repo || authorQuery);
  const repoOptions = repos.data?.repos.map((r) => `${r.owner}/${r.repo}`) ?? [];
  // `now` is read so the memo (and every relativeTime below) recomputes on tick.
  void now;

  return (
    <>
      <Breadcrumbs crumbs={[{ label: "Feed" }]} />
      <PageHeader
        title="Feed"
        subtitle="A live, reverse-chronological stream of every finding across the org."
        right={<ConnIndicator status={status} />}
      />

      <Card bodyClass="tight">
        <div className="filterbar">
          <label className="field">
            Severity
            <select value={severity} onChange={(e) => setSeverity(e.target.value)}>
              <option value="">Any severity</option>
              {SEVERITIES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Repo
            <select value={repo} onChange={(e) => setRepo(e.target.value)}>
              <option value="">All repos</option>
              {repoOptions.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Author
            <input value={author} onChange={(e) => setAuthor(e.target.value)} placeholder="github login" />
          </label>
          {hasFilters ? (
            <div className="feed-filter-actions">
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => {
                  setSeverity("");
                  setRepo("");
                  setAuthor("");
                }}
              >
                Clear
              </button>
            </div>
          ) : null}
        </div>
      </Card>

      <div style={{ marginTop: 16 }}>
        <Card
          title="Recent findings"
          subtitle={total > 0 ? `${total.toLocaleString()} total` : undefined}
          right={
            <Link className="link" to={repo ? `/findings?repo=${encodeURIComponent(repo)}` : "/findings"}>
              Open in Findings explorer →
            </Link>
          }
          bodyClass="flush"
        >
          {backfill.isPending ? (
            <LoadingState label="Loading findings…" />
          ) : backfill.isError ? (
            <ErrorState error={backfill.error} />
          ) : merged.length === 0 ? (
            <EmptyState
              title={hasFilters ? "No findings match these filters" : "No findings yet"}
              hint={
                hasFilters
                  ? "Clear the filters to see the whole feed."
                  : "Once a review surfaces findings they'll stream in here live."
              }
            />
          ) : (
            <>
              <ul className="feed-list">
                {merged.map((it) => (
                  <FeedRow key={it.key} item={it} />
                ))}
              </ul>
              {!hasFilters && merged.length >= limit && limit < total ? (
                <div className="feed-foot">
                  <button className="btn btn-ghost" onClick={() => setLimit((n) => n + PAGE)} disabled={backfill.isFetching}>
                    {backfill.isFetching ? "Loading…" : "Load more"}
                  </button>
                </div>
              ) : null}
            </>
          )}
        </Card>
      </div>
    </>
  );
}

function FeedRow({ item }: { item: FeedItem }) {
  const repoSlug = `${item.owner}/${item.repo}`;
  return (
    <li className={`feed-row${item.isLive ? " is-new" : ""}`} data-sev={(item.severity ?? "").toLowerCase()}>
      <span className="feed-sev">
        <SeverityBadge severity={item.severity} />
      </span>
      <div className="feed-main">
        <div className="feed-title">{item.title ?? "—"}</div>
        <div className="feed-meta">
          <Link className="link mono" to={`/repos/${encodeURIComponent(item.owner)}/${encodeURIComponent(item.repo)}`}>
            {repoSlug}
          </Link>
          <span className="sep">·</span>
          <Link
            className="link mono"
            to={`/repos/${encodeURIComponent(item.owner)}/${encodeURIComponent(item.repo)}/pr/${item.number}`}
          >
            #{item.number}
          </Link>
          {item.path ? (
            <>
              <span className="sep">·</span>
              <span className="mono muted">
                {item.path}
                {item.line ? <span className="line-num">:{item.line}</span> : null}
              </span>
            </>
          ) : null}
          {item.author ? (
            <>
              <span className="sep">·</span>
              <span className="muted">@{item.author}</span>
            </>
          ) : null}
        </div>
      </div>
      <time className="feed-when muted" dateTime={item.ts} title={item.ts}>
        {relativeTime(item.ts) || "now"}
      </time>
    </li>
  );
}

function ConnIndicator({ status }: { status: StreamStatus }) {
  const label = status === "live" ? "LIVE" : status === "reconnecting" ? "RECONNECTING" : "CONNECTING";
  return (
    <span className={`ops-conn ${status}`} title={`SSE stream ${status}`}>
      <span className="dot" />
      {label}
    </span>
  );
}
