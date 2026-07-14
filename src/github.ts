import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { Config, FileChange, PRContext, ReviewComment, ReviewResult, IssueContext, IssueComment } from "./types.js";
import { logger } from "./logger.js";
import { isFileLevelFinding, REVIEW_BODY_MARKER } from "./review-body.js";

type Logger = typeof logger;

/** Body a superseded COMMENTED review is rewritten to. Keeps the timeline entry
 *  honest (the review did happen) without leaving its full text competing with
 *  the current one. Carries no REVIEW_BODY_MARKER, so a later run doesn't
 *  re-retire what's already retired. */
const SUPERSEDED_REVIEW_STUB =
  "<sub>🛡️ This DiffSentry review has been superseded by a newer one. Its findings, if still present, appear there.</sub>";

/** Findings GitHub refused as file-scoped threads, rendered into the review body
 *  so their substance still reaches the reviewer. Rare — the file usually left
 *  the diff mid-review. */
function renderFileLevelFallbackSection(comments: ReviewComment[]): string {
  const blocks = comments
    .map((c) => `**\`${c.path}\`**\n\n${c.body.trim()}`)
    .join("\n\n---\n\n");
  return [
    `### 🔎 Findings that couldn't be attached to their file (${comments.length})`,
    "",
    "<sub>DiffSentry couldn't open a review thread on these files — they may no longer be part of the diff.</sub>",
    "",
    blocks,
  ].join("\n");
}

// ─── Rate-limit / transient-error backoff ──────────────────────────
// Every Octokit instance this module hands out (installation- and App-level)
// is wrapped with the retry behaviour below via an `octokit.hook.wrap`, so
// both the review path and the dashboard/diagnostics path benefit without any
// per-call-site changes. REST and GraphQL both flow through the same
// `request` hook in @octokit/core, so a single wrap covers them.
//
// Policy:
//   - Primary rate limit (403/429 with x-ratelimit-remaining: 0): wait until
//     x-ratelimit-reset, capped.
//   - Secondary / abuse rate limit (retry-after header): honour retry-after,
//     capped.
//   - Transient 5xx: exponential backoff with jitter.
//   - At most MAX_RETRIES attempts; each wait capped at MAX_RETRY_WAIT_MS.
//   - A live AbortSignal short-circuits both the wait and any further retry,
//     so a cancelled review stops hammering GitHub immediately.

const MAX_RETRIES = 3;
const MAX_RETRY_WAIT_MS = 60_000;
const BASE_BACKOFF_MS = 1_000;

/** Thrown when an AbortSignal fires while we're waiting to retry. */
class AbortError extends Error {
  constructor(message = "Operation aborted") {
    super(message);
    this.name = "AbortError";
  }
}

/** Minimal view of an Octokit RequestError — only the fields we read. */
interface RetryableError {
  status?: number;
  response?: { headers?: Record<string, string | undefined> };
}

function errHeaders(err: RetryableError): Record<string, string | undefined> {
  return err?.response?.headers ?? {};
}

/** A 403/429 that GitHub flagged as a rate-limit (vs a plain permission 403). */
function isRateLimited(err: RetryableError): boolean {
  const status = err?.status;
  if (status === 429) return true;
  if (status === 403) {
    const h = errHeaders(err);
    return h["retry-after"] != null || h["x-ratelimit-remaining"] === "0";
  }
  return false;
}

/** Transient server-side failures worth a retry. */
function isTransientServerError(err: RetryableError): boolean {
  const status = err?.status;
  return typeof status === "number" && status >= 500 && status <= 599;
}

const clampWait = (ms: number): number => Math.max(0, Math.min(ms, MAX_RETRY_WAIT_MS));

/** How long to wait before retrying a rate-limited request. */
function rateLimitWaitMs(err: RetryableError): number {
  const h = errHeaders(err);
  // Secondary/abuse limit: GitHub tells us exactly how long to wait.
  const retryAfter = h["retry-after"];
  if (retryAfter != null) {
    const secs = Number(retryAfter);
    // Only honour a positive, finite value. A malformed ("abc" → NaN),
    // zero, or negative header (from GitHub or an intermediary) must NOT
    // produce a zero-delay hot retry — fall through to the reset/default path.
    if (Number.isFinite(secs) && secs > 0) return clampWait(secs * 1000);
  }
  // Primary limit: wait until the window resets (epoch seconds).
  const reset = h["x-ratelimit-reset"];
  if (reset != null) {
    const resetSecs = Number(reset);
    if (Number.isFinite(resetSecs)) {
      return clampWait(Math.max(resetSecs * 1000 - Date.now(), BASE_BACKOFF_MS));
    }
  }
  // No usable header — fall back to a conservative fixed wait.
  return clampWait(BASE_BACKOFF_MS);
}

/** Exponential backoff with jitter for transient 5xx. */
function backoffWaitMs(attempt: number): number {
  const base = BASE_BACKOFF_MS * 2 ** attempt;
  const jitter = base * 0.2 * Math.random();
  return clampWait(base + jitter);
}

/** Promise that resolves after `ms`, or rejects with AbortError if `signal` fires. */
function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AbortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AbortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Run a single Octokit request with rate-limit-aware retries. `request` and
 * `options` are the values passed by `octokit.hook.wrap("request", ...)`.
 * Exported for unit testing.
 */
