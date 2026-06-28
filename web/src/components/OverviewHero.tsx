import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useImpact } from "../api/hooks";
import { useEventStream, type StreamEnvelope } from "../realtime/useEventStream";
import { formatCompact, formatMinutesSaved, pluralize } from "../lib/format";
import { ClockIcon, ImpactIcon, ShieldIcon } from "./icons";

// ── useCountUp ──────────────────────────────────────────────────────
// Animate a displayed integer toward `target`, easing out over `durationMs`.
// Starts from 0 on mount (so the headline rolls up on load) and re-animates
// from wherever it is whenever `target` moves — e.g. when a realtime tick or a
// refetch nudges the number. Honors prefers-reduced-motion by snapping.
function useCountUp(target: number, durationMs = 950): number {
  const [display, setDisplay] = useState(0);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce || !Number.isFinite(target)) {
      setDisplay(Math.max(0, Math.round(target) || 0));
      return;
    }

    // Capture the value we're animating from without re-subscribing on every
    // displayed frame (display is intentionally excluded from deps).
    let from = 0;
    setDisplay((cur) => {
      from = cur;
      return cur;
    });
    if (from === target) return;

    let start = 0;
    const tick = (now: number) => {
      if (!start) start = now;
      const t = Math.min(1, (now - start) / durationMs);
      const eased = 1 - Math.pow(1 - t, 3); // easeOutCubic
      setDisplay(Math.round(from + (target - from) * eased));
      if (t < 1) rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [target, durationMs]);

  return display;
}

// The hero leads the Overview: a big caught-issues headline, a time-saved
// aside (same estimate the Impact report uses), and a link into that report.
// It owns its own 7-day Impact query so it degrades independently of the repo
// grid below — a slow or empty impact response never blanks the page.
export function OverviewHero() {
  const query = useImpact("7d");
  const qc = useQueryClient();

  // Optimistic ticks layered on top of the authoritative caught count. A
  // matching realtime event bumps this for instant feedback; a refetch then
  // folds the real number back in and resets the bonus to zero (see below).
  const [bonus, setBonus] = useState(0);
  const caught = query.data?.current.criticalMajorCaughtBeforeMerge ?? 0;

  // Whenever the authoritative number changes (initial load or refetch), drop
  // any optimistic bonus so we never double-count a finding the server already
  // included.
  useEffect(() => {
    setBonus(0);
  }, [caught]);

  const onEvent = useCallback(
    (env: StreamEnvelope) => {
      // Only the hero's own 7-day window — don't refetch whatever range the
      // Impact page happens to be showing. Prefix-matches useImpact("7d")'s
      // ["impact", "7d", null] cache entry.
      const refetch7d = () => void qc.invalidateQueries({ queryKey: ["impact", "7d"] });
      if (env.topic === "finding.surfaced") {
        const sev = (env.payload as { severity?: string } | null)?.severity;
        if (sev === "critical" || sev === "major") setBonus((b) => b + 1);
        refetch7d();
      } else if (env.topic === "review.finished") {
        // A finished review may have caught new issues — pull the real numbers.
        refetch7d();
      }
    },
    [qc],
  );
  useEventStream(onEvent);

  const headline = useCountUp(caught + bonus);

  // First paint with no cached data — render a sized skeleton so the page
  // doesn't jump when the real hero arrives.
  if (query.isLoading && !query.data) {
    return (
      <section
        className="ov-hero ov-hero-skeleton"
        role="status"
        aria-busy="true"
        aria-label="Loading impact summary…"
      />
    );
  }

  // If impact ever errors, stay quiet rather than showing a broken hero; the
  // repo grid below still tells the story.
  if (!query.data) return null;

  const report = query.data;
  const c = report.current;
  const hasData = c.reviews > 0 || c.findings > 0;
  const saved = formatMinutesSaved(c.timeSavedMinutes);

  // ── First-run: a welcoming hero, never an empty one. ──────────────
  if (!hasData) {
    return (
      <section className="ov-hero ov-hero-firstrun">
        <div className="ov-hero-main">
          <div className="ov-hero-eyebrow">
            <ShieldIcon /> DiffSentry · on watch
          </div>
          <div className="ov-hero-headline">
            <span className="rest rest-lead">
              Reviewing every pull request,
              <br />
              catching issues before they merge
            </span>
          </div>
          <div className="ov-hero-sub">
            Open or update a pull request in an installed repo and DiffSentry starts
            surfacing findings here — critical &amp; major issues caught, and reviewer
            time saved.
          </div>
          <Link className="ov-hero-cta" to="/impact">
            See how impact is measured <span aria-hidden>→</span>
          </Link>
        </div>
        <div className="ov-hero-aside">
          <div className="ov-hero-aside-icon">
            <ClockIcon />
          </div>
          <div className="ov-hero-aside-value">0</div>
          <div className="ov-hero-aside-unit">issues caught so far</div>
          <div className="ov-hero-aside-note">waiting on your first review</div>
        </div>
      </section>
    );
  }

  return (
    <section className="ov-hero">
      <div className="ov-hero-main">
        <div className="ov-hero-eyebrow">
          <ImpactIcon /> DiffSentry · {report.range.label.toLowerCase()}
        </div>
        <div className="ov-hero-headline">
          <span className="big" aria-label={`${formatCompact(caught + bonus)} caught`}>
            {formatCompact(headline)}
          </span>
          <span className="rest">
            critical &amp; major {pluralize(caught + bonus, "issue")} caught
            <br />
            before merge
          </span>
        </div>
        <div className="ov-hero-sub">
          on <b>{formatCompact(c.mergedPrsCovered)}</b> merged{" "}
          {pluralize(c.mergedPrsCovered, "PR")} · ~<b>{saved.value} {saved.unit}</b> of
          reviewer time saved
        </div>
        <Link className="ov-hero-cta" to="/impact">
          View impact report <span aria-hidden>→</span>
        </Link>
      </div>
      <div className="ov-hero-aside">
        <div className="ov-hero-aside-icon">
          <ClockIcon />
        </div>
        <div className="ov-hero-aside-value">{saved.value}</div>
        <div className="ov-hero-aside-unit">{saved.unit} saved</div>
        <div className="ov-hero-aside-note">≈ {report.minutesPerFinding} min/finding</div>
      </div>
    </section>
  );
}
