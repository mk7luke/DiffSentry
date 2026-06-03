import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import yaml from "js-yaml";
import { useRepoConfig, useUpdateRepoConfig } from "../api/hooks";
import { useAuth } from "../auth/useAuth";
import { useToast } from "../realtime/toast";
import { Breadcrumbs } from "../components/Shell";
import { Card, PageHeader } from "../components/primitives";
import { QueryBoundary, EmptyState } from "../components/states";
import { ConfigForm } from "../components/ConfigForm";
import { CodeEditor } from "../components/CodeEditor";
import { validateAgainstSchema } from "../lib/schema";
import { diffLines, diffStats } from "../lib/diff";
import { ApiError } from "../api/client";
import type { ConfigValidationError, JsonSchema, RepoConfigResponse } from "../api/types";

type Obj = Record<string, unknown>;

/** Serialize a config object to YAML; an empty object becomes "" (defaults). */
function toYaml(obj: Obj): string {
  if (!obj || Object.keys(obj).length === 0) return "";
  return yaml.dump(obj, { indent: 2, lineWidth: 100, sortKeys: false, noRefs: true });
}

interface ParseState {
  obj: Obj | null;
  error: string | null;
}

function parseYaml(text: string): ParseState {
  if (text.trim() === "") return { obj: {}, error: null };
  try {
    const parsed = yaml.load(text);
    if (parsed === null || parsed === undefined) return { obj: {}, error: null };
    if (typeof parsed !== "object" || Array.isArray(parsed)) {
      return { obj: null, error: "Top-level YAML must be a mapping of options." };
    }
    return { obj: parsed as Obj, error: null };
  } catch (err) {
    return { obj: null, error: err instanceof Error ? err.message : String(err) };
  }
}

function ValidationPanel({ errors }: { errors: ConfigValidationError[] }) {
  if (errors.length === 0) {
    return (
      <div className="cfg-valid ok">
        <span className="dot" /> Valid · matches the schema
      </div>
    );
  }
  return (
    <div className="cfg-valid bad">
      <div className="cfg-valid-head">
        {errors.length} validation {errors.length === 1 ? "error" : "errors"}
      </div>
      <ul>
        {errors.map((e, i) => (
          <li key={i}>
            <span className="mono">{e.path}</span> — {e.message}
          </li>
        ))}
      </ul>
    </div>
  );
}

function DiffPreview({ before, after }: { before: string; after: string }) {
  const rows = useMemo(() => diffLines(before, after), [before, after]);
  const stats = diffStats(rows);
  if (stats.added === 0 && stats.removed === 0) {
    return <EmptyState title="No changes" hint="The edited config is identical to what's committed." />;
  }
  return (
    <>
      <div className="cfg-diff-stats">
        <span className="add">+{stats.added}</span>
        <span className="del">−{stats.removed}</span>
      </div>
      <div className="cfg-diff" role="table">
        {rows.map((r, i) => (
          <div className={`cfg-diff-row ${r.type}`} role="row" key={i}>
            <span className="ln">{r.leftNo ?? ""}</span>
            <span className="txt left">{r.left ?? ""}</span>
            <span className="ln">{r.rightNo ?? ""}</span>
            <span className="txt right">{r.right ?? ""}</span>
          </div>
        ))}
      </div>
    </>
  );
}

