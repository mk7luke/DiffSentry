import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useFindings } from "../api/hooks";
import { Breadcrumbs } from "../components/Shell";
import { Card, PageHeader } from "../components/primitives";
import { SeverityBadge, TriageBadge } from "../components/badges";
import { TriageMenu } from "../components/TriageControls";
import { useAuth } from "../auth/useAuth";
import { EmptyState, QueryBoundary } from "../components/states";
import { pluralize, relativeTime } from "../lib/format";
import type { FindingExplorerRow } from "../api/types";

const PAGE = 100;

export function FindingsPage() {
  const [params, setParams] = useSearchParams();
  const { capabilities } = useAuth();
  const offset = Math.max(Number.parseInt(params.get("offset") ?? "0", 10) || 0, 0);

  const query = useFindings({
    severity: params.get("severity") ?? undefined,
    source: params.get("source") ?? undefined,
    repo: params.get("repo") ?? undefined,
    q: params.get("q") ?? undefined,
    fingerprint: params.get("fingerprint") ?? undefined,
    triage: params.get("triage") ?? undefined,
    age: params.get("age") ?? undefined,
    limit: PAGE,
    offset,
  });

  // Local form state seeded from the URL so typing doesn't refetch on each key.
  const [form, setForm] = useState(() => ({
    severity: params.get("severity") ?? "",
    source: params.get("source") ?? "",
    repo: params.get("repo") ?? "",
    q: params.get("q") ?? "",
    triage: params.get("triage") ?? "",
    age: params.get("age") ?? "",
  }));

  // Bulk-select state — finding ids checked for a bulk triage action.
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const clearSelection = () => setSelected(new Set());
  const toggleOne = (id: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleAll = (rows: FindingExplorerRow[]) =>
    setSelected((prev) => {
      const allSelected = rows.length > 0 && rows.every((r) => prev.has(r.id));
      if (allSelected) return new Set();
      return new Set(rows.map((r) => r.id));
    });

  const apply = (e: React.FormEvent) => {
    e.preventDefault();
    const next = new URLSearchParams();
    if (form.severity) next.set("severity", form.severity);
    if (form.source) next.set("source", form.source);
    if (form.repo.trim()) next.set("repo", form.repo.trim());
    if (form.q.trim()) next.set("q", form.q.trim());
    if (form.triage) next.set("triage", form.triage);
    if (form.age) next.set("age", form.age);
    const fp = params.get("fingerprint");
    if (fp) next.set("fingerprint", fp);
    clearSelection();
    setParams(next);
  };

  const reset = () => {
    setForm({ severity: "", source: "", repo: "", q: "", triage: "", age: "" });
    clearSelection();
    setParams(new URLSearchParams());
  };

  const setOffset = (o: number) => {
    const next = new URLSearchParams(params);
    if (o <= 0) next.delete("offset");
    else next.set("offset", String(o));
    clearSelection();
    setParams(next);
  };

  const fingerprint = params.get("fingerprint");

  return (
    <>
      <Breadcrumbs crumbs={[{ label: "Findings" }]} />
      <PageHeader title="Findings" subtitle="Every finding across all reviewed PRs — filter, search, and trace recurring issues." />

      {fingerprint ? (
        <div style={{ marginBottom: 14 }}>
          <span className="chip accent">fingerprint: {fingerprint.slice(0, 12)}…</span>{" "}
          <button
            className="btn btn-link"
            onClick={() => {
              const next = new URLSearchParams(params);
              next.delete("fingerprint");
              setParams(next);
            }}
          >
            clear
          </button>
        </div>
      ) : null}

      <form onSubmit={apply} className="card" style={{ marginBottom: 16 }}>
        <div className="filterbar">
          <label className="field">
            Severity
            <select value={form.severity} onChange={(e) => setForm({ ...form, severity: e.target.value })}>
              <option value="">any</option>
              <option value="critical">critical</option>
              <option value="major">major</option>
              <option value="minor">minor</option>
              <option value="nit">nit</option>
            </select>
          </label>
          <label className="field">
            Source
            <select value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })}>
              <option value="">any</option>
              <option value="ai">ai</option>
              <option value="safety">safety</option>
              <option value="builtin">builtin</option>
              <option value="custom">custom</option>
            </select>
          </label>
          <label className="field">
            Repo
            <input value={form.repo} onChange={(e) => setForm({ ...form, repo: e.target.value })} placeholder="owner/repo" />
          </label>
          <label className="field wide">
            Search path / title
            <input value={form.q} onChange={(e) => setForm({ ...form, q: e.target.value })} placeholder="e.g. src/server" />
          </label>
          <label className="field">
            Triage
            <select value={form.triage} onChange={(e) => setForm({ ...form, triage: e.target.value })}>
              <option value="">any</option>
              <option value="untriaged">untriaged</option>
              <option value="accepted">accepted</option>
              <option value="dismissed">dismissed</option>
              <option value="snoozed">snoozed</option>
            </select>
          </label>
          <label className="field">
            Age
            <select value={form.age} onChange={(e) => setForm({ ...form, age: e.target.value })}>
              <option value="">any</option>
              <option value="7">7 days</option>
              <option value="30">30 days</option>
              <option value="90">90 days</option>
            </select>
          </label>
        </div>
        <div className="filter-foot">
          <span className="hint">Filters apply on submit.</span>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="btn btn-link" onClick={reset}>
              Reset
            </button>
            <button type="submit" className="btn btn-primary">
              Apply filters
            </button>
          </div>
        </div>
      </form>

      <QueryBoundary query={query} loadingLabel="Loading findings…">
        {(data) => (
          <>
            {data.groups.length > 0 ? (
              <Card
                title="Recurring findings"
                subtitle={`${data.groups.length} fingerprint groups · seen 2+ times`}
                right={
                  <Link className="link" to="/findings/recurring">
                    Full recurring view →
                  </Link>
                }
                bodyClass="flush"
              >
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Severity</th>
                      <th>Title</th>
                      <th className="num">Occurrences</th>
                      <th className="num">Repos</th>
                      <th className="right">Last seen</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.groups.map((g) => (
                      <tr key={g.fingerprint}>
                        <td>
                          <SeverityBadge severity={g.severity} />
                        </td>
                        <td>
                          <button
                            className="btn btn-link"
                            style={{ padding: 0, color: "var(--accent-bright)" }}
                            onClick={() => {
                              const next = new URLSearchParams(params);
                              next.set("fingerprint", g.fingerprint);
                              next.delete("offset");
                              setParams(next);
                            }}
                          >
                            {g.title ?? "(untitled)"}
                          </button>
                        </td>
                        <td className="num strong">{g.occurrences}</td>
                        <td className="num">{g.repos}</td>
                        <td className="right muted">{relativeTime(g.last_seen)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            ) : null}

            <div style={{ marginTop: data.groups.length > 0 ? 16 : 0 }}>
              <Card
                title="All findings"
                subtitle={`${data.total.toLocaleString()} ${pluralize(data.total, "match", "matches")}`}
                right={
                  capabilities.triageFindings && selected.size > 0 ? (
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                      <span className="chip accent">{selected.size} selected</span>
                      <TriageMenu
                        target={{ kind: "bulk", ids: [...selected] }}
                        label="Triage selected"
                        variant="primary"
                        onDone={clearSelection}
                      />
                      <button className="btn btn-link" onClick={clearSelection}>
                        clear
                      </button>
                    </span>
                  ) : undefined
                }
                bodyClass="flush"
              >
                {data.rows.length === 0 ? (
                  <EmptyState title="No findings match" hint="Try widening the filters above." />
                ) : (
                  <>
                    <table className="tbl rail">
                      <thead>
                        <tr>
                          {capabilities.triageFindings ? (
                            <th style={{ width: 28 }}>
                              <input
                                type="checkbox"
                                aria-label="Select all on this page"
                                checked={data.rows.length > 0 && data.rows.every((r) => selected.has(r.id))}
                                onChange={() => toggleAll(data.rows)}
                              />
                            </th>
                          ) : null}
                          <th>Severity</th>
                          <th>Repo</th>
                          <th>PR</th>
                          <th>Location</th>
                          <th>Title</th>
                          <th>Source</th>
                          <th>Triage</th>
                          <th className="right">When</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.rows.map((f) => (
                          <tr key={f.id} data-sev={(f.severity ?? "").toLowerCase()}>
                            {capabilities.triageFindings ? (
                              <td>
                                <input
                                  type="checkbox"
                                  aria-label={`Select finding ${f.id}`}
                                  checked={selected.has(f.id)}
                                  onChange={() => toggleOne(f.id)}
                                />
                              </td>
                            ) : null}
                            <td>
                              <SeverityBadge severity={f.severity} />
                            </td>
                            <td className="mono">
                              <Link className="link" to={`/repos/${encodeURIComponent(f.owner)}/${encodeURIComponent(f.repo)}`}>
                                {f.owner}/{f.repo}
                              </Link>
                            </td>
                            <td className="mono">
                              <Link
                                className="link"
                                to={`/repos/${encodeURIComponent(f.owner)}/${encodeURIComponent(f.repo)}/pr/${f.number}`}
                              >
                                #{f.number}
                              </Link>
                            </td>
                            <td className="mono">
                              {f.path ?? ""}
                              {f.line ? <span className="line-num">:{f.line}</span> : null}
                            </td>
                            <td className="strong">{f.title ?? "—"}</td>
                            <td className="muted">{f.source ?? "—"}</td>
                            <td>
                              <div style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                                <TriageBadge row={f} />
                                <TriageMenu target={{ kind: "single", id: f.id }} compact />
                              </div>
                            </td>
                            <td className="right muted">{relativeTime(f.created_at)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <div className="filter-foot">
                      <span className="hint">
                        Showing {offset + 1}–{offset + data.rows.length} of {data.total.toLocaleString()}
                      </span>
                      <div style={{ display: "flex", gap: 8 }}>
                        <button
                          className="btn btn-ghost"
                          disabled={offset <= 0}
                          aria-disabled={offset <= 0}
                          onClick={() => setOffset(Math.max(0, offset - PAGE))}
                        >
                          ← Prev
                        </button>
                        <button
                          className="btn btn-ghost"
                          disabled={offset + data.rows.length >= data.total}
                          aria-disabled={offset + data.rows.length >= data.total}
                          onClick={() => setOffset(offset + PAGE)}
                        >
                          Next →
                        </button>
                      </div>
                    </div>
                  </>
                )}
              </Card>
            </div>
          </>
        )}
      </QueryBoundary>
    </>
  );
}
