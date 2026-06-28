import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { fetchActivity, useActivity, useRepos } from "../api/hooks";
import { Breadcrumbs } from "../components/Shell";
import { Card, PageHeader } from "../components/primitives";
import { EmptyState, ErrorState, LiveCount, Skeleton, SkeletonBlock } from "../components/states";
import { relativeTime } from "../lib/format";
import {
  useEventStream,
  useStreamStatus,
  type ActionPayload,
  type ReviewLifecyclePayload,
  type StreamEnvelope,
  type WebhookPayload,
} from "../realtime/useEventStream";
import type { ActivityRow } from "../api/types";

// ─────────────────────────────────────────────────────────────────────────────
// Ops Console — a live, filterable tail of everything the bot is doing.
//
// Backfill the recent unified feed from GET /api/v1/activity, then live-tail the
// SSE bus (review.* + webhook.* + action.performed) on top of it. Terminal-style:
// oldest→newest top→bottom, auto-scrolls to the tail, pauses while hovered so a
// row can be read without it jumping. Filter by repo / kind / severity; click a
// row to deep-link to its PR. A per-minute sparkline + connection indicator sit
// in the header.
// ─────────────────────────────────────────────────────────────────────────────

const MAX_ITEMS = 1000; // ring cap so an always-open tab can't grow unbounded
const PAGE = 120;
const SPARK_BUCKETS = 20; // 20 × 60s = last 20 minutes
const BUCKET_MS = 60_000;

type ItemSource = "review" | "event" | "live";

interface FeedItem {
  key: string;
  source: ItemSource;
  ts: string;
  sortTs: number;
  owner: string | null;
  repo: string | null;
  number: number | null;
  kind: string;
  severity: string | null;
  approval?: string | null;
  risk_score?: number | null;
  finding_count?: number | null;
  title?: string | null;
  detail?: string | null;
  actor?: string | null;
  result?: string | null;
}

function rowToItem(r: ActivityRow): FeedItem {
  return {
    key: `${r.source}:${r.id}`,
    source: r.source,
    ts: r.ts,
    sortTs: Date.parse(r.ts) || 0,
    owner: r.owner,
    repo: r.repo,
    number: r.number,
    kind: r.kind,
    severity: r.severity,
    approval: r.approval,
    risk_score: r.risk_score,
    finding_count: r.finding_count,
    title: r.title,
  };
}

function envToItem(env: StreamEnvelope): FeedItem | null {
  // `severity` is finding-severity only (critical/major/minor/nit), set on
  // historical review rows by the backend. Live lifecycle/action events carry
  // no finding severity, so they leave it null — keeping the severity filter's
  // meaning identical on the live stream and the /api/v1/activity backfill
  // (which only attaches severity to review rows). Colour-coding for these live
  // events keys on kind/result in classify(), not on severity.
  const base = {
    key: `live:${env.id}`,
    source: "live" as const,
    ts: env.ts,
    sortTs: Date.parse(env.ts) || Date.now(),
  };
  if (env.topic === "review.started" || env.topic === "review.finished" || env.topic === "review.failed") {
    const p = env.payload as ReviewLifecyclePayload;
    return {
      ...base,
      owner: p.owner,
      repo: p.repo,
      number: p.number,
      kind: env.topic,
      severity: null,
      detail: env.topic === "review.failed" ? p.error : p.mode ? `${p.mode} review` : null,
    };
  }
  if (env.topic === "webhook.received") {
    const p = env.payload as WebhookPayload;
    return {
      ...base,
      owner: p.owner,
      repo: p.repo,
      number: p.number,
      kind: p.kind || env.topic,
      severity: null,
    };
  }
  if (env.topic === "action.performed") {
    const p = env.payload as ActionPayload;
    return {
      ...base,
      owner: p.owner,
      repo: p.repo,
      number: p.number,
      kind: `action.${p.action}`,
      severity: null,
      detail: p.detail,
      actor: p.actor,
      result: p.result,
    };
  }
  return null;
}

