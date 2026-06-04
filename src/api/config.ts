import { randomBytes } from "node:crypto";
import type { Request, Response, Router } from "express";
import yaml from "js-yaml";
import type { Octokit } from "@octokit/rest";
import type { RepoConfig } from "../types.js";
import { mergeWithDefaults } from "../repo-config.js";
import { REPO_CONFIG_SCHEMA, validateRepoConfig } from "../config-schema.js";
import type { Role } from "../dashboard/roles.js";
import { getActor } from "../dashboard/roles.js";
import type { CsrfRuntime } from "../dashboard/auth.js";
import { getInstallationId } from "../dashboard/queries.js";
import { insertAuditLog } from "../storage/dao.js";
import { bus } from "../realtime/bus.js";
import { logger } from "../logger.js";

// ─────────────────────────────────────────────────────────────────────────────
// Repo config endpoints — read + edit .diffsentry.yaml from the command center.
//
//   GET  /repos/:owner/:repo/config   (viewer+) — current YAML on the default
//        branch, the parsed object, the merged-with-defaults effective config,
//        and the JSON schema the SPA form is built from.
//   PUT  /repos/:owner/:repo/config   (admin)   — validate a new YAML, then
//        either commit it directly to the default branch or open a PR. The
//        change is audit-logged with a diff and announced on the bus.
//
// The same 5-minute cache the read endpoints use (and the legacy dashboard's
// equivalent) is invalidated here on a successful direct commit so the new
// config shows up immediately rather than after the TTL.
// ─────────────────────────────────────────────────────────────────────────────

const PATH = ".diffsentry.yaml";
const CONFIG_TTL_MS = 5 * 60 * 1000;
const configCache = new Map<string, { yaml: string | null; ts: number }>();

export interface ConfigRouteDeps {
  getInstallationOctokit?: (installationId: number) => Promise<Octokit>;
  requireRole: (role: Role) => import("express").RequestHandler;
  csrf: CsrfRuntime;
}

type ErrorCode = "forbidden" | "not_found" | "bad_request" | "internal" | "unavailable";

function sendData(res: Response, data: unknown, status = 200): void {
  res.status(status).json({ data });
}
function sendError(res: Response, status: number, code: ErrorCode, message: string, extra?: unknown): void {
  res.status(status).json({ error: { code, message, ...(extra ? { details: extra } : {}) } });
}

/** Cached fetch of the raw .diffsentry.yaml on the default branch (null if absent). */
export async function loadRepoConfigYaml(
  getInstallationOctokit: ((installationId: number) => Promise<Octokit>) | undefined,
  owner: string,
  repo: string,
): Promise<string | null> {
  const key = `${owner}/${repo}`;
  const now = Date.now();
  const cached = configCache.get(key);
  if (cached && now - cached.ts < CONFIG_TTL_MS) return cached.yaml;
  if (!getInstallationOctokit) return null;
  const id = getInstallationId(owner, repo);
  if (id == null) return null;
  try {
    const octokit = await getInstallationOctokit(id);
    const { data } = await octokit.repos.getContent({ owner, repo, path: PATH });
    if (Array.isArray(data) || data.type !== "file" || !data.content) {
      configCache.set(key, { yaml: null, ts: now });
      return null;
    }
    const content = Buffer.from(data.content, "base64").toString("utf-8");
    configCache.set(key, { yaml: content, ts: now });
    return content;
  } catch (err) {
    // Only a genuine 404 (file absent) is a stable result worth caching. Caching
    // a transient failure (rate limit, 5xx, network) as `null` would wrongly pin
    // the repo to "no config / defaults" for the whole TTL — so don't.
    const status = (err as { status?: number }).status;
    if (status === 404) {
      configCache.set(key, { yaml: null, ts: now });
    } else {
      logger.debug({ err, owner, repo }, "api: failed to fetch .diffsentry.yaml");
    }
    return null;
  }
}

/** Drop the cached YAML for a repo so the next read reflects a fresh commit. */
export function invalidateRepoConfigCache(owner: string, repo: string): void {
  configCache.delete(`${owner}/${repo}`);
}

/** Parse YAML into a RepoConfig object. Returns {} for empty/blank input. */
function parseYaml(raw: string): RepoConfig {
  const parsed = yaml.load(raw);
  if (parsed === null || parsed === undefined) return {};
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Top-level YAML must be a mapping of options.");
  }
  return parsed as RepoConfig;
}

/** Minimal line-level unified diff for the audit payload. Capped at 8000 chars. */
function unifiedDiff(before: string, after: string): string {
  if (before === after) return "";
  const a = before.length ? before.split("\n") : [];
  const b = after.length ? after.split("\n") : [];
  const out: string[] = [];
  // Trivial LCS-free diff: emit removals then additions for the changed region.
  // Good enough for a human-readable audit record (not a patch applied anywhere).
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  let ja = a.length - 1;
  let jb = b.length - 1;
  while (ja >= i && jb >= i && a[ja] === b[jb]) {
    ja--;
    jb--;
  }
  for (let k = i; k <= ja; k++) out.push(`- ${a[k]}`);
  for (let k = i; k <= jb; k++) out.push(`+ ${b[k]}`);
  const text = out.join("\n");
  return text.length > 8000 ? `${text.slice(0, 8000)}\n… (truncated)` : text;
}