export async function requestWithRetry(
  request: (options: any) => Promise<any>,
  options: any,
  signal?: AbortSignal,
  log = logger
): Promise<any> {
  // Forward the abort signal to the underlying Octokit/fetch request so an
  // in-flight call is cancelled too — not just the backoff wait between
  // retries. Preserve any caller-supplied `options.request`.
  const requestOptions = signal
    ? { ...options, request: { ...(options?.request ?? {}), signal } }
    : options;
  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) throw new AbortError();
    try {
      return await request(requestOptions);
    } catch (err) {
      // A cancelled review must not keep retrying — surface immediately.
      if (signal?.aborted) throw err;

      const rateLimited = isRateLimited(err as RetryableError);
      const transient = isTransientServerError(err as RetryableError);
      if ((!rateLimited && !transient) || attempt >= MAX_RETRIES) throw err;

      const waitMs = rateLimited
        ? rateLimitWaitMs(err as RetryableError)
        : backoffWaitMs(attempt);

      log.warn(
        {
          attempt: attempt + 1,
          maxRetries: MAX_RETRIES,
          waitMs,
          status: (err as RetryableError)?.status,
          reason: rateLimited ? "rate-limit" : "transient-5xx",
          method: options?.method,
          url: options?.url,
        },
        "GitHub API backoff: retrying after rate-limit/transient error"
      );

      try {
        await abortableDelay(waitMs, signal);
      } catch {
        // Aborted while waiting — stop retrying, surface the original error so
        // the caller's `signal.aborted` check treats it as a clean cancel.
        throw err;
      }
    }
  }
}

/**
 * Register the retry hook on an Octokit instance. `signal`, when supplied,
 * makes every request on this instance abort-aware (used by the review path
 * so a cancelled review stops retrying).
 */
function installRetryHook(octokit: Octokit, signal?: AbortSignal): Octokit {
  octokit.hook.wrap("request", (request, options) =>
    requestWithRetry(request as (o: any) => Promise<any>, options, signal)
  );
  return octokit;
}

// ─── GitHub App diagnostics (first-run experience) ─────────────────
// Shapes returned by getAppDiagnostics(), consumed by the API diagnostics
// route and the SPA's setup wizard / Diagnostics screen. Every field is
// best-effort: a sub-call that fails leaves its slice empty rather than
// throwing, so a partial picture is still useful when (say) the App can list
// installations but lacks webhook-read permission.

export interface InstallationInfo {
  id: number;
  /** Owner login the App is installed on (org or user). */
  account: string | null;
  accountType: string | null;
  /** "all" or "selected" — whether the App can see every repo or a subset. */
  repositorySelection: string | null;
  /** Up to the first 50 connected repos as "owner/name". */
  repos: string[];
  /** Total repos the App can access (may exceed repos.length). */
  repoCount: number;
  /** True when repoCount > repos.length (the list was capped). */
  truncated: boolean;
}

export interface WebhookDelivery {
  id: number;
  event: string;
  action: string | null;
  /** GitHub's textual status, e.g. "OK" or "failed to connect". */
  status: string;
  /** HTTP status code our endpoint returned (0 when GitHub couldn't reach us). */
  statusCode: number;
  deliveredAt: string;
  redelivery: boolean;
}

export interface GithubDiagnostics {
  app: { slug: string | null; name: string | null; htmlUrl: string | null } | null;
  installations: InstallationInfo[];
  webhook: { configuredUrl: string | null; deliveries: WebhookDelivery[]; error?: string };
  rateLimit: { limit: number; remaining: number; reset: string } | null;
  /** Set when the App JWT itself couldn't authenticate (bad app id / key). */
  error?: string;
}

// Narrow shapes for the raw @octokit/rest responses getAppDiagnostics() reads.
// We assert to these (only the fields we use) instead of `any`: the App-level
// list endpoints + paginate() don't infer cleanly down to this handful of
// fields, but the runtime payloads carry them. @octokit/rest ^21.
interface RawInstallation {
  id: number;
  account?: { login?: string; slug?: string; type?: string } | null;
  repository_selection?: string | null;
}
interface RawWebhookDelivery {
  id: number;
  event: string;
  action?: string | null;
  status: string;
  status_code: number;
  delivered_at: string;
  redelivery?: boolean;
}
interface RawRateBucket {
  limit: number;
  remaining: number;
  reset: number;
}

function isOurBotThread(thread: any, botLogin: string): boolean {
  const first = thread.comments?.nodes?.[0];
  if (!first) return false;
  const author = first.author;
  if (!author) return false;
  if (author.__typename !== "Bot") return false;
  const login = (author.login ?? "").toLowerCase();
  // Exact match against our app login first; fall back to suffix so older
  // deployments under a different bot name can still self-resolve their threads.
  return login === botLogin || login.endsWith("[bot]");
}

export class GitHubClient {
  private config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  async getInstallationOctokit(installationId: number, signal?: AbortSignal): Promise<Octokit> {
    const octokit = new Octokit({
      authStrategy: createAppAuth,
      auth: {
        appId: this.config.githubAppId,
        privateKey: this.config.githubPrivateKey,
        installationId,
      },
    });
    return installRetryHook(octokit, signal);
  }

