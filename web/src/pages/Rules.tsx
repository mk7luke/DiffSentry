import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useCreateRule,
  useCustomRules,
  useDeleteRule,
  useTestRule,
  useUpdateRule,
} from "../api/hooks";
import { useAuth } from "../auth/useAuth";
import { Breadcrumbs } from "../components/Shell";
import { Card, Chip, Metric, PageHeader } from "../components/primitives";
import { EmptyState, LoadingState, QueryBoundary } from "../components/states";
import { useEventStream, type StreamEnvelope } from "../realtime/useEventStream";
import { ApiError } from "../api/client";
import type { CustomRuleInput, CustomRuleRow, RuleSeverity, RuleType } from "../api/types";
import { pluralize, relativeTime } from "../lib/format";

const SEVERITIES: RuleSeverity[] = ["critical", "major", "minor", "trivial"];
const TYPES: RuleType[] = ["issue", "suggestion", "nitpick", "documentation", "security"];

const SEV_TONE: Record<string, "sev-crit" | "sev-major" | "sev-minor" | "sev-nit"> = {
  critical: "sev-crit",
  major: "sev-major",
  minor: "sev-minor",
  trivial: "sev-nit",
};

/** Admin-only screen. The nav link is hidden for non-admins; this guards a
 * direct visit (and the server returns 403 on every /rules call regardless). */
export function RulesPage() {
  const { capabilities, isLoading } = useAuth();

  if (isLoading) {
    return (
      <>
        <Breadcrumbs crumbs={[{ label: "Custom rules" }]} />
        <PageHeader title="Custom rules" subtitle="Admin only." />
        <LoadingState label="Loading…" />
      </>
    );
  }

  if (!capabilities.manageConfig) {
    return (
      <>
        <Breadcrumbs crumbs={[{ label: "Custom rules" }]} />
        <PageHeader title="Custom rules" subtitle="Admin only." />
        <section className="card tone-danger">
          <div className="empty">
            <div className="mono" style={{ color: "var(--sev-crit)", fontSize: 11, letterSpacing: "0.12em", marginBottom: 8 }}>
              403 · FORBIDDEN
            </div>
            <div className="title">You need the admin role to manage custom rules.</div>
          </div>
        </section>
      </>
    );
  }

  return <RulesContent />;
}

function RulesContent() {
  const query = useCustomRules(true);
  const qc = useQueryClient();
  const [editing, setEditing] = useState<CustomRuleRow | null>(null);

  // Live-refresh when any client adds/edits/removes a rule.
  const onEvent = useCallback(
    (env: StreamEnvelope) => {
      if (env.topic === "rule.changed") void qc.invalidateQueries({ queryKey: ["rules"] });
    },
    [qc],
  );
  useEventStream(onEvent);

  return (
    <>
      <Breadcrumbs crumbs={[{ label: "Custom rules" }]} />
      <PageHeader
        title="Custom rules"
        subtitle="Author project-specific anti-pattern checks. Each enabled rule compiles into the review engine alongside the built-ins; matches show up in pattern analytics."
      />

      <QueryBoundary query={query} loadingLabel="Loading custom rules…">
        {(data) => {
          const rules = data.rules;
          const active = rules.filter((r) => r.enabled).length;
          const totalHits = rules.reduce((n, r) => n + r.hits_total, 0);
          const hits30 = rules.reduce((n, r) => n + r.hits_30d, 0);
          return (
            <>
              <div className="grid three" style={{ marginBottom: 16 }}>
                <Metric label="Active rules" value={active} />
                <Metric label="Hits · 30D" value={hits30.toLocaleString()} />
                <Metric label="Hits · total" value={totalHits.toLocaleString()} />
              </div>

              <RuleBuilder editing={editing} onDone={() => setEditing(null)} />

              <div style={{ marginTop: 16 }}>
                <ActiveRules rules={rules} onEdit={setEditing} />
              </div>
            </>
          );
        }}
      </QueryBoundary>
    </>
  );
}

interface FormState {
  name: string;
  scope: string;
  severity: RuleSeverity;
  type: RuleType;
  pattern: string;
  flags: string;
  pathGlob: string;
  message: string;
  advice: string;
  enabled: boolean;
}

const EMPTY_FORM: FormState = {
  name: "",
  scope: "global",
  severity: "minor",
  type: "suggestion",
  pattern: "",
  flags: "",
  pathGlob: "",
  message: "",
  advice: "",
  enabled: true,
};

function formFromRule(r: CustomRuleRow): FormState {
  return {
    name: r.name,
    scope: r.scope,
    severity: (SEVERITIES.includes(r.severity as RuleSeverity) ? r.severity : "minor") as RuleSeverity,
    type: (TYPES.includes(r.type as RuleType) ? r.type : "suggestion") as RuleType,
    pattern: r.pattern,
    flags: r.flags ?? "",
    pathGlob: r.path_glob ?? "",
    message: r.message ?? "",
    advice: r.advice ?? "",
    enabled: r.enabled === 1,
  };
}

