import { useCallback, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useBulkDeleteLearnings,
  useCreateGlobalLearning,
  useCreateLearning,
  useDeleteGlobalLearning,
  useDeleteLearning,
  useLearnings,
  usePromoteLearning,
  useTestLearning,
  useUpdateGlobalLearning,
  useUpdateLearning,
  type BulkDeleteRef,
  type LearningWrite,
} from "../api/hooks";
import { useAuth } from "../auth/useAuth";
import { useEventStream } from "../realtime/useEventStream";
import { Breadcrumbs } from "../components/Shell";
import { Card, Chip, PageHeader } from "../components/primitives";
import { EmptyState, QueryBoundary } from "../components/states";
import { ApiError } from "../api/client";
import type { DuplicateGroup, Learning } from "../api/types";
import { pluralize, relativeTime } from "../lib/format";

// A learning plus the scope it lives in — the unit the page renders, selects,
// edits and deletes. `repoLabel` is the owner/repo string ("" for global).
interface Item {
  scope: "global" | "repo";
  owner?: string;
  repo?: string;
  repoLabel: string;
  learning: Learning;
}

function keyOf(it: Item): string {
  return it.scope === "global" ? `g:${it.learning.id}` : `r:${it.repoLabel}:${it.learning.id}`;
}

function errText(err: unknown): string | null {
  if (err instanceof ApiError) return err.message;
  return err ? "Something went wrong." : null;
}

export function LearningsPage() {
  const qc = useQueryClient();
  const query = useLearnings();

  // Refresh when anyone (including other sessions) changes a learning.
  const onEvent = useCallback(
    (env: { topic: string }) => {
      if (env.topic === "learning.changed") void qc.invalidateQueries({ queryKey: ["learnings"] });
    },
    [qc],
  );
  useEventStream(onEvent);

  return (
    <>
      <Breadcrumbs crumbs={[{ label: "Learnings" }]} />
      <PageHeader
        title="Learnings"
        subtitle="Durable instructions the reviewer applies on future PRs. Global learnings apply to every repo; per-repo ones can be scoped to a path glob."
      />
      <QueryBoundary query={query} loadingLabel="Loading learnings…">
        {(data) => <LearningsContent data={data} />}
      </QueryBoundary>
    </>
  );
}