  /**
   * App-level Octokit (authenticated as the App via JWT, not as an
   * installation). Used by the diagnostics surface to enumerate installations,
   * inspect the webhook config, and read recent deliveries — none of which a
   * single installation token can see.
   */
  getAppOctokit(signal?: AbortSignal): Octokit {
    const octokit = new Octokit({
      authStrategy: createAppAuth,
      auth: {
        appId: this.config.githubAppId,
        privateKey: this.config.githubPrivateKey,
      },
    });
    return installRetryHook(octokit, signal);
  }

  /**
   * Gather the live GitHub-side picture for the first-run experience: which
   * installations exist and what repos they reach, the configured webhook URL
   * + recent delivery outcomes, and current rate-limit headroom. Every section
   * degrades to empty/null on permission or network errors so the dashboard
   * can render a partial-but-useful diagnostic rather than failing outright.
   */
  async getAppDiagnostics(): Promise<GithubDiagnostics> {
    // Constructing the client never performs I/O — App JWT authentication is
    // lazy and first exercised by getAuthenticated() below, where a bad App
    // ID / private key surfaces as the top-level `error`.
    const app = this.getAppOctokit();

    const result: GithubDiagnostics = {
      app: null,
      installations: [],
      webhook: { configuredUrl: null, deliveries: [] },
      rateLimit: null,
    };

    // App identity — also the canonical "is the App ID + private key valid?"
    // check: a bad key fails here with a 401 we surface to the wizard.
    try {
      const { data } = await app.apps.getAuthenticated();
      result.app = data
        ? { slug: data.slug ?? null, name: data.name ?? null, htmlUrl: data.html_url ?? null }
        : null;
    } catch (err) {
      // App JWT couldn't authenticate (bad App ID / private key). Return now —
      // the remaining calls would fail with the same credentials and bury this
      // root cause behind secondary 401s. A set top-level `error` is the
      // documented signal that App authentication itself failed.
      result.error = err instanceof Error ? err.message : String(err);
      return result;
    }

    // Installations + the repos each can reach.
    try {
      const insts = (await app.paginate(app.apps.listInstallations, { per_page: 100 })) as RawInstallation[];
      for (const inst of insts) {
        const info: InstallationInfo = {
          id: inst.id,
          account: inst.account?.login ?? inst.account?.slug ?? null,
          accountType: inst.account?.type ?? null,
          repositorySelection: inst.repository_selection ?? null,
          repos: [],
          repoCount: 0,
          truncated: false,
        };
        try {
          const instOcto = await this.getInstallationOctokit(inst.id);
          // One page is enough for the 50-name preview: per_page=100 ≥ the cap,
          // and `total_count` is the authoritative full count (not page-limited),
          // so repoCount + truncated stay accurate without paginating.
          const { data } = await instOcto.apps.listReposAccessibleToInstallation({ per_page: 100 });
          const repos = data.repositories ?? [];
          info.repoCount = data.total_count ?? repos.length;
          info.repos = repos.slice(0, 50).map((r) => r.full_name);
          info.truncated = info.repoCount > info.repos.length;
        } catch (err) {
          logger.debug({ err, installationId: inst.id }, "diagnostics: list repos failed");
        }
        result.installations.push(info);
      }
    } catch (err) {
      logger.debug({ err }, "diagnostics: list installations failed");
    }

    // Webhook config + last few deliveries (App-level, JWT-only endpoints).
    try {
      const { data } = await app.apps.getWebhookConfigForApp();
      result.webhook.configuredUrl = (data as { url?: string }).url ?? null;
    } catch (err) {
      result.webhook.error = err instanceof Error ? err.message : String(err);
    }
    try {
      const { data } = await app.apps.listWebhookDeliveries({ per_page: 10 });
      result.webhook.deliveries = (data as RawWebhookDelivery[]).map((d) => ({
        id: d.id,
        event: d.event,
        action: d.action ?? null,
        status: d.status,
        statusCode: d.status_code,
        deliveredAt: d.delivered_at,
        redelivery: !!d.redelivery,
      }));
    } catch (err) {
      result.webhook.error = result.webhook.error ?? (err instanceof Error ? err.message : String(err));
    }

    // Rate limit (App JWT core bucket).
    try {
      const { data } = await app.rateLimit.get();
      const limits = data as { resources?: { core?: RawRateBucket }; rate?: RawRateBucket };
      const core = limits.resources?.core ?? limits.rate;
      if (core) {
        result.rateLimit = {
          limit: core.limit,
          remaining: core.remaining,
          reset: new Date(core.reset * 1000).toISOString(),
        };
      }
    } catch (err) {
      logger.debug({ err }, "diagnostics: rate limit failed");
    }

    return result;
  }