/** The rule builder + an inline live tester. Doubles as the edit form. */
function RuleBuilder({ editing, onDone }: { editing: CustomRuleRow | null; onDone: () => void }) {
  const create = useCreateRule();
  const update = useUpdateRule();
  const [form, setForm] = useState<FormState>(EMPTY_FORM);

  // Load the rule being edited into the form (and reset when leaving edit mode).
  useEffect(() => {
    setForm(editing ? formFromRule(editing) : EMPTY_FORM);
  }, [editing]);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => ({ ...f, [k]: v }));

  const toInput = (): CustomRuleInput => ({
    name: form.name.trim(),
    scope: form.scope.trim() || "global",
    severity: form.severity,
    type: form.type,
    pattern: form.pattern,
    flags: form.flags.trim() || null,
    pathGlob: form.pathGlob.trim() || null,
    message: form.message.trim() || null,
    advice: form.advice.trim() || null,
    enabled: form.enabled,
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim() || !form.pattern) return;
    if (editing) {
      update.mutate({ id: editing.id, ...toInput() }, { onSuccess: () => onDone() });
    } else {
      create.mutate(toInput(), { onSuccess: () => setForm(EMPTY_FORM) });
    }
  };

  const busy = create.isPending || update.isPending;
  const mutErr =
    (create.error instanceof ApiError && create.error.message) ||
    (update.error instanceof ApiError && update.error.message) ||
    null;

  return (
    <Card
      title={editing ? `Edit rule · #${editing.id}` : "New rule"}
      subtitle={
        editing
          ? "Update the rule below, or cancel to discard your changes."
          : "Define an anti-pattern. Regex is tested against added lines; an optional path glob narrows the scope."
      }
    >
      <form onSubmit={submit} className="rule-form">
        <div className="rule-grid">
          <label className="field">
            Name
            <input
              value={form.name}
              onChange={(e) => set("name", e.target.value)}
              placeholder="No raw console.log"
              autoComplete="off"
            />
          </label>
          <label className="field">
            Scope
            <input
              value={form.scope}
              onChange={(e) => set("scope", e.target.value)}
              placeholder="global or owner/repo"
              autoComplete="off"
            />
          </label>
          <label className="field">
            Severity
            <select value={form.severity} onChange={(e) => set("severity", e.target.value as RuleSeverity)}>
              {SEVERITIES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Type
            <select value={form.type} onChange={(e) => set("type", e.target.value as RuleType)}>
              {TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="rule-grid pattern-row">
          <label className="field grow">
            Pattern (regex)
            <input
              className="mono"
              value={form.pattern}
              onChange={(e) => set("pattern", e.target.value)}
              placeholder="console\.log\("
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <label className="field flags">
            Flags
            <input
              className="mono"
              value={form.flags}
              onChange={(e) => set("flags", e.target.value)}
              placeholder="i"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <label className="field">
            Path glob (optional)
            <input
              className="mono"
              value={form.pathGlob}
              onChange={(e) => set("pathGlob", e.target.value)}
              placeholder="**/*.ts"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
        </div>

        <div className="rule-grid">
          <label className="field grow">
            Message (optional)
            <input
              value={form.message}
              onChange={(e) => set("message", e.target.value)}
              placeholder="Explain why this is flagged"
              autoComplete="off"
            />
          </label>
          <label className="field grow">
            Suggested fix (optional)
            <input
              value={form.advice}
              onChange={(e) => set("advice", e.target.value)}
              placeholder="How to resolve it"
              autoComplete="off"
            />
          </label>
        </div>

        <div className="rule-actions">
          <label className="rule-enable">
            <input type="checkbox" checked={form.enabled} onChange={(e) => set("enabled", e.target.checked)} />
            Enabled
          </label>
          <div style={{ flex: 1 }} />
          {editing ? (
            <button type="button" className="btn btn-ghost" onClick={onDone} disabled={busy}>
              Cancel
            </button>
          ) : null}
          <button type="submit" className="btn btn-primary" disabled={busy || !form.name.trim() || !form.pattern}>
            {busy ? "Saving…" : editing ? "Save changes" : "Create rule"}
          </button>
        </div>
        {mutErr ? <p style={{ color: "var(--sev-crit)", fontSize: 12.5, marginTop: 4 }}>{mutErr}</p> : null}
      </form>

      <LiveTester pattern={form.pattern} flags={form.flags} pathGlob={form.pathGlob} />
    </Card>
  );
}

/** Debounced live tester — runs the current pattern against a pasted snippet. */
function LiveTester({ pattern, flags, pathGlob }: { pattern: string; flags: string; pathGlob: string }) {
  const test = useTestRule();
  const [snippet, setSnippet] = useState("");
  const [filename, setFilename] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mutate = test.mutate;

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (!pattern || !snippet.trim()) return;
    timer.current = setTimeout(() => {
      mutate({
        pattern,
        flags: flags.trim() || undefined,
        pathGlob: pathGlob.trim() || undefined,
        filename: filename.trim() || undefined,
        snippet,
      });
    }, 350);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [pattern, flags, pathGlob, filename, snippet, mutate]);

  const result = test.data;
  const matchedLines = useMemo(() => new Set((result?.matches ?? []).map((m) => m.line)), [result]);
  const lines = snippet.split("\n");

  return (
    <div className="tester">
      <div className="tester-head">
        <h3>Live tester</h3>
        <span className="hint">Paste a snippet (or a raw diff). Matches highlight as you type.</span>
      </div>
      <div className="rule-grid">
        <label className="field">
          Filename (optional — exercises the path glob)
          <input
            className="mono"
            value={filename}
            onChange={(e) => setFilename(e.target.value)}
            placeholder="src/server.ts"
            autoComplete="off"
            spellCheck={false}
          />
        </label>
      </div>
      <label className="field" style={{ marginTop: 10 }}>
        Snippet
        <textarea
          className="mono"
          rows={6}
          value={snippet}
          onChange={(e) => setSnippet(e.target.value)}
          placeholder={"const debug = true;\nconsole.log(debug);"}
          spellCheck={false}
        />
      </label>

      <div className="tester-result">
        {!pattern ? (
          <span className="hint">Enter a pattern above to test it.</span>
        ) : !snippet.trim() ? (
          <span className="hint">Paste a snippet to see matches.</span>
        ) : test.isPending ? (
          <span className="hint">Testing…</span>
        ) : result && !result.ok ? (
          <span style={{ color: "var(--sev-crit)" }}>Invalid pattern: {result.error}</span>
        ) : result && pathGlob.trim() && !result.applies ? (
          <span style={{ color: "var(--sev-major)" }}>
            Path glob <code className="mono">{pathGlob}</code> doesn't match{" "}
            <code className="mono">{filename || "(no filename)"}</code> — rule wouldn't run on this file.
          </span>
        ) : result ? (
          <span className={result.matches.length > 0 ? "ok" : "hint"}>
            {result.matches.length > 0
              ? `${result.matches.length} ${pluralize(result.matches.length, "match", "matches")} on ${result.matches.length === 1 ? "line" : "lines"} ${result.matches.map((m) => m.line).join(", ")}`
              : "No matches."}
          </span>
        ) : null}
      </div>

      {result?.ok && result.matches.length > 0 ? (
        <pre className="tester-snippet">
          {lines.map((ln, i) => (
            <div key={i} className={matchedLines.has(i + 1) ? "line hit" : "line"}>
              <span className="ln">{i + 1}</span>
              <span className="src">{ln || " "}</span>
            </div>
          ))}
        </pre>
      ) : null}
    </div>
  );
}