interface CommitResult {
  mode: "commit" | "pr";
  branch: string;
  commitSha?: string;
  prNumber?: number;
  prUrl?: string;
}

/** Current blob sha of the config file on `ref`, or undefined if it doesn't exist. */
async function currentFileSha(octokit: Octokit, owner: string, repo: string, ref: string): Promise<string | undefined> {
  try {
    const { data } = await octokit.repos.getContent({ owner, repo, path: PATH, ref });
    if (!Array.isArray(data) && "sha" in data) return data.sha;
    return undefined;
  } catch (err) {
    // Only a 404 means the file doesn't exist yet (a legitimate "create").
    // Any other error (rate limit, 5xx, auth) must propagate so the commit
    // fails with the real cause instead of silently committing without a sha
    // (which GitHub would reject for an existing file with a confusing 422).
    if ((err as { status?: number }).status === 404) return undefined;
    throw err;
  }
}

async function commitDirect(
  octokit: Octokit,
  owner: string,
  repo: string,
  branch: string,
  content: string,
  message: string,
): Promise<CommitResult> {
  const sha = await currentFileSha(octokit, owner, repo, branch);
  const { data } = await octokit.repos.createOrUpdateFileContents({
    owner,
    repo,
    path: PATH,
    message,
    content: Buffer.from(content).toString("base64"),
    branch,
    ...(sha ? { sha } : {}),
  });
  return { mode: "commit", branch, commitSha: data.commit.sha ?? undefined };
}

async function commitViaPr(
  octokit: Octokit,
  owner: string,
  repo: string,
  defaultBranch: string,
  branchFactory: () => string,
  content: string,
  message: string,
): Promise<CommitResult> {
  const ref = await octokit.git.getRef({ owner, repo, ref: `heads/${defaultBranch}` });
  // Create a fresh branch, regenerating the name if GitHub reports the ref
  // already exists (422). The random suffix already makes a collision unlikely;
  // the retry makes it a non-issue. Any other error (or a final 422) propagates.
  let branch = branchFactory();
  for (let attempt = 0; ; attempt++) {
    try {
      await octokit.git.createRef({ owner, repo, ref: `refs/heads/${branch}`, sha: ref.data.object.sha });
      break;
    } catch (err) {
      if ((err as { status?: number }).status === 422 && attempt < 4) {
        branch = branchFactory();
        continue;
      }
      throw err;
    }
  }
  // The branch now exists; if any later step fails, best-effort delete it so we
  // don't leave an orphaned branch behind, then rethrow the original error.
  try {
    const sha = await currentFileSha(octokit, owner, repo, branch);
    await octokit.repos.createOrUpdateFileContents({
      owner,
      repo,
      path: PATH,
      message,
      content: Buffer.from(content).toString("base64"),
      branch,
      ...(sha ? { sha } : {}),
    });
    const pr = await octokit.pulls.create({
      owner,
      repo,
      base: defaultBranch,
      head: branch,
      title: message.split("\n")[0] || "Update .diffsentry.yaml",
      body: "Update `.diffsentry.yaml` from the DiffSentry command center.",
    });
    return { mode: "pr", branch, prNumber: pr.data.number, prUrl: pr.data.html_url };
  } catch (err) {
    try {
      await octokit.git.deleteRef({ owner, repo, ref: `heads/${branch}` });
    } catch (cleanupErr) {
      logger.warn({ err: cleanupErr, owner, repo, branch }, "api: failed to clean up config PR branch after error");
    }
    throw err;
  }
}