  async getPRContext(
    installationId: number,
    owner: string,
    repo: string,
    pullNumber: number,
    /** Per-review max-files override (operator setting); falls back to config. */
    maxFiles?: number,
    /** Aborts in-flight retries when the review is cancelled. */
    signal?: AbortSignal
  ): Promise<PRContext> {
    const octokit = await this.getInstallationOctokit(installationId, signal);

    const [pr, filesResponse] = await Promise.all([
      octokit.pulls.get({ owner, repo, pull_number: pullNumber }),
      octokit.pulls.listFiles({ owner, repo, pull_number: pullNumber, per_page: 100 }),
    ]);

    const fileCap = maxFiles != null && maxFiles > 0 ? maxFiles : this.config.maxFilesPerReview;
    const ignoredFiles: string[] = [];
    const afterIgnore = filesResponse.data.filter((f) => {
      if (this.isIgnored(f.filename)) {
        ignoredFiles.push(f.filename);
        return false;
      }
      return true;
    });
    // Files beyond the max-files cap are dropped from review. Record them (like
    // ignoredFiles) so the reviewer can surface "N files beyond the review cap"
    // instead of silently returning a green status when the cap is the only
    // reason nothing was reviewed.
    const cappedFiles: string[] = afterIgnore.slice(fileCap).map((f) => f.filename);
    const files: FileChange[] = afterIgnore
      .slice(0, fileCap)
      .map((f) => ({
        filename: f.filename,
        status: f.status as FileChange["status"],
        patch: f.patch || "",
        additions: f.additions,
        deletions: f.deletions,
      }));

    return {
      owner,
      repo,
      pullNumber,
      title: pr.data.title,
      description: pr.data.body || "",
      baseBranch: pr.data.base.ref,
      baseSha: pr.data.base.sha,
      headBranch: pr.data.head.ref,
      headSha: pr.data.head.sha,
      defaultBranch: pr.data.base.repo.default_branch,
      files,
      ignoredFiles,
      cappedFiles,
      isDraft: pr.data.draft,
      labels: pr.data.labels.map((l) => l.name ?? ""),
      author: pr.data.user?.login,
    };
  }

  /**
   * Build the IssueContext used by `chatIssue`. Fetches the issue itself,
   * up to the most recent 30 issue comments, the repo's default branch, and
   * the top-level entries of that branch (for "where to look" hints in the
   * plan + summary commands).
   *
   * Best-effort everywhere: if any sub-call fails, we degrade gracefully so
   * a transient API blip doesn't drop the whole response.
   */
  async getIssueContext(
    installationId: number,
    owner: string,
    repo: string,
    issueNumber: number
  ): Promise<IssueContext> {
    const octokit = await this.getInstallationOctokit(installationId);

    const issueP = octokit.issues.get({ owner, repo, issue_number: issueNumber });
    const repoMetaP = octokit.repos.get({ owner, repo }).catch(() => null);
    const commentsP = octokit.paginate(octokit.issues.listComments, {
      owner,
      repo,
      issue_number: issueNumber,
      per_page: 100,
    }).catch(() => [] as any[]);

    const [issueRes, repoMeta, rawComments] = await Promise.all([
      issueP,
      repoMetaP,
      commentsP,
    ]);

    const issue = issueRes.data;
    const defaultBranch = repoMeta?.data.default_branch || "main";

    // File tree — top-level only, capped to 60 entries to keep prompts tight.
    let repoFileTree: string[] = [];
    try {
      const tree = await octokit.git.getTree({
        owner,
        repo,
        tree_sha: defaultBranch,
        recursive: "false",
      });
      repoFileTree = tree.data.tree
        .map((entry) => (entry.type === "tree" ? `${entry.path}/` : entry.path || ""))
        .filter((p) => p.length > 0)
        .slice(0, 60);
    } catch (err) {
      logger.debug({ err, owner, repo }, "Failed to fetch default-branch tree");
    }

    const comments: IssueComment[] = (rawComments as any[])
      .slice(-30) // most recent 30 — older context decays in usefulness
      .map((c) => ({
        author: c.user?.login,
        authorAssociation: c.author_association,
        body: c.body || "",
        createdAt: c.created_at,
        isBot: c.user?.type === "Bot",
      }));

    return {
      owner,
      repo,
      issueNumber,
      title: issue.title,
      body: issue.body || "",
      state: issue.state,
      labels: issue.labels.map((l) => (typeof l === "string" ? l : l.name ?? "")).filter(Boolean),
      author: issue.user?.login,
      authorAssociation: issue.author_association,
      url: issue.html_url,
      comments,
      repoFileTree,
      defaultBranch,
    };
  }

  /**
   * Clear DiffSentry's own superseded reviews off the PR before adding another.
   *
   * Two states, two mechanisms, because GitHub only lets you dismiss a review
   * that carries a verdict:
   *   - CHANGES_REQUESTED → dismissReview, which strikes it through and drops
   *     the block.
   *   - COMMENTED → NOT dismissable (the API rejects it), and submitted reviews
   *     can't be deleted. The body is editable though, so rewrite it to a
   *     one-line stub. Without this, every commented review — the state a
   *     drift-only review lands in — keeps its full text on the timeline
   *     forever, and each push adds another.
   *
   * Matching is on our own body marker, not `user.type === "Bot"`, which would
   * have us dismissing other bots' reviews.
   */
  private async retireSupersededReviews(
    octokit: Octokit,
    context: PRContext,
    log: Logger,
  ): Promise<void> {
    try {
      const reviews = await octokit.paginate(octokit.pulls.listReviews, {
        owner: context.owner,
        repo: context.repo,
        pull_number: context.pullNumber,
      });
      const ours = reviews.filter((r) => r.body?.includes(REVIEW_BODY_MARKER));

      for (const review of ours) {
        try {
          if (review.state === "CHANGES_REQUESTED") {
            await octokit.pulls.dismissReview({
              owner: context.owner,
              repo: context.repo,
              pull_number: context.pullNumber,
              review_id: review.id,
              message: "Superseded by a newer DiffSentry review.",
            });
          } else if (review.state === "COMMENTED") {
            await octokit.pulls.updateReview({
              owner: context.owner,
              repo: context.repo,
              pull_number: context.pullNumber,
              review_id: review.id,
              body: SUPERSEDED_REVIEW_STUB,
            });
          }
        } catch (err) {
          // One un-retirable review must not block the new one from posting.
          log.debug({ err, reviewId: review.id, state: review.state }, "Could not retire superseded review");
        }
      }
    } catch {
      log.warn("Could not list previous reviews to retire (may lack permission)");
    }
  }