function LearningsContent({
  data,
}: {
  data: { global: Learning[]; repos: { owner: string; repo: string; learnings: Learning[] }[]; duplicates: DuplicateGroup[] };
}) {
  const { capabilities } = useAuth();
  const canWrite = capabilities.triggerReview;

  // Flatten into render units.
  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    for (const l of data.global) out.push({ scope: "global", repoLabel: "", learning: l });
    for (const r of data.repos) {
      for (const l of r.learnings) {
        out.push({ scope: "repo", owner: r.owner, repo: r.repo, repoLabel: `${r.owner}/${r.repo}`, learning: l });
      }
    }
    return out;
  }, [data]);

  const repoLabels = useMemo(() => data.repos.map((r) => `${r.owner}/${r.repo}`), [data.repos]);

  const [search, setSearch] = useState("");
  const [scopeFilter, setScopeFilter] = useState<string>("all"); // "all" | "global" | owner/repo
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((it) => {
      if (scopeFilter === "global" && it.scope !== "global") return false;
      if (scopeFilter !== "all" && scopeFilter !== "global" && it.repoLabel !== scopeFilter) return false;
      if (!q) return true;
      return (
        it.learning.content.toLowerCase().includes(q) ||
        (it.learning.path ?? "").toLowerCase().includes(q) ||
        it.repoLabel.toLowerCase().includes(q)
      );
    });
  }, [items, search, scopeFilter]);

  const toggle = useCallback((key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const bulkDelete = useBulkDeleteLearnings();
  const onBulkDelete = () => {
    const refs: BulkDeleteRef[] = filtered
      .filter((it) => selected.has(keyOf(it)))
      .map((it) => ({ scope: it.scope, owner: it.owner, repo: it.repo, id: it.learning.id }));
    if (refs.length === 0) return;
    bulkDelete.mutate(refs, { onSuccess: () => setSelected(new Set()) });
  };

  const selectedCount = filtered.filter((it) => selected.has(keyOf(it))).length;

  // Group filtered items: global first, then per repo (preserving repo order).
  const globalItems = filtered.filter((it) => it.scope === "global");
  const repoGroups = data.repos
    .map((r) => ({
      label: `${r.owner}/${r.repo}`,
      owner: r.owner,
      repo: r.repo,
      items: filtered.filter((it) => it.repoLabel === `${r.owner}/${r.repo}`),
    }))
    .filter((g) => g.items.length > 0);

  return (
    <>
      {canWrite ? <NewLearningCard repoLabels={repoLabels} /> : null}

      {data.duplicates.length > 0 ? <DuplicatesCard groups={data.duplicates} canWrite={canWrite} /> : null}

      <TestSnippetCard repoLabels={repoLabels} />

      <Card
        title="All learnings"
        subtitle={`${items.length} total · ${data.global.length} global · ${pluralize(data.repos.length, "repo")}`}
        right={
          <div className="learn-toolbar">
            <input
              type="search"
              placeholder="Search content, path or repo…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ width: 240 }}
            />
            <select value={scopeFilter} onChange={(e) => setScopeFilter(e.target.value)}>
              <option value="all">all scopes</option>
              <option value="global">global only</option>
              {repoLabels.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
            {canWrite ? (
              <button
                className="btn btn-ghost"
                disabled={selectedCount === 0 || bulkDelete.isPending}
                aria-disabled={selectedCount === 0 || bulkDelete.isPending}
                onClick={onBulkDelete}
              >
                {bulkDelete.isPending ? "Deleting…" : `Delete ${selectedCount || ""} selected`.trim()}
              </button>
            ) : null}
          </div>
        }
        bodyClass="flush"
      >
        {filtered.length === 0 ? (
          <EmptyState
            title={items.length === 0 ? "No learnings yet" : "No matches"}
            hint={
              items.length === 0
                ? "Use @bot learn … on a PR, or add one above, to teach the reviewer."
                : "Try a different search or scope filter."
            }
          />
        ) : (
          <>
            {globalItems.length > 0 ? (
              <LearningGroup
                heading="Global"
                subheading="Applied to every repository"
                items={globalItems}
                canWrite={canWrite}
                selected={selected}
                onToggle={toggle}
              />
            ) : null}
            {repoGroups.map((g) => (
              <LearningGroup
                key={g.label}
                heading={g.label}
                items={g.items}
                canWrite={canWrite}
                selected={selected}
                onToggle={toggle}
              />
            ))}
          </>
        )}
      </Card>
    </>
  );
}

function LearningGroup({
  heading,
  subheading,
  items,
  canWrite,
  selected,
  onToggle,
}: {
  heading: string;
  subheading?: string;
  items: Item[];
  canWrite: boolean;
  selected: Set<string>;
  onToggle: (key: string) => void;
}) {
  return (
    <div className="learn-group">
      <div className="learn-group-head">
        <span className="learn-group-title mono">{heading}</span>
        {subheading ? <span className="muted" style={{ fontSize: 11 }}>{subheading}</span> : null}
        <span className="muted" style={{ fontSize: 11 }}>
          {items.length} {pluralize(items.length, "learning")}
        </span>
      </div>
      {items.map((it) => (
        <LearningRow
          key={keyOf(it)}
          item={it}
          canWrite={canWrite}
          checked={selected.has(keyOf(it))}
          onToggle={() => onToggle(keyOf(it))}
        />
      ))}
    </div>
  );
}

function LearningRow({
  item,
  canWrite,
  checked,
  onToggle,
}: {
  item: Item;
  canWrite: boolean;
  checked: boolean;
  onToggle: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [content, setContent] = useState(item.learning.content);
  const [path, setPath] = useState(item.learning.path ?? "");

  const updateRepo = useUpdateLearning();
  const updateGlobal = useUpdateGlobalLearning();
  const deleteRepo = useDeleteLearning();
  const deleteGlobal = useDeleteGlobalLearning();
  const promote = usePromoteLearning();

  const pending =
    updateRepo.isPending ||
    updateGlobal.isPending ||
    deleteRepo.isPending ||
    deleteGlobal.isPending ||
    promote.isPending;

  const startEdit = () => {
    setContent(item.learning.content);
    setPath(item.learning.path ?? "");
    setEditing(true);
  };

  const save = () => {
    const write: LearningWrite = { content: content.trim(), path: path.trim() === "" ? null : path.trim() };
    if (!write.content) return;
    const onSuccess = () => setEditing(false);
    if (item.scope === "global") {
      updateGlobal.mutate({ id: item.learning.id, ...write }, { onSuccess });
    } else {
      updateRepo.mutate({ owner: item.owner!, repo: item.repo!, id: item.learning.id, ...write }, { onSuccess });
    }
  };

  const remove = () => {
    if (item.scope === "global") deleteGlobal.mutate({ id: item.learning.id });
    else deleteRepo.mutate({ owner: item.owner!, repo: item.repo!, id: item.learning.id });
  };

  const onPromote = () => {
    if (item.scope === "repo") promote.mutate({ owner: item.owner!, repo: item.repo!, id: item.learning.id });
  };

  const err =
    errText(updateRepo.error) ?? errText(updateGlobal.error) ?? errText(deleteRepo.error) ?? errText(deleteGlobal.error) ?? errText(promote.error);

  return (
    <div className="learn-row">
      {canWrite ? (
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggle}
          aria-label="Select learning"
          className="learn-check"
        />
      ) : (
        <span className="learn-check" />
      )}
      <div className="learn-main">
        {editing ? (
          <div className="learn-edit">
            <textarea value={content} onChange={(e) => setContent(e.target.value)} rows={3} />
            <input
              type="text"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="path glob (optional, e.g. src/**/*.ts) — blank = repo-wide"
            />
            <div className="learn-edit-actions">
              <button className="btn btn-primary" onClick={save} disabled={pending || !content.trim()}>
                {pending ? "Saving…" : "Save"}
              </button>
              <button className="btn btn-ghost" onClick={() => setEditing(false)} disabled={pending}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="learn-content">{item.learning.content}</div>
            <div className="learn-badges">
              {item.learning.path ? (
                <Chip tone="accent" title="Path glob this learning is scoped to">
                  {item.learning.path}
                </Chip>
              ) : (
                <Chip tone="muted">repo-wide</Chip>
              )}
              <span className="mono muted" style={{ fontSize: 10.5 }}>
                {relativeTime(item.learning.createdAt)}
              </span>
            </div>
          </>
        )}
        {err && !editing ? <p className="learn-err">{err}</p> : null}
      </div>
      {canWrite && !editing ? (
        <div className="learn-actions">
          <button className="btn btn-link" onClick={startEdit} disabled={pending}>
            Edit
          </button>
          {item.scope === "repo" ? (
            <button className="btn btn-link" onClick={onPromote} disabled={pending} title="Move to global (applies to all repos)">
              Promote
            </button>
          ) : null}
          <button className="btn btn-link danger" onClick={remove} disabled={pending}>
            Delete
          </button>
        </div>
      ) : null}
    </div>
  );
}

function NewLearningCard({ repoLabels }: { repoLabels: string[] }) {
  const [scope, setScope] = useState<"global" | "repo">("repo");
  const [target, setTarget] = useState(repoLabels[0] ?? "");
  const [content, setContent] = useState("");
  const [path, setPath] = useState("");

  const createRepo = useCreateLearning();
  const createGlobal = useCreateGlobalLearning();
  const pending = createRepo.isPending || createGlobal.isPending;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const body: LearningWrite = { content: content.trim(), path: path.trim() === "" ? undefined : path.trim() };
    if (!body.content) return;
    const reset = () => {
      setContent("");
      setPath("");
    };
    if (scope === "global") {
      createGlobal.mutate(body, { onSuccess: reset });
    } else {
      const t = target.trim();
      const slash = t.indexOf("/");
      if (slash <= 0 || slash === t.length - 1) return;
      createRepo.mutate({ owner: t.slice(0, slash), repo: t.slice(slash + 1), ...body }, { onSuccess: reset });
    }
  };

  const err = errText(createRepo.error) ?? errText(createGlobal.error);

  return (
    <Card title="Add a learning" subtitle="Stored in the same files the reviewer reads — applied on the next review.">
      <form onSubmit={submit} className="learn-form">
        <label className="field">
          Scope
          <select value={scope} onChange={(e) => setScope(e.target.value as "global" | "repo")}>
            <option value="repo">Repo</option>
            <option value="global">Global (all repos)</option>
          </select>
        </label>
        {scope === "repo" ? (
          <label className="field">
            Repo (owner/name)
            <input
              type="text"
              list="learn-repo-options"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              placeholder="owner/repo"
              autoComplete="off"
            />
            <datalist id="learn-repo-options">
              {repoLabels.map((r) => (
                <option key={r} value={r} />
              ))}
            </datalist>
          </label>
        ) : null}
        <label className="field" style={{ flex: "1 1 320px" }}>
          Content
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={2}
            placeholder="e.g. Prefer async/await over .then() chains in this service."
          />
        </label>
        <label className="field">
          Path glob (optional)
          <input type="text" value={path} onChange={(e) => setPath(e.target.value)} placeholder="src/**/*.ts" autoComplete="off" />
        </label>
        <button type="submit" className="btn btn-primary" disabled={pending || !content.trim() || (scope === "repo" && !target.trim())}>
          {pending ? "Adding…" : "Add learning"}
        </button>
      </form>
      {err ? <p className="learn-err">{err}</p> : null}
    </Card>
  );
}

function DuplicatesCard({ groups, canWrite }: { groups: DuplicateGroup[]; canWrite: boolean }) {
  const bulkDelete = useBulkDeleteLearnings();
  return (
    <Card
      title={`Possible duplicates (${groups.length})`}
      subtitle="Learnings with near-identical wording. Review and remove the redundant ones."
      tone="accent"
      bodyClass="flush"
    >
      {groups.map((g, i) => (
        <div className="learn-dup" key={i}>
          {g.members.map((m) => (
            <div className="learn-dup-row" key={`${m.scope}:${m.owner ?? ""}/${m.repo ?? ""}:${m.id}`}>
              <Chip tone={m.scope === "global" ? "accent" : "neutral"} uppercase>
                {m.scope === "global" ? "global" : `${m.owner}/${m.repo}`}
              </Chip>
              <span className="learn-dup-content">{m.content}</span>
              {canWrite ? (
                <button
                  className="btn btn-link danger"
                  disabled={bulkDelete.isPending}
                  onClick={() => bulkDelete.mutate([{ scope: m.scope, owner: m.owner, repo: m.repo, id: m.id }])}
                >
                  Delete
                </button>
              ) : null}
            </div>
          ))}
        </div>
      ))}
    </Card>
  );
}

function TestSnippetCard({ repoLabels }: { repoLabels: string[] }) {
  const [file, setFile] = useState("");
  const [target, setTarget] = useState("");
  const test = useTestLearning();

  const run = (e: React.FormEvent) => {
    e.preventDefault();
    const f = file.trim();
    if (!f) return;
    const t = target.trim();
    const slash = t.indexOf("/");
    const owner = slash > 0 ? t.slice(0, slash) : undefined;
    const repo = slash > 0 ? t.slice(slash + 1) : undefined;
    test.mutate({ path: f, owner, repo });
  };

  const err = errText(test.error);

  return (
    <Card
      title="Test against a file path"
      subtitle="Enter a file path to see which learnings the reviewer would apply (global + repo, matched by path glob)."
    >
      <form onSubmit={run} className="learn-form">
        <label className="field" style={{ flex: "1 1 280px" }}>
          File path
          <input type="text" value={file} onChange={(e) => setFile(e.target.value)} placeholder="src/api/server.ts" autoComplete="off" />
        </label>
        <label className="field">
          Repo (optional)
          <input
            type="text"
            list="learn-test-repo-options"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            placeholder="owner/repo"
            autoComplete="off"
          />
          <datalist id="learn-test-repo-options">
            {repoLabels.map((r) => (
              <option key={r} value={r} />
            ))}
          </datalist>
        </label>
        <button type="submit" className="btn btn-primary" disabled={test.isPending || !file.trim()}>
          {test.isPending ? "Testing…" : "Test"}
        </button>
      </form>
      {err ? <p className="learn-err">{err}</p> : null}
      {test.data ? (
        test.data.matched.length === 0 ? (
          <p className="muted" style={{ fontSize: 12.5, marginTop: 10 }}>
            No learnings would apply to <span className="mono">{test.data.path}</span>.
          </p>
        ) : (
          <ul className="learn-test-results">
            {test.data.matched.map((l) => (
              <li key={l.id}>
                {l.path ? <Chip tone="accent">{l.path}</Chip> : <Chip tone="muted">repo-wide</Chip>}
                <span>{l.content}</span>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </Card>
  );
}