function branchName(): string {
  // Sanitize the operator-set prefix into a valid git ref segment so a typo
  // (spaces, "..", or ~^:?*[\\) can't make every PR-mode commit fail with a 422.
  const cleaned = (process.env.DASHBOARD_CONFIG_PR_BRANCH_PREFIX || "diffsentry/config")
    .trim()
    .replace(/[^A-Za-z0-9._/-]+/g, "-") // whitelist ref-safe chars
    .replace(/\.\.+/g, ".") // git refs can't contain ".."
    .replace(/^\/+|\/+$/g, ""); // no leading/trailing slash
  const prefix = cleaned.length > 0 ? cleaned : "diffsentry/config";
  // A random suffix (plus the timestamp) avoids ref-creation collisions when two
  // edits land in the same millisecond or a prior branch with the same name
  // still exists — createRef would 422 otherwise.
  return `${prefix}-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
}

/** Register GET + PUT /repos/:owner/:repo/config on the API router. */
export function registerConfigRoutes(router: Router, deps: ConfigRouteDeps): void {
  const { getInstallationOctokit, requireRole, csrf } = deps;

  // ── GET (viewer+) ───────────────────────────────────────────────────
  // The router's global auth gate already 401s unauthenticated callers; the
  // explicit requireRole("viewer") mirrors the PUT route and keeps the access
  // contract on the route itself (robust to future route-order changes).
  router.get("/repos/:owner/:repo/config", requireRole("viewer"), async (req: Request, res: Response) => {
    const { owner, repo } = req.params as { owner: string; repo: string };
    try {
      const rawYaml = await loadRepoConfigYaml(getInstallationOctokit, owner, repo);
      let parsed: RepoConfig = {};
      let parseError: string | null = null;
      if (rawYaml) {
        try {
          parsed = parseYaml(rawYaml);
        } catch (err) {
          parseError = err instanceof Error ? err.message : String(err);
        }
      }

      // Default branch + editability require an installation + octokit.
      let defaultBranch: string | null = null;
      let editable = false;
      const installationId = getInstallationId(owner, repo);
      if (getInstallationOctokit && installationId != null) {
        try {
          const octokit = await getInstallationOctokit(installationId);
          const meta = await octokit.repos.get({ owner, repo });
          defaultBranch = meta.data.default_branch ?? null;
          // Only claim editability once we've confirmed read access AND a branch
          // to commit against; a failed lookup leaves editable false so the SPA
          // doesn't offer a commit UI we can't actually fulfill.
          editable = defaultBranch != null;
        } catch (err) {
          logger.debug({ err, owner, repo }, "api: failed to read repo default branch");
        }
      }

      sendData(res, {
        owner,
        repo,
        defaultBranch,
        yaml: rawYaml,
        exists: rawYaml !== null,
        parsed,
        parseError,
        effective: mergeWithDefaults(parsed),
        schema: REPO_CONFIG_SCHEMA,
        editable,
      });
    } catch (err) {
      logger.error({ err, owner, repo }, "api GET config failed");
      sendError(res, 500, "internal", "Failed to load repo config.");
    }
  });

  // ── PUT (admin) ─────────────────────────────────────────────────────
  router.put("/repos/:owner/:repo/config", requireRole("admin"), csrf.verify, async (req: Request, res: Response) => {
    const { owner, repo } = req.params as { owner: string; repo: string };
    const actor = getActor(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const newYaml = typeof body.yaml === "string" ? body.yaml : null;
    const mode: "commit" | "pr" = body.mode === "pr" ? "pr" : "commit";
    const message =
      typeof body.message === "string" && body.message.trim().length > 0
        ? body.message.trim()
        : "Update .diffsentry.yaml via DiffSentry command center";

    if (newYaml === null) {
      sendError(res, 400, "bad_request", "A 'yaml' string is required.");
      return;
    }

    // 1. Parse — surface YAML syntax errors verbatim.
    let parsed: RepoConfig;
    try {
      parsed = parseYaml(newYaml);
    } catch (err) {
      sendError(res, 400, "bad_request", `Invalid YAML: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    // 2. Validate against the schema — block before touching the repo.
    const errors = validateRepoConfig(parsed);
    if (errors.length > 0) {
      sendError(res, 400, "bad_request", `Config has ${errors.length} validation error(s).`, errors);
      return;
    }

    if (!getInstallationOctokit) {
      sendError(res, 503, "unavailable", "Config editing is unavailable (no GitHub App credentials configured).");
      return;
    }
    const installationId = getInstallationId(owner, repo);
    if (installationId == null) {
      sendError(res, 404, "not_found", `No installation on record for ${owner}/${repo}.`);
      return;
    }

    const auditCommon = {
      actorLogin: actor?.login ?? null,
      actorRole: actor?.role ?? null,
      action: "config.update",
      targetType: "repo",
      targetRef: `${owner}/${repo}`,
    } as const;

    try {
      const octokit = await getInstallationOctokit(installationId);
      const meta = await octokit.repos.get({ owner, repo });
      const defaultBranch = meta.data.default_branch;
      const before = (await loadRepoConfigYaml(getInstallationOctokit, owner, repo)) ?? "";
      const diff = unifiedDiff(before, newYaml);

      let result: CommitResult;
      if (mode === "pr") {
        result = await commitViaPr(octokit, owner, repo, defaultBranch, branchName, newYaml, message);
      } else {
        result = await commitDirect(octokit, owner, repo, defaultBranch, newYaml, message);
        // Only a direct commit changes what the read path serves immediately.
        invalidateRepoConfigCache(owner, repo);
      }

      insertAuditLog({
        ...auditCommon,
        payload: { mode: result.mode, branch: result.branch, diff, prNumber: result.prNumber, commitSha: result.commitSha },
        result: "ok",
      });
      bus.publish("config.updated", {
        owner,
        repo,
        mode: result.mode,
        actor: actor?.login ?? null,
        role: actor?.role ?? null,
        branch: result.branch,
        commitSha: result.commitSha,
        prNumber: result.prNumber,
        prUrl: result.prUrl,
      });

      sendData(res, { owner, repo, ...result });
    } catch (err) {
      const messageStr = err instanceof Error ? err.message : String(err);
      logger.error({ err, owner, repo, mode }, "api PUT config failed");
      insertAuditLog({ ...auditCommon, payload: { mode, error: messageStr }, result: "error" });
      sendError(res, 500, "internal", `Failed to ${mode === "pr" ? "open config PR" : "commit config"}.`);
    }
  });
}