// Category → dot color + short tag. Drives the color-coding of the feed.
function classify(item: FeedItem): { color: string; tag: string } {
  const k = item.kind;
  if (k === "review.failed") return { color: "var(--sev-crit)", tag: "FAILED" };
  if (k === "review.finished") return { color: "var(--good)", tag: "DONE" };
  if (k === "review.started") return { color: "var(--accent-bright)", tag: "START" };
  if (k.startsWith("action.")) {
    return item.result && item.result !== "ok" && item.result !== "accepted"
      ? { color: "var(--sev-crit)", tag: "ACTION" }
      : { color: "var(--accent-2)", tag: "ACTION" };
  }
  if (k === "review") {
    // Historical review row — color by its worst finding severity.
    const sev = (item.severity ?? "").toLowerCase();
    if (sev === "critical") return { color: "var(--sev-crit)", tag: "REVIEW" };
    if (sev === "major") return { color: "var(--sev-major)", tag: "REVIEW" };
    if (sev === "minor") return { color: "var(--sev-minor)", tag: "REVIEW" };
    if (sev === "nit") return { color: "var(--sev-nit)", tag: "REVIEW" };
    return { color: "var(--good)", tag: "REVIEW" };
  }
  if (k.startsWith("pull_request")) return { color: "var(--accent)", tag: "PR" };
  if (k.startsWith("issue")) return { color: "var(--accent-2)", tag: "ISSUE" };
  if (k.startsWith("push")) return { color: "var(--sev-minor)", tag: "PUSH" };
  return { color: "var(--text-3)", tag: "HOOK" };
}

// Human-readable right-hand description for a row.
function describe(item: FeedItem): string {
  switch (item.kind) {
    case "review.started":
      return item.detail ?? "review started";
    case "review.finished":
      return "review finished";
    case "review.failed":
      return item.detail ? `failed — ${item.detail}` : "review failed";
    case "review": {
      const bits: string[] = [];
      if (item.title) bits.push(item.title);
      if (item.approval) bits.push(item.approval.replace(/_/g, " "));
      if (typeof item.finding_count === "number") bits.push(`${item.finding_count} finding${item.finding_count === 1 ? "" : "s"}`);
      if (typeof item.risk_score === "number") bits.push(`risk ${item.risk_score}`);
      return bits.join(" · ") || "review";
    }
    default:
      if (item.kind.startsWith("action.")) {
        const who = item.actor ? `@${item.actor}` : "someone";
        const verb = item.kind.slice("action.".length);
        return [`${who} · ${verb}`, item.result && item.result !== "ok" ? item.result : null, item.detail]
          .filter(Boolean)
          .join(" · ");
      }
      return item.kind;
  }
}

const SEVERITIES = ["critical", "major", "minor", "nit"];

