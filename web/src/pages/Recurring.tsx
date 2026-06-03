import { Link, useSearchParams } from "react-router-dom";
import { useRecurring } from "../api/hooks";
import { Breadcrumbs } from "../components/Shell";
import { Card, Chip, PageHeader } from "../components/primitives";
import { SeverityBadge } from "../components/badges";
import { TriageMenu } from "../components/TriageControls";
import { EmptyState, QueryBoundary } from "../components/states";
import { pluralize, relativeTime } from "../lib/format";
import type { RecurringFindingRow } from "../api/types";

// Recurring findings — fingerprints ranked by how often they reappear, with a
// per-class triage rollup so a whole class can be accepted or dismissed at once.

type RollupBit = { tone: "good" | "danger" | "warn" | "muted"; n: number; label: string };

function TriageRollup({ row }: { row: RecurringFindingRow }) {
  const all: RollupBit[] = [
    { tone: "good", n: row.accepted_count, label: "accepted" },
    { tone: "danger", n: row.dismissed_count, label: "dismissed" },
    { tone: "warn", n: row.snoozed_count, label: "snoozed" },
    { tone: "muted", n: row.untriaged_count, label: "untriaged" },
  ];
  const bits = all.filter((b) => b.n > 0);
  if (bits.length === 0) return <span className="muted">—</span>;
  return (
    <span style={{ display: "inline-flex", gap: 4, flexWrap: "wrap" }}>
      {bits.map((b) => (
        <Chip key={b.label} tone={b.tone} title={`${b.n} ${b.label}`}>
          {b.n} {b.label}
        </Chip>
      ))}
    </span>
  );
}

export function RecurringPage() {
  const [params] = useSearchParams();
  const query = useRecurring({
    severity: params.get("severity") ?? undefined,
    repo: params.get("repo") ?? undefined,
    triage: params.get("triage") ?? undefined,
    age: params.get("age") ?? undefined,
    limit: 100,
  });

  return (
    <>
      <Breadcrumbs crumbs={[{ label: "Findings", to: "/findings" }, { label: "Recurring" }]} />
      <PageHeader
        title="Recurring findings"
        subtitle="Fingerprints ranked by how often they reappear. Dismiss or accept a whole class in one click — class triage applies to every finding sharing the fingerprint."
      />

      <QueryBoundary query={query} loadingLabel="Loading recurring findings…">
        {(data) => (
          <Card title="Classes" subtitle={`${data.rows.length} ${pluralize(data.rows.length, "fingerprint", "fingerprints")} · seen 2+ times`} bodyClass="flush">
            {data.rows.length === 0 ? (
              <EmptyState title="No recurring findings" hint="A fingerprint needs to appear on 2+ findings to show here." />
            ) : (
              <table className="tbl rail">
                <thead>
                  <tr>
                    <th>Severity</th>
                    <th>Title</th>
                    <th className="num">Occurrences</th>
                    <th className="num">PRs</th>
                    <th className="num">Repos</th>
                    <th>Triage</th>
                    <th className="right">First → last</th>
                    <th className="right">Class action</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((g) => (
                    <tr key={g.fingerprint} data-sev={(g.severity ?? "").toLowerCase()}>
                      <td>
                        <SeverityBadge severity={g.severity} />
                      </td>
                      <td>
                        <Link className="link" to={`/findings?fingerprint=${encodeURIComponent(g.fingerprint)}`}>
                          {g.title ?? "(untitled)"}
                        </Link>
                        <div className="mono" style={{ fontSize: 10.5, color: "var(--text-4)" }}>
                          {g.fingerprint.slice(0, 16)}…
                        </div>
                      </td>
                      <td className="num strong">{g.occurrences}</td>
                      <td className="num">{g.prs}</td>
                      <td className="num">{g.repos}</td>
                      <td>
                        <TriageRollup row={g} />
                      </td>
                      <td className="right muted nowrap" title={`${g.first_seen} → ${g.last_seen}`}>
                        {relativeTime(g.first_seen)} → {relativeTime(g.last_seen)}
                      </td>
                      <td className="right">
                        <TriageMenu target={{ kind: "class", fingerprint: g.fingerprint }} label="Triage class" />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        )}
      </QueryBoundary>
    </>
  );
}