  /**
   * Post file-scoped findings as their own resolvable review threads.
   * Returns the findings GitHub refused, for the caller to fold back into the
   * review body — most often because the file left the diff since the review
   * started.
   */
  private async postFileLevelComments(
    octokit: Octokit,
    context: PRContext,
    comments: ReviewComment[],
    log: Logger,
  ): Promise<ReviewComment[]> {
    const unpostable: ReviewComment[] = [];
    for (const c of comments) {
      try {
        await octokit.pulls.createReviewComment({
          owner: context.owner,
          repo: context.repo,
          pull_number: context.pullNumber,
          commit_id: context.headSha,
          path: c.path,
          body: c.body,
          subject_type: "file",
        });
      } catch (err) {
        log.warn({ err, path: c.path }, "File-level comment rejected; folding into review body");
        unpostable.push(c);
      }
    }
    return unpostable;
  }

  async submitReview(
    installationId: number,
    context: PRContext,
    result: ReviewResult,
    signal?: AbortSignal
  ): Promise<void> {
    const octokit = await this.getInstallationOctokit(installationId, signal);
    const log = logger.child({ owner: context.owner, repo: context.repo, pr: context.pullNumber });

    await this.retireSupersededReviews(octokit, context, log);

    // Submit the new review
    const validComments = result.comments.filter((c) => c.line > 0 && c.path);

    // File-scoped findings: the model named a file but no line we could anchor
    // to the diff. GitHub hosts these as real review threads via
    // `subject_type: "file"` — resolvable, repliable, and collapsible like any
    // inline comment — so post them as threads instead of as permanent prose in
    // the review body. They go FIRST: any that GitHub rejects are folded back
    // into the body below, so a finding is never silently lost between the two
    // channels (the failure #76 set out to fix).
    const fileLevelComments = result.comments.filter(isFileLevelFinding);
    const unpostable = await this.postFileLevelComments(octokit, context, fileLevelComments, log);

    let body = result.summary;
    if (unpostable.length > 0) {
      body += "\n\n" + renderFileLevelFallbackSection(unpostable);
    }

    // GitHub rejects reviews with empty body and no comments (422)
    if (!body && validComments.length === 0) {
      log.warn("Skipping review submission: no summary and no comments");
      return;
    }

    try {
      await octokit.pulls.createReview({
        owner: context.owner,
        repo: context.repo,
        pull_number: context.pullNumber,
        commit_id: context.headSha,
        event: result.approval,
        body,
        comments: validComments.map((c) => ({
          path: c.path,
          line: c.line,
          side: c.side,
          body: c.body,
        })),
      });
      log.info(
        { comments: validComments.length, fileLevel: fileLevelComments.length - unpostable.length, event: result.approval },
        "Review submitted"
      );
    } catch (err: any) {
      // If inline comments fail (line not in diff), fall back to a plain comment
      if (err.status === 422 && validComments.length > 0) {
        log.warn("Inline comments failed, falling back to summary-only review");
        const commentBlock = validComments
          .map((c) => `**${c.path}:${c.line}**\n${c.body}`)
          .join("\n\n---\n\n");

        await octokit.pulls.createReview({
          owner: context.owner,
          repo: context.repo,
          pull_number: context.pullNumber,
          commit_id: context.headSha,
          event: result.approval,
          body: `${body}\n\n---\n\n## Inline Comments\n\n${commentBlock}`,
        });
      } else {
        throw err;
      }
    }
  }

  async postComment(
    installationId: number,
    owner: string,
    repo: string,
    pullNumber: number,
    body: string,
    signal?: AbortSignal
  ): Promise<void> {
    const octokit = await this.getInstallationOctokit(installationId, signal);
    await octokit.issues.createComment({
      owner,
      repo,
      issue_number: pullNumber,
      body,
    });
  }

  async listPRCommits(
    installationId: number,
    owner: string,
    repo: string,
    pullNumber: number,
    signal?: AbortSignal,
  ): Promise<Array<{ sha: string; message: string; author?: string }>> {
    const octokit = await this.getInstallationOctokit(installationId, signal);
    const commits = await octokit.paginate(octokit.pulls.listCommits, {
      owner,
      repo,
      pull_number: pullNumber,
      per_page: 100,
    });
    return commits.map((c: any) => ({
      sha: c.sha,
      message: c.commit?.message ?? "",
      author: c.commit?.author?.name,
    }));
  }

