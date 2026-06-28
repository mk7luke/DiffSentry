import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { Link, isRouteErrorResponse, useRouteError } from "react-router-dom";
import type { UseQueryResult } from "@tanstack/react-query";
import { ApiError } from "../api/client";
import { AlertIcon, LogoIcon } from "./icons";

// Shared loading / error / empty states so every screen handles the three
// non-happy paths consistently.

export function EmptyState({
  title,
  hint,
  illustration,
  action,
}: {
  title: ReactNode;
  hint?: ReactNode;
  /** A light, on-brand line illustration (see Empty*Art below). Optional so the
   *  compact empty states embedded in cards/donuts can stay illustration-free. */
  illustration?: ReactNode;
  /** A next-step CTA (a link or button) that points the user somewhere useful. */
  action?: ReactNode;
}) {
  return (
    <div className={`empty${illustration ? " has-art" : ""}`}>
      {illustration ? (
        <div className="empty-art" aria-hidden="true">
          {illustration}
        </div>
      ) : null}
      <div className="title">{title}</div>
      {hint ? <div className="empty-hint">{hint}</div> : null}
      {action ? <div className="empty-cta">{action}</div> : null}
    </div>
  );
}

// ── Branded empty-state illustrations ────────────────────────────────
// Light line-art, drawn with currentColor so the .empty-art rule can tint them
// (a muted base stroke with a single accent-keyed highlight). Decorative only —
// the surrounding EmptyState already carries the text, so these are aria-hidden.

/** Magnifier over a document — "nothing matched your search/filters". */
export function EmptySearchArt() {
  return (
    <svg viewBox="0 0 96 96" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="20" y="14" width="42" height="54" rx="4" className="art-soft" />
      <path d="M30 28h22M30 38h22M30 48h12" className="art-soft" />
      <circle cx="58" cy="58" r="15" className="art-accent" />
      <path d="m69 69 9 9" className="art-accent" />
    </svg>
  );
}

/** Shield with a check — "all clear, nothing flagged". */
export function EmptyShieldArt() {
  return (
    <svg viewBox="0 0 96 96" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M48 14 26 22v20c0 16 10 26 22 30 12-4 22-14 22-30V22z" className="art-soft" />
      <path d="m39 46 6 6 13-13" className="art-accent" />
    </svg>
  );
}

/** Stacked bars / podium — "no activity to rank yet". */
export function EmptyChartArt() {
  return (
    <svg viewBox="0 0 96 96" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M16 78h64" className="art-soft" />
      <rect x="24" y="50" width="14" height="24" rx="2" className="art-soft" />
      <rect x="41" y="34" width="14" height="40" rx="2" className="art-accent" />
      <rect x="58" y="58" width="14" height="16" rx="2" className="art-soft" />
    </svg>
  );
}

/** Empty open box — generic "nothing here". */
export function EmptyBoxArt() {
  return (
    <svg viewBox="0 0 96 96" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M16 36 48 22l32 14-32 14z" className="art-soft" />
      <path d="M16 36v26l32 14 32-14V36" className="art-soft" />
      <path d="M48 50v26" className="art-accent" />
      <path d="M32 43v9" className="art-accent" />
    </svg>
  );
}

export function LoadingState({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="center-pad">
      <span className="spinner" />
      <span>{label}</span>
    </div>
  );
}

// ── Skeletons ────────────────────────────────────────────────────────
// Shimmer placeholders that mirror a surface's eventual shape, so the first
// paint reads as "content arriving" rather than a dead spinner. They reuse the
// `.skel` shimmer (base.css), which falls back to a static tint under
// prefers-reduced-motion. `aria-hidden` + role="status" on the wrapper keeps
// screen readers on a single "Loading…" announcement instead of the bars.

/** A single shimmer block. Width/height accept any CSS length (default px). */
export function Skeleton({
  width = "100%",
  height = 12,
  radius,
  className,
  style,
}: {
  width?: number | string;
  height?: number | string;
  radius?: number | string;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <span
      className={`skel${className ? ` ${className}` : ""}`}
      style={{ display: "block", width, height, borderRadius: radius, ...style }}
    />
  );
}

/** Stacked text lines; the last line is shortened to read as a paragraph. */
export function SkeletonText({ lines = 3, gap = 8 }: { lines?: number; gap?: number }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap }}>
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} height={11} width={i === lines - 1 ? "60%" : "100%"} />
      ))}
    </div>
  );
}

/** Wrapper that labels a block of skeletons as a single loading region. */
export function SkeletonBlock({ label = "Loading…", children }: { label?: string; children: ReactNode }) {
  return (
    <div role="status" aria-busy="true" aria-label={label}>
      <span className="sr-only">{label}</span>
      <div aria-hidden="true">{children}</div>
    </div>
  );
}

/** A row of metric cards — matches the `.metric` hero/stat strips. */
export function SkeletonMetrics({ count = 4 }: { count?: number }) {
  return (
    <div className="grid four">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="metric">
          <Skeleton width="55%" height={10} />
          <Skeleton width="45%" height={28} style={{ marginTop: 6 }} />
        </div>
      ))}
    </div>
  );
}

/** A card-shaped placeholder with an optional header strip and body lines. */
export function SkeletonCard({ lines = 4, head = true }: { lines?: number; head?: boolean }) {
  return (
    <section className="card">
      {head ? (
        <div className="card-head">
          <Skeleton width={140} height={12} />
          <Skeleton width={60} height={10} />
        </div>
      ) : null}
      <div className="card-body">
        <SkeletonText lines={lines} />
      </div>
    </section>
  );
}