function ActiveRules({ rules, onEdit }: { rules: CustomRuleRow[]; onEdit: (r: CustomRuleRow) => void }) {
  const update = useUpdateRule();
  const del = useDeleteRule();

  const toggle = (r: CustomRuleRow) => update.mutate({ id: r.id, enabled: r.enabled !== 1 });
  const remove = (r: CustomRuleRow) => {
    if (window.confirm(`Delete rule "${r.name}"? This can't be undone.`)) del.mutate(r.id);
  };
  const busy = update.isPending || del.isPending;

  return (
    <Card title="Active rules" subtitle={`${rules.length} ${pluralize(rules.length, "rule", "rules")} · hit-counts joined from pattern analytics`} bodyClass="flush">
      {rules.length === 0 ? (
        <EmptyState title="No custom rules yet" hint="Create one above — it starts firing on the next review." />
      ) : (
        <table className="tbl">
          <thead>
            <tr>
              <th>Rule</th>
              <th>Scope</th>
              <th>Severity</th>
              <th>Pattern</th>
              <th className="num">Hits · 30d</th>
              <th className="num">Hits · total</th>
              <th>Last hit</th>
              <th>Status</th>
              <th className="right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rules.map((r) => (
              <tr key={r.id}>
                <td className="strong">{r.name}</td>
                <td className="mono muted">{r.scope}</td>
                <td>
                  <Chip tone={SEV_TONE[r.severity] ?? "neutral"}>{r.severity}</Chip>
                </td>
                <td className="mono" style={{ maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.pattern}>
                  {r.pattern}
                  {r.flags ? <span className="muted"> /{r.flags}</span> : null}
                </td>
                <td className={`num ${r.hits_30d > 0 ? "strong" : "zero"}`}>{r.hits_30d}</td>
                <td className="num">{r.hits_total}</td>
                <td className="muted">{r.last_hit ? relativeTime(r.last_hit) : "—"}</td>
                <td>
                  <button
                    className={`pill-toggle ${r.enabled ? "on" : "off"}`}
                    onClick={() => toggle(r)}
                    disabled={busy}
                    title={r.enabled ? "Disable rule" : "Enable rule"}
                  >
                    {r.enabled ? "Enabled" : "Disabled"}
                  </button>
                </td>
                <td className="right">
                  <button className="btn btn-link" onClick={() => onEdit(r)} disabled={busy}>
                    Edit
                  </button>
                  <button className="btn btn-link" onClick={() => remove(r)} disabled={busy} style={{ color: "var(--sev-crit)" }}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}