function Editor({ data, owner, repo }: { data: RepoConfigResponse; owner: string; repo: string }) {
  const { capabilities } = useAuth();
  const { push } = useToast();
  const update = useUpdateRepoConfig(owner, repo);

  const baseline = data.yaml ?? "";
  const [yamlText, setYamlText] = useState(baseline);
  const [tab, setTab] = useState<"form" | "yaml">("form");
  const [mode, setMode] = useState<"commit" | "pr">("commit");
  const [message, setMessage] = useState("");

  // Re-sync to the committed YAML whenever it changes (initial load + after a
  // successful direct commit invalidates the query and refetches).
  useEffect(() => {
    setYamlText(baseline);
  }, [baseline]);

  const parse = useMemo(() => parseYaml(yamlText), [yamlText]);
  const schema = data.schema as JsonSchema;
  const errors = useMemo(
    () => (parse.obj ? validateAgainstSchema(parse.obj, schema) : []),
    [parse.obj, schema],
  );

  const dirty = yamlText !== baseline;
  const canManage = capabilities.manageConfig;
  // Editing is pointless for a viewer or a repo we can't commit to — keep the
  // form and YAML editor read-only together so the UI doesn't invite edits it
  // will then refuse to commit.
  const editingDisabled = !canManage || !data.editable;
  const blocked = editingDisabled || !!parse.error || errors.length > 0 || !dirty;

  function onFormChange(next: Obj) {
    setYamlText(toYaml(next));
  }

  async function commit() {
    if (blocked || update.isPending) return;
    try {
      const result = await update.mutateAsync({ yaml: yamlText, mode, message: message.trim() || undefined });
      if (result.mode === "pr") {
        // The toast component renders text only (no link), so surface the URL
        // itself rather than implying a clickable title.
        push({
          tone: "success",
          title: `Opened PR #${result.prNumber}`,
          body: result.prUrl ?? undefined,
        });
      } else {
        push({ tone: "success", title: "Config committed", body: `${owner}/${repo} · ${result.branch}` });
        setMessage("");
      }
    } catch (err) {
      let body = "Failed to update config.";
      if (err instanceof ApiError) {
        body = err.message;
        const details = err.details as ConfigValidationError[] | undefined;
        if (Array.isArray(details) && details.length) {
          body = details.map((d) => `${d.path}: ${d.message}`).join("; ");
        }
      }
      push({ tone: "danger", title: "Config rejected", body });
    }
  }

  return (
    <>
      {!data.editable ? (
        <div className="cfg-banner warn">
          Editing is unavailable — no GitHub App installation is on record for this repo (or no app credentials are
          configured). You can still review the effective config below.
        </div>
      ) : !canManage ? (
        <div className="cfg-banner">
          You have read-only access. Editing <span className="mono">.diffsentry.yaml</span> requires the{" "}
          <span className="mono">admin</span> role.
        </div>
      ) : null}

      {data.parseError ? (
        <div className="cfg-banner warn">
          The committed <span className="mono">.diffsentry.yaml</span> currently fails to parse:{" "}
          <span className="mono">{data.parseError}</span>
        </div>
      ) : null}

      <div className="grid two cfg-grid">
        <Card
          title="Edit configuration"
          subtitle={data.defaultBranch ? `Default branch · ${data.defaultBranch}` : "Default branch"}
          right={
            <div className="cfg-tabs">
              <button type="button" className={`btn btn-link ${tab === "form" ? "active" : ""}`} onClick={() => setTab("form")}>
                Form
              </button>
              <button type="button" className={`btn btn-link ${tab === "yaml" ? "active" : ""}`} onClick={() => setTab("yaml")}>
                YAML
              </button>
            </div>
          }
        >
          {tab === "form" ? (
            parse.error ? (
              <EmptyState title="Fix the YAML first" hint="The raw YAML has a syntax error, so the form can't render. Switch to the YAML tab." />
            ) : (
              <div className="cfg-form-scroll">
                <ConfigForm schema={schema} value={parse.obj ?? {}} onChange={onFormChange} disabled={editingDisabled} />
              </div>
            )
          ) : (
            <CodeEditor value={yamlText} onChange={setYamlText} minHeight={420} readOnly={editingDisabled} />
          )}
          {parse.error ? (
            <div className="cfg-valid bad" style={{ marginTop: 12 }}>
              <div className="cfg-valid-head">YAML syntax error</div>
              <div className="mono">{parse.error}</div>
            </div>
          ) : (
            <div style={{ marginTop: 12 }}>
              <ValidationPanel errors={errors} />
            </div>
          )}
        </Card>

        <div className="grid stack">
          <Card title="Commit" subtitle="Review the diff, then apply">
            <div className="cfg-commit">
              <fieldset className="cfg-mode">
                <label>
                  <input
                    type="radio"
                    name="mode"
                    checked={mode === "commit"}
                    disabled={editingDisabled}
                    onChange={() => setMode("commit")}
                  />
                  Commit directly to <span className="mono">{data.defaultBranch ?? "default"}</span>
                </label>
                <label>
                  <input
                    type="radio"
                    name="mode"
                    checked={mode === "pr"}
                    disabled={editingDisabled}
                    onChange={() => setMode("pr")}
                  />
                  Open a pull request
                </label>
              </fieldset>
              <label className="cfg-row">
                <span className="cfg-label">Commit message</span>
                <input
                  className="cfg-input"
                  value={message}
                  placeholder="Update .diffsentry.yaml via DiffSentry command center"
                  onChange={(e) => setMessage(e.target.value)}
                  disabled={editingDisabled}
                />
              </label>
              <div className="cfg-commit-actions">
                <button type="button" className="btn btn-ghost" disabled={!dirty} onClick={() => setYamlText(baseline)}>
                  Reset
                </button>
                <button type="button" className="btn btn-primary" disabled={blocked || update.isPending} onClick={commit}>
                  {update.isPending ? (
                    <span className="spinner btn-spinner" />
                  ) : null}
                  {mode === "pr" ? "Open PR" : "Commit"}
                </button>
              </div>
              {!dirty ? <p className="cfg-hint">No changes to commit yet.</p> : null}
            </div>
          </Card>

          <Card title="Diff preview" subtitle="Committed → edited" bodyClass="flush">
            <div className="cfg-diff-wrap">
              <DiffPreview before={baseline} after={yamlText} />
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}

export function RepoConfigPage() {
  const params = useParams();
  const owner = params.owner ?? "";
  const repo = params.repo ?? "";
  const query = useRepoConfig(owner, repo);

  return (
    <>
      <Breadcrumbs
        crumbs={[
          { label: "Repos", to: "/" },
          { label: `${owner}/${repo}`, to: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}` },
          { label: "Config" },
        ]}
      />
      <PageHeader
        title="Repository configuration"
        subtitle={
          <>
            <span className="mono">{owner}/{repo}</span> · <span className="mono">.diffsentry.yaml</span>
          </>
        }
        right={
          <Link className="btn btn-ghost" to={`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`}>
            ← Back to repo
          </Link>
        }
      />
      <QueryBoundary query={query} loadingLabel="Loading config…">
        {(data) => <Editor data={data} owner={owner} repo={repo} />}
      </QueryBoundary>
    </>
  );
}
