import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useRepoSettings, useSettings, useUpdateRepoSettings, useUpdateSettings } from "../api/hooks";
import { ApiError } from "../api/client";
import { useToast } from "../realtime/toast";
import { useEventStream } from "../realtime/useEventStream";
import { Card, Switch } from "./primitives";
import { QueryBoundary } from "./states";
import type {
  GlobalSettings,
  GlobalSettingsPatch,
  LogLevel,
  Profile,
  RepoSettings,
  RepoSettingsPatch,
} from "../api/types";

const LOG_LEVELS: LogLevel[] = ["trace", "debug", "info", "warn", "error", "fatal"];
const PROFILES: Profile[] = ["chill", "assertive"];

function errMessage(e: unknown): string {
  return e instanceof ApiError ? e.message : "Something went wrong.";
}

/** A labelled control row: title + description on the left, control on the right. */
function Row(props: { title: ReactNode; desc?: ReactNode; children: ReactNode }) {
  return (
    <div className="setting-row">
      <div className="setting-meta">
        <div className="setting-title">{props.title}</div>
        {props.desc ? <div className="setting-desc">{props.desc}</div> : null}
      </div>
      <div className="setting-control">{props.children}</div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Global operator controls — admin only. A prominent Pause-All switch plus the
// grouped review defaults (auto-review, profile, log level, max files).
// ─────────────────────────────────────────────────────────────────────────────

export function GlobalSettingsControls() {
  const query = useSettings(true);
  const qc = useQueryClient();

  // Keep the panel live if another admin (or the kill switch) changes settings.
  useEventStream(
    useCallback(
      (env) => {
        if (env.topic === "settings.changed") void qc.invalidateQueries({ queryKey: ["settings"] });
      },
      [qc],
    ),
  );

  return (
    <QueryBoundary query={query} loadingLabel="Loading settings…">
      {(data) => <GlobalSettingsForm settings={data.settings} />}
    </QueryBoundary>
  );
}

function GlobalSettingsForm({ settings }: { settings: GlobalSettings }) {
  const update = useUpdateSettings();
  const { push } = useToast();

  const save = (patch: GlobalSettingsPatch, label: string) =>
    update.mutate(patch, {
      onSuccess: () => push({ tone: "success", title: "Settings updated", body: label }),
      onError: (e) => push({ tone: "danger", title: "Update failed", body: errMessage(e) }),
    });

  const togglePause = () => {
    const next = !settings.pauseAll;
    if (next && !window.confirm("Pause ALL reviews? New PRs and pushes will not be reviewed until you resume.")) {
      return;
    }
    save({ pauseAll: next }, next ? "All reviews paused" : "Reviews resumed");
  };

  return (
    <>
      <section className={`pause-banner${settings.pauseAll ? " paused" : ""}`} aria-live="polite">
        <div className="pause-info">
          <div className="pause-dot" aria-hidden="true" />
          <div>
            <div className="pause-status">{settings.pauseAll ? "Reviews are PAUSED globally" : "Reviews are active"}</div>
            <p className="muted" style={{ margin: "3px 0 0", fontSize: 12 }}>
              {settings.pauseAll
                ? "The webhook is not queuing any new reviews. Auto-resolve on push still runs."
                : "New PRs, pushes, and ready-for-review events queue reviews normally."}
            </p>
          </div>
        </div>
        <button
          type="button"
          className={`btn ${settings.pauseAll ? "btn-primary" : "btn-danger"}`}
          onClick={togglePause}
          disabled={update.isPending}
          aria-busy={update.isPending}
        >
          {settings.pauseAll ? "Resume all reviews" : "Pause all reviews"}
        </button>
      </section>

      <div style={{ marginTop: 16 }}>
        <Card title="Review defaults" subtitle="Apply to every repo unless a per-repo override is set.">
          <div className="setting-list">
            <Row
              title="Auto-review on new PRs"
              desc="When off, the webhook won't queue reviews for any repo (per-repo overrides still apply)."
            >
              <Switch
                aria-label="Auto-review default"
                checked={settings.autoReview}
                disabled={update.isPending}
                onChange={(next) => save({ autoReview: next }, `Auto-review ${next ? "enabled" : "disabled"} by default`)}
              />
            </Row>

            <Row title="Default profile" desc="“chill” keeps comments light; “assertive” is stricter.">
              <select
                value={settings.defaultProfile}
                disabled={update.isPending}
                onChange={(e) => save({ defaultProfile: e.target.value as Profile }, `Default profile → ${e.target.value}`)}
                style={{ width: 160 }}
              >
                {PROFILES.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </Row>

            <Row title="Log level" desc="Applied to the running process immediately and on restart.">
              <select
                value={settings.logLevel}
                disabled={update.isPending}
                onChange={(e) => save({ logLevel: e.target.value as LogLevel }, `Log level → ${e.target.value}`)}
                style={{ width: 160 }}
              >
                {LOG_LEVELS.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
            </Row>

            <Row title="Max files per review" desc="Cap on changed files sent to the model. Blank = env default.">
              <MaxFilesControl
                value={settings.maxFiles}
                pending={update.isPending}
                onSave={(v) => save({ maxFiles: v }, v == null ? "Max files → env default" : `Max files → ${v}`)}
              />
            </Row>
          </div>
        </Card>
      </div>
    </>
  );
}

/** Number input with Save + Reset (null clears to the env default). */
function MaxFilesControl(props: { value: number | null; pending: boolean; onSave: (v: number | null) => void }) {
  const [raw, setRaw] = useState(props.value == null ? "" : String(props.value));
  useEffect(() => {
    setRaw(props.value == null ? "" : String(props.value));
  }, [props.value]);

  const parsed = raw.trim() === "" ? null : Number.parseInt(raw, 10);
  const invalid = raw.trim() !== "" && (!Number.isFinite(parsed as number) || (parsed as number) < 1 || (parsed as number) > 500);
  const dirty = (props.value == null ? "" : String(props.value)) !== raw.trim();

  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
      <input
        type="text"
        inputMode="numeric"
        value={raw}
        placeholder="default"
        onChange={(e) => setRaw(e.target.value)}
        disabled={props.pending}
        aria-label="Max files per review"
        aria-invalid={invalid}
        style={{ width: 90 }}
      />
      <button
        type="button"
        className="btn btn-ghost"
        disabled={props.pending || invalid || !dirty}
        onClick={() => props.onSave(parsed)}
      >
        Save
      </button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-repo overrides — admin only. Each field can inherit the global default or
// pin a repo-specific value. Rendered on the repo detail page.
// ─────────────────────────────────────────────────────────────────────────────

export function RepoSettingsCard({ owner, repo }: { owner: string; repo: string }) {
  const query = useRepoSettings(owner, repo, true);
  return (
    <Card title="Operator overrides" subtitle="Per-repo settings that win over the global defaults. Admin only.">
      <QueryBoundary query={query} loadingLabel="Loading overrides…">
        {(data) => <RepoSettingsForm owner={owner} repo={repo} settings={data.settings} />}
      </QueryBoundary>
    </Card>
  );
}

/** A tri-state value: "inherit" (null), "on" (true), or "off" (false). */
function triState(v: boolean | null): "inherit" | "on" | "off" {
  return v == null ? "inherit" : v ? "on" : "off";
}

function RepoSettingsForm({ owner, repo, settings }: { owner: string; repo: string; settings: RepoSettings }) {
  const update = useUpdateRepoSettings(owner, repo);
  const { push } = useToast();

  const save = (patch: RepoSettingsPatch, label: string) =>
    update.mutate(patch, {
      onSuccess: () => push({ tone: "success", title: `${owner}/${repo} updated`, body: label }),
      onError: (e) => push({ tone: "danger", title: "Update failed", body: errMessage(e) }),
    });

  return (
    <div className="setting-list">
      <Row title="Auto-review" desc="Override the global auto-review default for this repo.">
        <select
          value={triState(settings.autoReview)}
          disabled={update.isPending}
          onChange={(e) => {
            const v = e.target.value;
            const next = v === "inherit" ? null : v === "on";
            save({ autoReview: next }, v === "inherit" ? "Auto-review → inherit" : `Auto-review → ${v}`);
          }}
          style={{ width: 160 }}
        >
          <option value="inherit">inherit global</option>
          <option value="on">on</option>
          <option value="off">off</option>
        </select>
      </Row>

      <Row title="Profile" desc="Pin a review profile for this repo.">
        <select
          value={settings.profile ?? "inherit"}
          disabled={update.isPending}
          onChange={(e) => {
            const v = e.target.value;
            const next = v === "inherit" ? null : (v as Profile);
            save({ profile: next }, v === "inherit" ? "Profile → inherit" : `Profile → ${v}`);
          }}
          style={{ width: 160 }}
        >
          <option value="inherit">inherit default</option>
          {PROFILES.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </Row>

      <Row title="Max files per review" desc="Blank inherits the global / env value.">
        <MaxFilesControl
          value={settings.maxFiles}
          pending={update.isPending}
          onSave={(v) => save({ maxFiles: v }, v == null ? "Max files → inherit" : `Max files → ${v}`)}
        />
      </Row>
    </div>
  );
}
