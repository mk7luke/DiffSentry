import type { Report } from "./store.js";

export type TagCount = { tag: string; count: number };

const TAGS_SERVICE_URL = process.env.TAGS_SERVICE_URL ?? "http://tags.internal";

async function fetchTagsForReport(reportId: number): Promise<string[]> {
  const res = await fetch(`${TAGS_SERVICE_URL}/reports/${reportId}/tags`);
  if (!res.ok) return [];
  return (await res.json()) as string[];
}

/** Builds a count of how many reports carry each tag, for the digest endpoint. */
export async function buildTagDigest(reports: Report[]): Promise<TagCount[]> {
  const counts = new Map<string, number>();
  for (const report of reports) {
    const tags = await fetchTagsForReport(report.id);
    for (const tag of tags) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return [...counts.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count);
}
