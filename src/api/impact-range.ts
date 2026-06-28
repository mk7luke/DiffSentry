// Impact-report range parsing + the time-saved heuristic. Extracted so both the
// authed `/impact` endpoint (router.ts) and the public share endpoint
// (shares.ts) parse ranges identically — a share viewer's range selector and
// the dashboard's must agree on what "30d" / "all" mean.

// Supported impact ranges. Bare numbers (e.g. "30") are also accepted and
// clamped to [1, 365]; "all" / "max" means all-time (no lower bound).
export const IMPACT_RANGES: Record<string, { days: number | null; label: string }> = {
  "7d": { days: 7, label: "Last 7 days" },
  "14d": { days: 14, label: "Last 14 days" },
  "30d": { days: 30, label: "Last 30 days" },
  "90d": { days: 90, label: "Last 90 days" },
  "180d": { days: 180, label: "Last 180 days" },
  "365d": { days: 365, label: "Last 12 months" },
  all: { days: null, label: "All time" },
  max: { days: null, label: "All time" },
};

export function parseImpactRange(raw: unknown): { days: number | null; label: string } {
  if (typeof raw !== "string" || raw.length === 0) return IMPACT_RANGES["30d"];
  const key = raw.toLowerCase();
  if (key in IMPACT_RANGES) return IMPACT_RANGES[key];
  const n = Number.parseInt(key, 10);
  if (Number.isFinite(n) && n > 0) {
    const days = Math.min(Math.max(n, 1), 365);
    return { days, label: `Last ${days} days` };
  }
  return IMPACT_RANGES["30d"];
}

/** Canonical, storable key for a requested range ("7d" … "365d" | "all"). Used
 *  when persisting a share's preferred range so it round-trips cleanly. */
export function canonicalRangeKey(raw: unknown): string {
  const r = parseImpactRange(raw);
  return r.days == null ? "all" : `${r.days}d`;
}

/** Reviewer-minutes saved per finding heuristic, from env (default 15). */
export function impactMinutesPerFinding(): number {
  const raw = process.env.IMPACT_MINUTES_PER_FINDING;
  if (!raw) return 15;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : 15;
}