  /**
   * For each requested file path, return the latest commit timestamp (author
   * date, falling back to committer date) among the PR's commits that modified
   * that path.
   *
   * Replaces the per-commit `getCommit` N+1 loop that previously powered the
   * "Changes since last reviewed" insight. GitHub exposes a commit's changed
   * files only via `repos.getCommit` (the GraphQL `Commit` type has no file
   * list, and the compare endpoint only returns an aggregate diff), so we still
   * read per-commit file lists — but we process commits newest-timestamp first
   * and stop as soon as every requested path is resolved. A typical PR (whose
   * latest commit touches most changed files) therefore costs only a handful of
   * calls instead of one per commit.
   *
   * Semantics match the previous loop exactly for the requested paths: the value
   * for a path is the maximum author/committer date over all commits that
   * touched it. Commits with no author/committer date are skipped, and
   * individual `getCommit` failures are tolerated (best-effort), as before. The
   * supplied `signal` propagates through the retry hook, so a cancelled review
   * stops both in-flight requests and any backoff wait.
   */
  async getLatestCommitTimestampByFile(
    installationId: number,
    owner: string,
    repo: string,
    pullNumber: number,
    paths: string[],
    signal?: AbortSignal,
  ): Promise<Map<string, string>> {
    const octokit = await this.getInstallationOctokit(installationId, signal);
    const latestCommitByFile = new Map<string, string>();

    // Only the requested paths are ever read back, so we can stop once they are
    // all resolved. Tracking the outstanding set drives early termination.
    const pending = new Set(paths);
    if (pending.size === 0) return latestCommitByFile;

    const commits = await octokit.paginate(octokit.pulls.listCommits, {
      owner,
      repo,
      pull_number: pullNumber,
      per_page: 100,
    });

    // Attach each commit's timestamp (author date, then committer date), drop
    // commits without one (matching the previous loop's `continue`), then sort
    // newest first. Processing in descending-timestamp order with "first write
    // wins" yields, for every path, the maximum timestamp over the commits that
    // touched it — identical to taking the max in arrival order.
    const dated = commits
      .map((c: any) => ({
        sha: c.sha as string,
        ts: (c.commit?.author?.date ?? c.commit?.committer?.date ?? "") as string,
      }))
      .filter((c) => c.ts)
      .sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());

    for (const commit of dated) {
      if (pending.size === 0) break;
      if (signal?.aborted) break;
      try {
        const detail = await octokit.repos.getCommit({ owner, repo, ref: commit.sha });
        for (const f of detail.data.files ?? []) {
          // First (newest) commit touching a pending path wins — that is its max.
          if (pending.has(f.filename)) {
            latestCommitByFile.set(f.filename, commit.ts);
            pending.delete(f.filename);
          }
        }
      } catch {
        // Best-effort: a transient per-commit failure shouldn't drop the insight.
      }
    }

