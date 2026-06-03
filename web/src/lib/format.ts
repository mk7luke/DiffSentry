// Pure formatting helpers — ported from the primitive helpers in
// src/dashboard/layout.ts so the SPA renders identical labels and series.

import type { DailyActivityRow, Severity } from "../api/types";

export interface DayBin {
  day: string; // YYYY-MM-DD
  reviews: number;
  critical: number;
  major: number;
  minor: number;
  nit: number;
}

/** Relative "3h ago" style timestamps; falls back to YYYY-MM-DD past 30 days. */
export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return "";
  const diff = Date.now() - ts;
  const min = Math.round(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(ts).toISOString().slice(0, 10);
}

/** Build an empty N-day series ending today, then merge real bins into it. */
export function buildDaySeries(bins: DayBin[], days: number): DayBin[] {
  const byDay = new Map(bins.map((b) => [b.day, b]));
  const out: DayBin[] = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    const key = d.toISOString().slice(0, 10);
    out.push(byDay.get(key) ?? { day: key, reviews: 0, critical: 0, major: 0, minor: 0, nit: 0 });
  }
  return out;
}

/** DailyActivityRow[] → DayBin[] (drops owner/repo). */
export function toDayBins(rows: DailyActivityRow[]): DayBin[] {
  return rows.map((r) => ({
    day: r.day,
    reviews: r.reviews,
    critical: r.critical,
    major: r.major,
    minor: r.minor,
    nit: r.nit,
  }));
}

/** Group activity rows by "owner/repo". */
export function groupActivityByRepo(rows: DailyActivityRow[]): Map<string, DayBin[]> {
  const out = new Map<string, DayBin[]>();
  for (const r of rows) {
    const key = `${r.owner}/${r.repo}`;
    const arr = out.get(key) ?? [];
    arr.push({ day: r.day, reviews: r.reviews, critical: r.critical, major: r.major, minor: r.minor, nit: r.nit });
    out.set(key, arr);
  }
  return out;
}

/** Classify a repo's 7d activity into a health tier for card coloring. */
export function repoHealth(prs: number, findings: number, critical: number): "idle" | "good" | "warn" | "crit" {
  if (prs === 0) return "idle";
  if (critical > 0) return "crit";
  if (findings > 4) return "warn";
  return "good";
}

export function pluralize(n: number, one: string, many = `${one}s`): string {
  return n === 1 ? one : many;
}

export function formatBytes(bytes: number | null): string {
  if (bytes == null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
}

export const SEVERITY_ORDER: Severity[] = ["critical", "major", "minor", "nit"];

/** Format a USD amount. Sub-cent values get more precision so they aren't $0.00. */
export function formatUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "$0.00";
  if (n === 0) return "$0.00";
  if (Math.abs(n) < 0.01) return `$${n.toFixed(4)}`;
  if (Math.abs(n) < 1) return `$${n.toFixed(3)}`;
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Compact token counts: 950, 12.3k, 4.1M. */
export function formatTokens(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "0";
  const abs = Math.abs(n);
  if (abs < 1000) return String(Math.round(n));
  if (abs < 1_000_000) return `${(n / 1000).toFixed(abs < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(abs < 10_000_000 ? 1 : 0)}M`;
}
