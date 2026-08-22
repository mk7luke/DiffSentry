import { logger } from "../logger.js";
import { markPRClosed, recordEvent } from "../storage/dao.js";
import { bus } from "../realtime/bus.js";
import { runReviewJob } from "../realtime/jobs.js";
import { isPauseAll, isAutoReviewEnabled } from "../settings/overrides.js";
import { addressesBot, SlashOptions } from "../slash-commands.js";
import { resolvesToSlashCommand } from "../commands.js";
import { isDiffSentryCheck } from "../checks-state.js";
import { WALKTHROUGH_MARKER } from "../walkthrough.js";

/**
 * Whether an automatic (webhook-triggered) review should be queued for a repo,
 * or a reason it's blocked. The global Pause-All kill switch wins, then the
 * per-repo auto-review toggle. Both are operator settings persisted in
 * settings_overrides and no-op (return null = allowed) when persistence is off.
 */
function reviewQueueBlockedReason(owner: string, repo: string): "paused" | "auto_review_disabled" | null {
  if (isPauseAll()) return "paused";
  if (!isAutoReviewEnabled(owner, repo)) return "auto_review_disabled";
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Webhook event dispatch.
//
// The routing that used to live inline in server.ts /webhook, lifted out so it
// can be driven from two places with identical behavior:
//   1. the live webhook handler (after signature verification), and
//   2. the admin "replay" endpoint, which re-dispatches a stored payload.
//
// It is deliberately `res`-free: it returns the { status, body } the caller
// should answer with, and fires the same fire-and-forget Reviewer calls the
// live path always did. The Reviewer is taken as a narrow structural surface
// (WebhookReviewer) so this module never imports the Reviewer class.
//
// Loop safety: dispatch only ever calls Reviewer methods (which talk to the
// GitHub API) — it never posts back to /webhook and never persists a delivery
// row itself. Recording (and thus a future re-dispatch) is the caller's job, so
// replaying a stored delivery can't recursively trigger more deliveries.
// ─────────────────────────────────────────────────────────────────────────────

/** The slice of Reviewer the webhook routing drives. Implemented by the real
 *  Reviewer; a fake is injected in the smoke test. */
export interface WebhookReviewer {
  handlePullRequest(
    installationId: number,
    owner: string,
    repo: string,
    pullNumber: number,
    mode: "full" | "incremental",
  ): Promise<void>;
  autoResolveOnPush(installationId: number, owner: string, repo: string, pullNumber: number): Promise<void>;
  syncReviewCommitStatus(
    installationId: number,
    owner: string,
    repo: string,
    pullNumber: number,
  ): Promise<boolean>;
  handlePRClose(owner: string, repo: string, pullNumber: number): void;
  handleIssueOpened(installationId: number, owner: string, repo: string, issueNumber: number): Promise<void>;
  handleComment(
    installationId: number,
    owner: string,
    repo: string,
    pullNumber: number,
    commentBody: string,
    commentId: number,
    commentKind?: "issue" | "review_thread",
  ): Promise<void>;
  handleIssueComment(
    installationId: number,
    owner: string,
    repo: string,
    issueOrPRNumber: number,
    commentBody: string,
    commentId: number,
  ): Promise<void>;
  handleChecksCompleted(
    installationId: number,
    owner: string,
    repo: string,
    headSha: string,
  ): Promise<void>;
  reconsiderAutoReleaseNotes(
    installationId: number,
    owner: string,
    repo: string,
    pullNumber: number,
  ): Promise<void>;
  getInstallationOctokit(installationId: number): Promise<import("@octokit/rest").Octokit>;
}

export interface WebhookDispatchDeps {
  reviewer: WebhookReviewer;
  botName: string;
  /** Accept `/command` syntax. Defaults to true when the caller omits it. */
  slashCommands?: boolean;
  /** Accept bare `/review` as well as `/<bot> review`. Defaults to true. */
  bareSlashCommands?: boolean;
}

/** Slash options for the comment gate, defaulting both switches on. */
function slashOptions(deps: WebhookDispatchDeps): SlashOptions {
  return { enabled: deps.slashCommands !== false, bare: deps.bareSlashCommands !== false };
}

export interface WebhookDispatchResult {
  status: number;
  body: Record<string, unknown>;
}

export interface WebhookMeta {
  owner: string | null;
  repo: string | null;
  number: number | null;
  action: string | null;
}

/**
 * Pull the routing/identity fields off a delivery payload, defensively (a
 * rejected, possibly-junk payload still gets persisted for inspection). Mirrors
 * the owner/repo/number derivation the recordEvent block used inline.
 */
export function extractWebhookMeta(payload: unknown): WebhookMeta {
  const p = (payload ?? {}) as Record<string, any>;
  return {
    owner: p.repository?.owner?.login ?? null,
    repo: p.repository?.name ?? null,
    number: p.pull_request?.number ?? p.issue?.number ?? null,
    action: typeof p.action === "string" ? p.action : null,
  };
}

/**
 * Route a verified webhook delivery to the Reviewer. Returns the HTTP status +
 * JSON body the caller should respond with. Background work (reviews, summaries,
 * comment handling) is kicked off fire-and-forget exactly as the live handler
 * always did — the 202 returns immediately and lifecycle events arrive via SSE.
 */
export async function dispatchWebhookEvent(
  deps: WebhookDispatchDeps,
  event: string,
  payload: any,
): Promise<WebhookDispatchResult> {
  const { reviewer, botName } = deps;

  // Persistent event log (best-effort; no-op when DB disabled).
  try {
    const owner = payload.repository?.owner?.login;
    const repo = payload.repository?.name;
    const number = payload.pull_request?.number ?? payload.issue?.number ?? null;
    if (owner && repo) {
      const kind = `${event}.${payload.action ?? ""}`.replace(/\.$/, "");
      recordEvent({ owner, repo, number, kind });
      // Live-tail the same event onto the bus so the Ops Console streams
      // webhook traffic the instant it lands (not just review lifecycle).
      bus.publish("webhook.received", {
        owner,
        repo,
        number: typeof number === "number" ? number : null,
        event,
        action: typeof payload.action === "string" ? payload.action : undefined,
        kind,
      });
    }
  } catch {
    // best effort
  }

  // ─── Pull Request Events ─────────────────────────────────
  if (event === "pull_request") {
    const action = payload.action;
    const { number } = payload.pull_request;
    const owner = payload.repository.owner.login;
    const repo = payload.repository.name;
    const installationId = payload.installation?.id;

    if (!installationId) {
      logger.warn("No installation ID in webhook payload");
      return { status: 400, body: { error: "No installation ID" } };
    }

    if (action === "opened") {
      const blocked = reviewQueueBlockedReason(owner, repo);
      if (blocked) {
        logger.info({ owner, repo, pr: number, action, blocked }, "Not queuing full review (operator control)");
        return { status: 200, body: { status: blocked } };
      }
      logger.info({ owner, repo, pr: number, action }, "PR opened, queuing full review");
      void runReviewJob({ reviewer, installationId, owner, repo, number, mode: "full" }).catch((err) => {
        logger.error({ err, owner, repo, pr: number }, "Background review failed");
      });
      return { status: 202, body: { status: "accepted" } };
    }

    if (action === "synchronize") {
      logger.info({ owner, repo, pr: number, action }, "PR updated");

      // Run push-driven auto-resolve unconditionally (not gated by pause/draft/auto-review),
      // so threads close even on PRs the bot won't re-review.
      const autoResolved = reviewer.autoResolveOnPush(installationId, owner, repo, number).catch((err) => {
        logger.error({ err, owner, repo, pr: number }, "Push auto-resolve failed");
      });

      // Gate only the re-review queue behind the operator controls — the
      // auto-resolve above still runs so addressed threads close.
      const blocked = reviewQueueBlockedReason(owner, repo);
      if (blocked) {
        logger.info({ owner, repo, pr: number, action, blocked }, "Not queuing incremental review (operator control)");
        // 202 because the push auto-resolve above was accepted, but surface the
        // blocked reason (paused | auto_review_disabled) so it's observable.
        return { status: 202, body: { status: blocked } };
      }

      // Queued behind auto-resolve rather than beside it. Auto-resolve retires
      // the state of the threads it closes, and the review builds its dedup set
      // and skip list from that state the moment it starts: racing the two lets
      // the pass read the pre-retirement copy and suppress the re-raise of a
      // finding auto-resolve had just closed unread. Chained, not awaited, so
      // the webhook still answers immediately.
      //
      // `autoResolved` is the promise AFTER its `.catch` above, so it never
      // rejects and `finally` always runs — the outer error is handled, not
      // dropped. The inner `.catch` covers only `runReviewJob`.
      void autoResolved.finally(() => {
        void runReviewJob({ reviewer, installationId, owner, repo, number, mode: "incremental" }).catch((err) => {
          logger.error({ err, owner, repo, pr: number }, "Background review failed");
        });
      });
      return { status: 202, body: { status: "accepted" } };
    }

    // closed — record the close/merge, then abort in-flight reviews
    if (action === "closed") {
      // Persist merge/close status. This is the only live path that sets
      // prs.merged_at, which the Impact/Overview "caught before merge" and
      // "merged PRs" metrics (and cross-PR memory) are gated on.
      const pr = payload.pull_request;
      const merged = !!pr.merged;
      markPRClosed(owner, repo, number, { merged, mergedAt: pr.merged_at, closedAt: pr.closed_at });
      logger.info(
        { owner, repo, pr: number, action, merged },
        merged ? "PR merged, recording merge and aborting any in-flight review" : "PR closed, aborting any in-flight review",
      );
      reviewer.handlePRClose(owner, repo, number);
      return { status: 200, body: { status: "ok" } };
    }

    // ready_for_review — draft PR became ready
    if (action === "ready_for_review") {
      const blocked = reviewQueueBlockedReason(owner, repo);
      if (blocked) {
        logger.info({ owner, repo, pr: number, action, blocked }, "Not queuing review (operator control)");
        return { status: 200, body: { status: blocked } };
      }
      logger.info({ owner, repo, pr: number, action }, "PR ready for review, queuing full review");
      void runReviewJob({ reviewer, installationId, owner, repo, number, mode: "full" }).catch((err) => {
        logger.error({ err, owner, repo, pr: number }, "Background review failed");
      });
      return { status: 202, body: { status: "accepted" } };
    }
  }

  // ─── Issue Events (auto-summary on opened) ───────────────
  if (event === "issues") {
    const action = payload.action;
    const issue = payload.issue;
    const owner = payload.repository.owner.login;
    const repo = payload.repository.name;
    const installationId = payload.installation?.id;

    if (!installationId || !issue) {
      return { status: 400, body: { error: "No installation/issue" } };
    }

    // Skip PR-shaped issue events (GitHub fires `issues` on PRs in some
    // edge cases; the `pull_request` field disambiguates).
    if (issue.pull_request) {
      return { status: 200, body: { status: "ignored" } };
    }

    // Bot-authored issues never get an auto-summary; avoids loops.
    if (issue.user?.type === "Bot") {
      return { status: 200, body: { status: "ignored" } };
    }

    if (action === "opened" || action === "reopened") {
      logger.info({ owner, repo, issue: issue.number, action }, "Issue opened, queuing auto-summary");
      reviewer.handleIssueOpened(installationId, owner, repo, issue.number).catch((err) => {
        logger.error({ err, owner, repo, issue: issue.number }, "Background issue summary failed");
      });
      return { status: 202, body: { status: "accepted" } };
    }

    // Other issue actions (edited, labeled, closed, assigned, ...) are
    // ignored for now — keep the surface tight, avoid noisy comments.
    return { status: 200, body: { status: "ignored" } };
  }

  // ─── Issue Comment Edited (Finishing Touches checkbox) ───
  if (event === "issue_comment" && payload.action === "edited") {
    const comment = payload.comment;
    const issue = payload.issue;
    const owner = payload.repository.owner.login;
    const repo = payload.repository.name;
    const installationId = payload.installation?.id;
    if (!issue.pull_request || !installationId) {
      return { status: 200, body: { status: "ignored" } };
    }

    const body: string = comment.body || "";
    const prevBody: string = payload.changes?.body?.from || "";
    // Only act on our own walkthrough comments (which carry the marker).
    if (!body.includes(WALKTHROUGH_MARKER)) {
      return { status: 200, body: { status: "ignored" } };
    }

    const triggers = [
      { label: "Create PR with unit tests", action: "generate_tests" as const },
      { label: "Push docstring commit to this branch", action: "generate_docstrings" as const },
      { label: "Push simplification commit to this branch", action: "simplify" as const },
      { label: "Push autofix commit to this branch", action: "autofix" as const },
    ];
    const newlyChecked: typeof triggers = [];
    for (const t of triggers) {
      const checkedNow = new RegExp(`-\\s*\\[x\\][^\\n]*${t.label.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}`).test(body);
      const checkedBefore = new RegExp(`-\\s*\\[x\\][^\\n]*${t.label.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}`).test(prevBody);
      if (checkedNow && !checkedBefore) newlyChecked.push(t);
    }

    if (newlyChecked.length === 0) {
      return { status: 200, body: { status: "ignored" } };
    }

    logger.info({ owner, repo, pr: issue.number, actions: newlyChecked.map((t) => t.action) }, "Finishing touches checkbox triggered");

    const commentId = comment.id;
    for (const t of newlyChecked) {
      const fakeBody = `@${botName} ${t.action.replace(/_/g, " ")}`;
      reviewer
        .handleComment(installationId, owner, repo, issue.number, fakeBody, commentId)
        .catch((err) => logger.error({ err, action: t.action }, "Finishing touches dispatch failed"));
    }
    return { status: 202, body: { status: "accepted", actions: newlyChecked.map((t) => t.action) } };
  }

  // ─── Issue Comment Events (Chat Commands) ────────────────
  if (event === "issue_comment" && payload.action === "created") {
    const comment = payload.comment;
    const issue = payload.issue;
    const owner = payload.repository.owner.login;
    const repo = payload.repository.name;
    const installationId = payload.installation?.id;

    if (!installationId) {
      return { status: 200, body: { status: "ignored" } };
    }

    const issueOrPRNumber = issue.number;
    const commentBody = comment.body || "";
    const commentId = comment.id;

    // Ignore comments authored by bots (including ourselves) — prevents
    // recursive self-triggering when our own walkthrough/tips text mentions
    // the bot name.
    if (comment.user?.type === "Bot") {
      return { status: 200, body: { status: "ignored" } };
    }

    // Is this comment addressed to us — by @mention or by slash command? The
    // check is the same on PRs and issues; only what we do next differs. An
    // unrecognized bare `/command` passes this gate but parses to nothing, so
    // another bot's ChatOps traffic costs us a no-op, not a reply.
    if (!addressesBot(commentBody, botName, slashOptions(deps))) {
      return { status: 200, body: { status: "ignored" } };
    }

    // Comment on a PR → existing PR comment handler.
    if (issue.pull_request) {
      logger.info({ owner, repo, pr: issueOrPRNumber, commentId }, "PR comment addressed to bot, processing command");
      reviewer
        .handleComment(installationId, owner, repo, issueOrPRNumber, commentBody, commentId)
        .catch((err) => {
          logger.error({ err, owner, repo, pr: issueOrPRNumber }, "Background comment handling failed");
        });
      return { status: 202, body: { status: "accepted" } };
    }

    // Comment on an actual issue → new issue handler.
    logger.info({ owner, repo, issue: issueOrPRNumber, commentId }, "Issue comment addressed to bot, processing command");
    reviewer
      .handleIssueComment(installationId, owner, repo, issueOrPRNumber, commentBody, commentId)
      .catch((err) => {
        logger.error({ err, owner, repo, issue: issueOrPRNumber }, "Background issue comment handling failed");
      });
    return { status: 202, body: { status: "accepted" } };
  }

  // ─── PR Review Comment Events (Reply to threads) ─────────
  if (event === "pull_request_review_comment" && payload.action === "created") {
    const comment = payload.comment;
    const owner = payload.repository.owner.login;
    const repo = payload.repository.name;
    const pullNumber = payload.pull_request.number;
    const installationId = payload.installation?.id;
    const commentBody = comment.body || "";
    const commentId = comment.id;

    if (!installationId) {
      return { status: 200, body: { status: "ignored" } };
    }

    if (comment.user?.type === "Bot") {
      return { status: 200, body: { status: "ignored" } };
    }

    // Treat any reply on a thread our bot started as an implicit @mention
    // — mirrors CodeRabbit. Detected via in_reply_to_id on the comment
    // and a lookup of the parent comment's author through the installation
    // Octokit (works on private repos, respects auth + rate limits).
    let isImplicitReply = false;
    const replyToId = comment.in_reply_to_id;
    if (replyToId) {
      try {
        const octokit = await reviewer.getInstallationOctokit(installationId);
        const parent = await octokit.pulls.getReviewComment({ owner, repo, comment_id: replyToId });
        const parentLogin = (parent.data.user?.login ?? "").toLowerCase();
        if (parent.data.user?.type === "Bot" && parentLogin.includes(botName.toLowerCase())) {
          isImplicitReply = true;
        }
      } catch (err) {
        logger.debug({ err, replyToId }, "Failed to fetch parent review comment");
      }
    }

    const isMention = commentBody.toLowerCase().includes(`@${botName.toLowerCase()}`);
    const isSlash = !isMention && addressesBot(commentBody, botName, slashOptions(deps));
    if (!isMention && !isSlash && !isImplicitReply) {
      return { status: 200, body: { status: "ignored" } };
    }

    // For implicit replies, prepend the mention so parseCommand routes
    // free-form text to the chat handler instead of returning null.
    //
    // A reply carrying a real command is left alone — prepending would turn
    // `/review` into a chat message about the word. The check is deliberately
    // stricter than the gate above: a reply that merely starts with a slash
    // ("/shrug", "/2 of these are flaky") is conversation, and rewriting it
    // into chat is better than dropping it on the floor.
    const carriesCommand = resolvesToSlashCommand(commentBody, botName, slashOptions(deps));
    const dispatchBody =
      isImplicitReply && !isMention && !carriesCommand ? `@${botName} ${commentBody}` : commentBody;

    logger.info({ owner, repo, pr: pullNumber, commentId, implicit: isImplicitReply }, "Processing review-thread comment");
    reviewer
      .handleComment(installationId, owner, repo, pullNumber, dispatchBody, commentId, "review_thread")
      .catch((err) => {
        logger.error({ err, owner, repo, pr: pullNumber }, "Background review comment handling failed");
      });
    return { status: 202, body: { status: "accepted", implicit: isImplicitReply } };
  }

  // ─── PR Review Thread Events (manual Resolve conversation) ─
  //
  // The only signal GitHub gives us when a human clicks "Resolve conversation"
  // in the UI. Without it, resolving DiffSentry's last open thread by hand
  // leaves its `failure` commit status standing until the next push, `resolve`,
  // or `ship` — the status is only ever written by a review pass, and nothing
  // re-runs one on resolution.
  //
  // Only resolution-state changes are acted on, in both directions. This used
  // to be one-directional on the grounds that "re-opening a thread is not
  // grounds for writing a new failure that no review pass ever produced" — but
  // the status is now *derived* from live threads rather than recorded once by
  // a review pass, so a re-opened blocking thread is exactly grounds for a
  // failure. Setting a commit status raises no thread event, so there is still
  // no loop to guard against.
  if (
    event === "pull_request_review_thread" &&
    (payload.action === "resolved" || payload.action === "unresolved")
  ) {
    const owner = payload.repository?.owner?.login;
    const repo = payload.repository?.name;
    const pullNumber = payload.pull_request?.number;
    const installationId = payload.installation?.id;

    if (!installationId || !owner || !repo || typeof pullNumber !== "number") {
      return { status: 200, body: { status: "ignored" } };
    }

    // Fires for DiffSentry's own resolutions too, which the in-process paths
    // already handle. Harmless: the sync short-circuits when the status it would
    // write already matches the one on the SHA, and setting a commit status
    // raises no thread event, so there's no loop to guard against.
    logger.info({ owner, repo, pr: pullNumber, action: payload.action }, "Review thread resolution changed, syncing review status");
    reviewer.syncReviewCommitStatus(installationId, owner, repo, pullNumber).catch((err) => {
      logger.error({ err, owner, repo, pr: pullNumber }, "Review status sync failed");
    });
    // Resolving the last blocking finding is the other way a PR becomes eligible
    // for automatic release notes, and it's the common one: the checks usually
    // went green long before anyone got to the findings. The status this sync
    // writes can't carry that news, since `status` deliveries for our own
    // context are dropped below.
    reviewer.reconsiderAutoReleaseNotes(installationId, owner, repo, pullNumber).catch((err) => {
      logger.error({ err, owner, repo, pr: pullNumber }, "Automatic release notes failed");
    });
    return { status: 202, body: { status: "accepted" } };
  }

  // ─── Check Completion (automatic release notes) ──────────
  //
  // Two events, because GitHub reports results in two systems: modern
  // integrations write check runs, which roll up into a check suite, and older
  // ones write commit statuses. Subscribing to `check_run` as well would add
  // nothing, since a completed run always completes its suite too, and would
  // multiply the deliveries by the number of jobs in the matrix.
  //
  // Neither payload is trusted for the verdict. A completed suite is one suite
  // of however many the PR has, so all that is taken from it is the head SHA;
  // the aggregate state for that commit is re-read downstream.
  if (event === "check_suite" || event === "status") {
    const owner = payload.repository?.owner?.login;
    const repo = payload.repository?.name;
    const installationId = payload.installation?.id;
    const headSha = event === "check_suite" ? payload.check_suite?.head_sha : payload.sha;

    if (!installationId || !owner || !repo || typeof headSha !== "string") {
      return { status: 200, body: { status: "ignored" } };
    }

    // `requested` and `rerequested` mean a suite has started, which is the
    // opposite of the signal being waited on.
    if (event === "check_suite" && payload.action !== "completed") {
      return { status: 200, body: { status: "ignored" } };
    }

    // A pending status cannot be the one that turns a PR green. Neither can
    // DiffSentry's own, which is excluded from the verdict on purpose (see
    // `isDiffSentryCheck`). Since resolving a thread makes the app write
    // that status, dropping it here is also what stops the app re-reading every
    // check on a commit in response to an event it raised itself.
    if (event === "status" && (payload.state === "pending" || isDiffSentryCheck(payload.context ?? ""))) {
      return { status: 200, body: { status: "ignored" } };
    }

    logger.info({ owner, repo, sha: headSha, event }, "Checks completed, evaluating automatic release notes");
    reviewer.handleChecksCompleted(installationId, owner, repo, headSha).catch((err) => {
      logger.error({ err, owner, repo, sha: headSha }, "Automatic release notes failed");
    });
    return { status: 202, body: { status: "accepted" } };
  }

  return { status: 200, body: { status: "ignored" } };
}