    return latestCommitByFile;
  }

  async findCommentByMarker(
    installationId: number,
    owner: string,
    repo: string,
    pullNumber: number,
    marker: string,
  ): Promise<{ id: number; body: string } | null> {
    const octokit = await this.getInstallationOctokit(installationId);
    const comments = await octokit.paginate(octokit.issues.listComments, {
      owner,
      repo,
      issue_number: pullNumber,
      per_page: 100,
    });
    const existing = comments.find(
      (c) => c.user?.type === "Bot" && c.body?.includes(marker),
    );
    if (!existing) return null;
    return { id: existing.id, body: existing.body ?? "" };
  }

  async upsertComment(
    installationId: number,
    owner: string,
    repo: string,
    pullNumber: number,
    body: string,
    marker: string,
    signal?: AbortSignal
  ): Promise<void> {
    const octokit = await this.getInstallationOctokit(installationId, signal);
    const log = logger.child({ owner, repo, pr: pullNumber });

    const comments = await octokit.paginate(octokit.issues.listComments, {
      owner,
      repo,
      issue_number: pullNumber,
      per_page: 100,
    });

    const existing = comments.find(
      (c) => c.user?.type === "Bot" && c.body?.includes(marker)
    );

    // upsertComment is generic — it backs the status, walkthrough, sticky,
    // issue-summary and pre-merge comments alike. Derive a label from the
    // marker so the log names the actual comment type instead of always saying
    // "walkthrough comment", which made distinct comments look like duplicate
    // walkthroughs in the logs.
    const commentLabel = marker.replace(/<!--\s*/, "").replace(/\s*-->/, "").trim() || marker;

    if (existing) {
      await octokit.issues.updateComment({
        owner,
        repo,
        comment_id: existing.id,
        body,
      });
      log.info({ commentId: existing.id, comment: commentLabel }, "Updated existing comment");
    } else {
      const created = await octokit.issues.createComment({
        owner,
        repo,
        issue_number: pullNumber,
        body,
      });
      log.info({ commentId: created?.data?.id, comment: commentLabel }, "Created new comment");
    }
  }

  async updatePRDescription(
    installationId: number,
    owner: string,
    repo: string,
    pullNumber: number,
    body: string,
    signal?: AbortSignal
  ): Promise<void> {
    const octokit = await this.getInstallationOctokit(installationId, signal);
    await octokit.pulls.update({
      owner,
      repo,
      pull_number: pullNumber,
      body,
    });
  }

  async getFileContent(
    installationId: number,
    owner: string,
    repo: string,
    path: string,
    ref: string
  ): Promise<string | null> {
    const octokit = await this.getInstallationOctokit(installationId);
    try {
      const response = await octokit.repos.getContent({
        owner,
        repo,
        path,
        ref,
      });

      const data = response.data as { content?: string; encoding?: string };
      if (data.content) {
        return Buffer.from(data.content, "base64").toString();
      }
      return null;
    } catch (err: any) {
      if (err.status === 404) {
        return null;
      }
      throw err;
    }
  }

  async replyToComment(
    installationId: number,
    owner: string,
    repo: string,
    pullNumber: number,
    commentId: number,
    body: string,
    kind: "issue" | "review_thread" = "issue"
  ): Promise<void> {
    const octokit = await this.getInstallationOctokit(installationId);
    if (kind === "review_thread") {
      // Reply inside the existing review thread so the conversation stays
      // collapsed under the diff hunk instead of fragmenting into a new
      // top-level issue comment.
      try {
        await octokit.pulls.createReplyForReviewComment({
          owner,
          repo,
          pull_number: pullNumber,
          comment_id: commentId,
          body,
        });
        return;
      } catch (err) {
        logger.warn({ err, commentId }, "createReplyForReviewComment failed, falling back to issue comment");
        // fall through to issue-comment fallback
      }
    }
    // Post as an issue comment (default + fallback)
    await octokit.issues.createComment({
      owner,
      repo,
      issue_number: pullNumber,
      body,
    });
  }

  async resolveAllComments(
    installationId: number,
    owner: string,
    repo: string,
    pullNumber: number
  ): Promise<void> {
    const octokit = await this.getInstallationOctokit(installationId);
    const log = logger.child({ owner, repo, pr: pullNumber });

    const resolved = await this.resolveReviewThreads(octokit, owner, repo, pullNumber);
    log.info({ resolved }, "Resolved all review threads");
  }

  /**
   * Resolve review threads on a PR where DiffSentry left comments on files
   * that were modified in the latest push. Uses GraphQL since the REST API
   * doesn't support resolving review threads.
   */
  async resolveAddressedThreads(
    installationId: number,
    owner: string,
    repo: string,
    pullNumber: number,
    changedFiles: string[]
  ): Promise<number> {
    const octokit = await this.getInstallationOctokit(installationId);
    const log = logger.child({ owner, repo, pr: pullNumber });
    const botLogin = `${this.config.botName}[bot]`.toLowerCase();
    const changed = new Set(changedFiles);

    try {
      const threads = await this.fetchAllReviewThreads(octokit, owner, repo, pullNumber);

      let resolvedCount = 0;
      for (const thread of threads) {
        if (thread.isResolved) continue;
        if (!changed.has(thread.path)) continue;
        if (!isOurBotThread(thread, botLogin)) continue;

        try {
          await octokit.graphql(`
            mutation($threadId: ID!) {
              resolveReviewThread(input: { threadId: $threadId }) {
                thread { id }
              }
            }
          `, { threadId: thread.id });
          resolvedCount++;
        } catch (err) {
          log.warn({ err, threadId: thread.id }, "Failed to resolve thread");
        }
      }

      log.info({ resolvedCount, totalThreads: threads.length }, "Auto-resolved addressed review threads");
      return resolvedCount;
    } catch (err) {
      log.warn({ err }, "Failed to auto-resolve review threads");
      return 0;
    }
  }

  /**
   * Resolve a single review thread by its node id. Returns true on success.
   */
  async resolveThreadById(
    installationId: number,
    owner: string,
    repo: string,
    pullNumber: number,
    threadId: string
  ): Promise<boolean> {
    const octokit = await this.getInstallationOctokit(installationId);
    const log = logger.child({ owner, repo, pr: pullNumber, threadId });
    try {
      await octokit.graphql(`
        mutation($threadId: ID!) {
          resolveReviewThread(input: { threadId: $threadId }) {
            thread { id }
          }
        }
      `, { threadId });
      return true;
    } catch (err) {
      log.warn({ err }, "Failed to resolve thread by id");
      return false;
    }
  }

  /**
   * Look up the thread node id that contains a given review-comment id, plus
   * the body of the original (first) comment in that thread. Returns null if
   * the comment isn't part of any thread the App can see.
   */
  async findThreadByCommentId(
    installationId: number,
    owner: string,
    repo: string,
    pullNumber: number,
    commentId: number
  ): Promise<{ threadId: string; originalBody: string; isResolved: boolean } | null> {
    const octokit = await this.getInstallationOctokit(installationId);
    const log = logger.child({ owner, repo, pr: pullNumber, commentId });
    try {
      const threads = await this.fetchAllReviewThreads(octokit, owner, repo, pullNumber, /*includeAllComments*/ true);
      for (const thread of threads) {
        const commentNodes = thread.comments?.nodes ?? [];
        const hit = commentNodes.find((c: any) => c.databaseId === commentId);
        if (hit) {
          return {
            threadId: thread.id,
            originalBody: commentNodes[0]?.body ?? "",
            isResolved: !!thread.isResolved,
          };
        }
      }
      return null;
    } catch (err) {
      log.warn({ err }, "Failed to look up thread by comment id");
      return null;
    }
  }

  private async fetchAllReviewThreads(
    octokit: Octokit,
    owner: string,
    repo: string,
    pullNumber: number,
    includeAllComments = false
  ): Promise<any[]> {
    const commentsBlock = includeAllComments
      ? `comments(first: 100) { nodes { databaseId body author { login __typename } } }`
      : `comments(first: 1) { nodes { author { login __typename } } }`;
    const query = `
      query($owner: String!, $repo: String!, $pr: Int!, $cursor: String) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $pr) {
            reviewThreads(first: 100, after: $cursor) {
              pageInfo { hasNextPage endCursor }
              nodes {
                id
                isResolved
                path
                ${commentsBlock}
              }
            }
          }
        }
      }
    `;
    const all: any[] = [];
    let cursor: string | null = null;
    while (true) {
      const result: any = await octokit.graphql(query, { owner, repo, pr: pullNumber, cursor });
      const block = result.repository.pullRequest.reviewThreads;
      all.push(...block.nodes);
      if (!block.pageInfo.hasNextPage) break;
      cursor = block.pageInfo.endCursor;
    }
    return all;
  }

  /**
   * Resolve all unresolved review threads on a PR (used by the "resolve" command).
   */
  private async resolveReviewThreads(
    octokit: Octokit,
    owner: string,
    repo: string,
    pullNumber: number
  ): Promise<number> {
    const log = logger.child({ owner, repo, pr: pullNumber });

    try {
      const threads = await this.fetchAllReviewThreads(octokit, owner, repo, pullNumber);

      let resolved = 0;
      for (const thread of threads) {
        if (thread.isResolved) continue;
        try {
          await octokit.graphql(`
            mutation($threadId: ID!) {
              resolveReviewThread(input: { threadId: $threadId }) {
                thread { id }
              }
            }
          `, { threadId: thread.id });
          resolved++;
        } catch (err) {
          log.warn({ err, threadId: thread.id }, "Failed to resolve thread");
        }
      }
      return resolved;
    } catch (err) {
      log.warn({ err }, "Failed to resolve review threads via GraphQL");
      return 0;
    }
  }

  // ─── Commit Status ──────────────────────────────────────────
  async setCommitStatus(
    installationId: number,
    owner: string,
    repo: string,
    sha: string,
    state: "pending" | "success" | "failure" | "error",
    description: string,
    context: string = "DiffSentry",
    signal?: AbortSignal
  ): Promise<void> {
    const octokit = await this.getInstallationOctokit(installationId, signal);
    await octokit.repos.createCommitStatus({
      owner,
      repo,
      sha,
      state,
      description,
      context,
    });
  }

  // ─── Labels ────────────────────────────────────────────────
  async applyLabels(
    installationId: number,
    owner: string,
    repo: string,
    pullNumber: number,
    labels: string[],
    signal?: AbortSignal
  ): Promise<void> {
    if (labels.length === 0) return;
    const octokit = await this.getInstallationOctokit(installationId, signal);
    const log = logger.child({ owner, repo, pr: pullNumber });
    try {
      await octokit.issues.addLabels({
        owner,
        repo,
        issue_number: pullNumber,
        labels,
      });
      log.info({ labels }, "Labels applied");
    } catch (err) {
      log.warn({ err, labels }, "Failed to apply labels (labels may not exist)");
    }
  }

  // ─── Reviewers ─────────────────────────────────────────────
  async assignReviewers(
    installationId: number,
    owner: string,
    repo: string,
    pullNumber: number,
    reviewers: string[],
    signal?: AbortSignal
  ): Promise<void> {
    if (reviewers.length === 0) return;
    const octokit = await this.getInstallationOctokit(installationId, signal);
    const log = logger.child({ owner, repo, pr: pullNumber });
    // Strip @ prefix if present
    const cleaned = reviewers.map((r) => r.replace(/^@/, ""));
    try {
      await octokit.pulls.requestReviewers({
        owner,
        repo,
        pull_number: pullNumber,
        reviewers: cleaned,
      });
      log.info({ reviewers: cleaned }, "Reviewers assigned");
    } catch (err) {
      log.warn({ err, reviewers: cleaned }, "Failed to assign reviewers");
    }
  }

  // ─── Search Related PRs ────────────────────────────────────
  async findRelatedPRs(
    installationId: number,
    owner: string,
    repo: string,
    pullNumber: number,
    changedFiles: string[],
    signal?: AbortSignal
  ): Promise<Array<{ number: number; title: string; url: string; state: string }>> {
    const octokit = await this.getInstallationOctokit(installationId, signal);
    const results: Array<{ number: number; title: string; url: string; state: string }> = [];
    try {
      // Find open PRs that touch the same files (limited search)
      const { data: prs } = await octokit.pulls.list({
        owner,
        repo,
        state: "open",
        per_page: 20,
      });
      for (const pr of prs) {
        if (pr.number === pullNumber) continue;
        try {
          const { data: files } = await octokit.pulls.listFiles({
            owner,
            repo,
            pull_number: pr.number,
            per_page: 50,
          });
          const overlap = files.some((f) => changedFiles.includes(f.filename));
          if (overlap) {
            results.push({
              number: pr.number,
              title: pr.title,
              url: pr.html_url,
              state: pr.state,
            });
          }
        } catch {
          // Skip PRs we can't read
        }
        if (results.length >= 5) break;
      }
    } catch (err) {
      logger.warn({ err }, "Failed to search related PRs");
    }
    return results;
  }

  private isIgnored(filename: string): boolean {
    return this.config.ignoredPatterns.some((pattern) => {
      if (pattern.includes("*")) {
        const regex = new RegExp(
          "^" + pattern.replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*") + "$"
        );
        return regex.test(filename);
      }
      return filename === pattern || filename.endsWith(pattern);
    });
  }
}