/** A table-shaped placeholder inside a flush card. */
export function SkeletonTable({ rows = 6, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <section className="card">
      <div className="card-body flush">
        <div style={{ padding: "12px 14px", borderBottom: "1px solid var(--line-soft)" }}>
          <Skeleton width={160} height={12} />
        </div>
        {Array.from({ length: rows }).map((_, r) => (
          <div
            key={r}
            style={{
              display: "grid",
              gridTemplateColumns: `repeat(${cols}, 1fr)`,
              gap: 16,
              padding: "11px 14px",
              borderBottom: r === rows - 1 ? "none" : "1px solid var(--line-soft)",
            }}
          >
            {Array.from({ length: cols }).map((_, c) => (
              <Skeleton key={c} height={11} width={c === 0 ? "55%" : "80%"} />
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}

// ── LiveCount ────────────────────────────────────────────────────────
// Renders a number/string that briefly pulses whenever the value changes, so a
// realtime tick on a live badge (Queue lanes, Ops tail) draws the eye. The
// animation is restarted on each change via a forced reflow so rapid updates
// each get their own pulse; prefers-reduced-motion disables it in CSS.
export function LiveCount({
  value,
  className,
  title,
}: {
  value: number | string;
  className?: string;
  title?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const prev = useRef(value);

  useEffect(() => {
    if (prev.current === value) return;
    prev.current = value;
    const el = ref.current;
    if (!el) return;
    el.classList.remove("lc-pulse");
    void el.offsetWidth; // reflow so the animation restarts even mid-pulse
    el.classList.add("lc-pulse");
  }, [value]);

  return (
    <span ref={ref} className={className} title={title}>
      {value}
    </span>
  );
}

export function ErrorState({ error }: { error: unknown }) {
  const isApi = error instanceof ApiError;
  const message = error instanceof Error ? error.message : "Something went wrong.";
  const code = isApi ? error.code : undefined;
  return (
    <section className="card tone-danger">
      <div className="card-body">
        <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
          <span style={{ color: "var(--sev-crit)", flexShrink: 0 }}>
            <AlertIcon style={{ width: 18, height: 18 }} />
          </span>
          <div>
            <div style={{ color: "var(--sev-crit)", fontWeight: 600, fontSize: 13 }}>{message}</div>
            <div className="muted" style={{ fontSize: 12, marginTop: 3 }}>
              {code ? `Error code: ${code}.` : "Check server logs for details."}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

export function NotFoundState({ message, action }: { message: string; action?: ReactNode }) {
  return (
    <section className="card">
      <div className="empty has-art">
        <div className="empty-art" aria-hidden="true">
          <EmptyBoxArt />
        </div>
        <div className="mono empty-code">404 · NOT FOUND</div>
        <div className="title">{message}</div>
        {action ? <div className="empty-cta">{action}</div> : null}
      </div>
    </section>
  );
}

// Full-page error boundary wired as the router's errorElement. Catches render
// and loader errors thrown anywhere under the Shell and shows a friendly,
// on-brand recovery page instead of a blank screen or React's dev overlay.
export function RouteErrorBoundary() {
  const error = useRouteError();
  const routeResp = isRouteErrorResponse(error) ? error : null;
  const is404 = routeResp?.status === 404;

  const title = is404 ? "We couldn't find that page" : "Something went wrong";
  const detail = is404
    ? "The page may have moved, or the link might be out of date."
    : routeResp
      ? `${routeResp.status} ${routeResp.statusText}`.trim()
      : error instanceof Error
        ? error.message
        : "An unexpected error interrupted this page.";

  return (
    <div className="error-page" role="alert">
      <div className="error-page-inner">
        <div className="error-brand">
          <LogoIcon style={{ width: 30, height: 30 }} />
          <span className="error-wordmark">DiffSentry</span>
        </div>
        <div className="empty-art error-art" aria-hidden="true">
          {is404 ? <EmptyBoxArt /> : <EmptyShieldArt />}
        </div>
        <h1 className="error-title">{title}</h1>
        <p className="error-detail">{detail}</p>
        <div className="error-actions">
          <Link className="btn btn-primary" to="/overview">
            Back to overview
          </Link>
          <button type="button" className="btn btn-ghost" onClick={() => window.location.reload()}>
            Reload page
          </button>
        </div>
      </div>
    </div>
  );
}

/** Render-prop wrapper that handles loading / error before exposing data. */
export function QueryBoundary<T>({
  query,
  loadingLabel,
  skeleton,
  children,
}: {
  query: UseQueryResult<T>;
  loadingLabel?: string;
  /** Skeleton to show while pending instead of the centered spinner. */
  skeleton?: ReactNode;
  children: (data: T) => ReactNode;
}) {
  if (query.isPending) {
    if (skeleton) return <SkeletonBlock label={loadingLabel}>{skeleton}</SkeletonBlock>;
    return <LoadingState label={loadingLabel} />;
  }
  if (query.isError) {
    if (query.error instanceof ApiError && query.error.status === 404) {
      return <NotFoundState message={query.error.message} />;
    }
    return <ErrorState error={query.error} />;
  }
  return <>{children(query.data)}</>;
}