export function OpsConsolePage() {
  const [repo, setRepo] = useState("");
  const [kind, setKind] = useState("");
  const [severity, setSeverity] = useState("");
  const [paused, setPaused] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  // Filters are authoritative end-to-end: the backfill query is fetched
  // pre-filtered (so older matches aren't hidden behind an unfiltered page),
  // and live events are filtered before buffering (below).
  const backfill = useActivity({
    repo: repo || undefined,
    kind: kind || undefined,
    severity: severity || undefined,
    limit: PAGE,
  });
  const repos = useRepos();
  const status = useStreamStatus();

  // Pages fetched by "load older" (oldest-first), and live SSE items, both kept
  // separate from the React-Query backfill page and reset when the repo scope
  // changes (a new backfill query owns the base set).
  const [older, setOlder] = useState<FeedItem[]>([]);
  const [live, setLive] = useState<FeedItem[]>([]);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState<string | null>(null);
  // Every live kind ever seen this session, recorded before the filter is
  // applied — keeps the kind dropdown complete (incl. live-only kinds like
  // review.started / action.*) even while a kind/severity filter is active.
  const [liveKinds, setLiveKinds] = useState<ReadonlySet<string>>(() => new Set());
  // Server-driven pagination cursor (opaque). Reactive state, not a ref, so the
  // "Load older" button reflects exhaustion immediately. `before` is whatever
  // the API returned as `nextBefore` — never derived from the rendered list.
  const [cursor, setCursor] = useState<{ before: string | null; hasMore: boolean }>({ before: null, hasMore: true });

  useEffect(() => {
    // Any filter change invalidates the accumulated feed — a new backfill query
    // owns the base set, and stale older/live rows from the previous scope must go.
    setOlder([]);
    setLive([]);
    setCursor({ before: null, hasMore: true });
  }, [repo, kind, severity]);

  // Seed the "load older" cursor from each fresh backfill page. Runs only when
  // the React-Query page changes (repo switch / refetch), not after loadOlder
  // (which mutates `older`, not backfill.data), so manual paging is preserved.
  useEffect(() => {
    if (backfill.data) {
      setCursor({ before: backfill.data.nextBefore, hasMore: backfill.data.hasMore });
    }
  }, [backfill.data]);

  // Latest filter values for the live tail, read inside a *stable* onEvent.
  // Keeping onEvent stable means the SSE subscription is set up once (not torn
  // down on every filter change), and reading the ref guarantees a delivered
  // event is always matched against the current scope — never a stale closure.
  const filterRef = useRef({ repo, kind, severity });
  useEffect(() => {
    filterRef.current = { repo, kind, severity };
  }, [repo, kind, severity]);

  // Live tail. Record the kind for the dropdown, then drop events outside the
  // active filter so the live buffer stays scoped (no cross-repo leakage).
  const onEvent = useCallback((env: StreamEnvelope) => {
    const item = envToItem(env);
    if (!item) return;
    setLiveKinds((prev) => (prev.has(item.kind) ? prev : new Set(prev).add(item.kind)));
    const { repo, kind, severity } = filterRef.current;
    // Guard nullable metadata before coercing — never compare "null/null".
    if (repo && (!item.owner || !item.repo || `${item.owner}/${item.repo}` !== repo)) return;
    if (kind && item.kind !== kind) return;
    if (severity && (item.severity ?? "").toLowerCase() !== severity) return;
    setLive((prev) => {
      const next = prev.length >= MAX_ITEMS ? prev.slice(prev.length - MAX_ITEMS + 1) : prev;
      return [...next, item];
    });
  }, []);
  useEventStream(onEvent);

  // Ticking clock: bumping `now` every 5s re-renders the page, which both
  // recomputes the events/min sparkline and re-runs each FeedRow's
  // relativeTime() so "3m ago" labels stay current without per-row timers.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5_000);
    if (typeof t === "object" && "unref" in t) (t as { unref?: () => void }).unref?.();
    return () => clearInterval(t);
  }, []);

  const baseItems = useMemo(() => (backfill.data?.rows ?? []).map(rowToItem), [backfill.data]);

  // Merge older + base + live → dedupe by key → ascending by time → cap.
  const merged = useMemo(() => {
    const byKey = new Map<string, FeedItem>();
    for (const it of older) byKey.set(it.key, it);
    for (const it of baseItems) byKey.set(it.key, it);
    for (const it of live) byKey.set(it.key, it);
    const all = Array.from(byKey.values()).sort((a, b) => a.sortTs - b.sortTs);
    return all.length > MAX_ITEMS ? all.slice(all.length - MAX_ITEMS) : all;
  }, [older, baseItems, live]);

  // Filter dropdown options: server-known kinds ∪ live kinds seen this session.
  // Sourced independently of `merged` so an active kind/severity filter never
  // collapses the list to just the selected option.
  const kindOptions = useMemo(() => {
    const set = new Set<string>(backfill.data?.kinds ?? []);
    for (const k of liveKinds) set.add(k);
    return Array.from(set).sort();
  }, [backfill.data, liveKinds]);

  const visible = useMemo(() => {
    return merged.filter((it) => {
      if (repo && (!it.owner || !it.repo || `${it.owner}/${it.repo}` !== repo)) return false;
      if (kind && it.kind !== kind) return false;
      if (severity && (it.severity ?? "").toLowerCase() !== severity) return false;
      return true;
    });
  }, [merged, repo, kind, severity]);

  // Events-per-minute sparkline buckets (over the visible feed).
  const spark = useMemo(() => {
    const buckets = new Array<number>(SPARK_BUCKETS).fill(0);
    const start = now - SPARK_BUCKETS * BUCKET_MS;
    for (const it of visible) {
      if (it.sortTs < start || it.sortTs > now) continue;
      const idx = Math.min(SPARK_BUCKETS - 1, Math.floor((it.sortTs - start) / BUCKET_MS));
      buckets[idx] += 1;
    }
    return buckets;
  }, [visible, now]);
  const perMin = spark[SPARK_BUCKETS - 1];

  // ── Auto-scroll (tail) with pause-on-hover ──────────────────────────
  const feedRef = useRef<HTMLDivElement | null>(null);
  const atBottom = useRef(true);
  const onScroll = useCallback(() => {
    const el = feedRef.current;
    if (!el) return;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  }, []);
  const scrollToBottom = useCallback(() => {
    const el = feedRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);
  useEffect(() => {
    if (!paused && atBottom.current) scrollToBottom();
  }, [visible.length, paused, scrollToBottom]);

  const navigate = useNavigate();
  const open = useCallback(
    (it: FeedItem) => {
      if (!it.owner || !it.repo) return;
      const base = `/repos/${encodeURIComponent(it.owner)}/${encodeURIComponent(it.repo)}`;
      navigate(it.number != null ? `${base}/pr/${it.number}` : base);
    },
    [navigate],
  );

  const loadOlder = useCallback(async () => {
    if (loadingOlder) return;
    // Page strictly by the server cursor — never the oldest *rendered* row,
    // which the ring cap can trim ahead of the true history boundary.
    const before = cursor.before;
    if (!cursor.hasMore || !before) return;
    setLoadingOlder(true);
    setOlderError(null);
    try {
      const res = await fetchActivity({
        repo: repo || undefined,
        kind: kind || undefined,
        severity: severity || undefined,
        before,
        limit: PAGE,
      });
      setCursor({ before: res.nextBefore, hasMore: res.hasMore });
      setOlder((prev) => {
        const byKey = new Map(prev.map((i) => [i.key, i] as const));
        for (const r of res.rows) {
          const it = rowToItem(r);
          byKey.set(it.key, it);
        }
        return Array.from(byKey.values()).sort((a, b) => a.sortTs - b.sortTs);
      });
    } catch (err) {
      // The click handler discards the promise (`void loadOlder()`), so surface
      // the failure here rather than letting it vanish into the event boundary.
      setOlderError(err instanceof Error ? err.message : "Failed to load older activity.");
    } finally {
      setLoadingOlder(false);
    }
  }, [loadingOlder, repo, kind, severity, cursor.before, cursor.hasMore]);

  const repoOptions = repos.data?.repos.map((r) => `${r.owner}/${r.repo}`) ?? [];
  const hasFilters = !!(repo || kind || severity);

  return (
    <div className="ops">
      <Breadcrumbs crumbs={[{ label: "Ops Console" }]} />
      <PageHeader
        title="Ops Console"
        subtitle="Live tail of every review, webhook, and command across all repos."
        right={
          <div className="ops-headmeta">
            <RateSparkline buckets={spark} />
            <div className="ops-rate">
              <span className="n">{perMin}</span>
              <span className="u">events/min</span>
            </div>
            <ConnIndicator status={status} />
          </div>
        }
      />

      <Card bodyClass="tight">
        <div className="ops-filters">
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
            Kind
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="">All kinds</option>
              {kindOptions.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </label>
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
          <div className="ops-filter-actions">
            {hasFilters ? (
              <button
                className="btn btn-ghost"
                onClick={() => {
                  setRepo("");
                  setKind("");
                  setSeverity("");
                }}
              >
                Clear
              </button>
            ) : null}
          </div>
        </div>
      </Card>

      <Card
        bodyClass="flush"
        title="Activity stream"
        right={
          <span className={`ops-tailstate ${paused ? "paused" : "live"}`}>
            {paused ? (
              "paused — move away to resume"
            ) : (
              <>
                tailing · <LiveCount value={visible.length} /> shown
              </>
            )}
          </span>
        }
        id="ops-feed-card"
      >
        <div className="ops-feed-wrap">
          {(cursor.hasMore && cursor.before) || olderError ? (
            <div className="ops-older">
              {cursor.hasMore && cursor.before ? (
                <button className="btn btn-link" onClick={() => void loadOlder()} disabled={loadingOlder}>
                  {loadingOlder ? "Loading…" : olderError ? "↑ Retry" : "↑ Load older"}
                </button>
              ) : null}
              {olderError ? <span className="ops-older-err">{olderError}</span> : null}
            </div>
          ) : null}
          <div
            className="ops-feed"
            ref={feedRef}
            onScroll={onScroll}
            onMouseEnter={() => setPaused(true)}
            onMouseLeave={() => {
              setPaused(false);
              atBottom.current = true;
              scrollToBottom();
            }}
          >
            {backfill.isPending ? (
              <SkeletonBlock label="Loading activity…">
                {Array.from({ length: 8 }).map((_, i) => (
                  <div key={i} className="ops-row" style={{ alignItems: "center" }}>
                    <Skeleton width={48} height={10} />
                    <Skeleton width={9} height={9} radius={999} />
                    <Skeleton width={40} height={10} />
                    <Skeleton width="80%" height={10} />
                    <Skeleton width="60%" height={10} />
                    <Skeleton width={32} height={10} />
                  </div>
                ))}
              </SkeletonBlock>
            ) : backfill.isError ? (
              <ErrorState error={backfill.error} />
            ) : visible.length === 0 ? (
              <EmptyState
                title={hasFilters ? "Nothing matches these filters" : "No activity yet"}
                hint={hasFilters ? "Clear the filters or load older history." : "Trigger a review or open a PR to see it stream in live."}
              />
            ) : (
              visible.map((it) => <FeedRow key={it.key} item={it} onOpen={open} />)
            )}
          </div>
        </div>
      </Card>
    </div>
  );
}

function FeedRow({ item, onOpen }: { item: FeedItem; onOpen: (i: FeedItem) => void }) {
  const { color, tag } = classify(item);
  const ref = item.owner && item.repo ? `${item.owner}/${item.repo}${item.number != null ? `#${item.number}` : ""}` : "";
  const clickable = !!(item.owner && item.repo);
  return (
    <div
      className={`ops-row${clickable ? " clickable" : ""}`}
      onClick={clickable ? () => onOpen(item) : undefined}
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      aria-label={clickable ? `Open ${item.number != null ? "PR" : "repo"} ${ref}: ${item.kind} — ${describe(item)}` : undefined}
      onKeyDown={
        clickable
          ? (e) => {
              // Activate on Enter or Space like a native button; preventDefault
              // stops Space from scrolling the feed.
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onOpen(item);
              }
            }
          : undefined
      }
    >
      <span className="when" title={item.ts}>
        {relativeTime(item.ts) || "now"}
      </span>
      <span className="dot" style={{ background: color }} aria-hidden="true" />
      <span className="tag" style={{ color }}>
        {tag}
      </span>
      <span className="kindlabel">{item.kind}</span>
      <span className="msg">{describe(item)}</span>
      {ref ? <span className="ref mono">{ref}</span> : <span />}
    </div>
  );
}

function ConnIndicator({ status }: { status: "connecting" | "live" | "reconnecting" }) {
  const label = status === "live" ? "LIVE" : status === "reconnecting" ? "RECONNECTING" : "CONNECTING";
  return (
    <span className={`ops-conn ${status}`} title={`SSE stream ${status}`}>
      <span className="dot" />
      {label}
    </span>
  );
}

function RateSparkline({ buckets }: { buckets: number[] }) {
  const max = Math.max(1, ...buckets);
  return (
    <div className="ops-spark" aria-hidden="true" title={`${buckets.reduce((a, b) => a + b, 0)} events over the last ${buckets.length} min`}>
      {buckets.map((b, i) => (
        <span key={i} className="bar" style={{ height: `${Math.max(6, (b / max) * 100).toFixed(0)}%`, opacity: b === 0 ? 0.25 : 1 }} />
      ))}
    </div>
  );
}
