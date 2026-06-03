import { logger } from "../logger.js";
import { recordEvent } from "../storage/dao.js";

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
  getInstallationOctokit(installationId: number): Promise<import("@octokit/rest").Octokit>;
}

export interface WebhookDispatchDeps {
  reviewer: WebhookReviewer;
  botName: string;
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
      recordEvent({ owner, repo, number, kind: `${event}.${payload.action ?? ""}`.replace(/\.$/, "") });
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
      logger.info({ owner, repo, pr: number, action }, "PR opened, queuing full review");
      reviewer.handlePullRequest(installationId, owner, repo, number, "full").catch((err) => {
        logger.error({ err, owner, repo, pr: number }, "Background review failed");
      });
      return { status: 202, body: { status: "accepted" } };
    }

    if (action === "synchronize") {
      logger.info({ owner, repo, pr: number, action }, "PR updated, queuing incremental review");

      // Run push-driven auto-resolve unconditionally (not gated by pause/draft/auto-review),
      // so threads close even on PRs the bot won't re-review.
      reviewer.autoResolveOnPush(installationId, owner, repo, number).catch((err) => {
        logger.error({ err, owner, repo, pr: number }, "Push auto-resolve failed");
      });

      reviewer.handlePullRequest(installationId, owner, repo, number, "incremental").catch((err) => {
        logger.error({ err, owner, repo, pr: number }, "Background review failed");
      });
      return { status: 202, body: { status: "accepted" } };
    }

    // closed — abort in-flight reviews
    if (action === "closed") {
      logger.info({ owner, repo, pr: number, action }, "PR closed, aborting any in-flight review");
      reviewer.handlePRClose(owner, repo, number);
      return { status: 200, body: { status: "ok" } };
    }

    // ready_for_review — draft PR became ready
    if (action === "ready_for_review") {
      logger.info({ owner, repo, pr: number, action }, "PR ready for review, queuing full review");
      reviewer.handlePullRequest(installationId, owner, repo, number, "full").catch((err) => {
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
    if (!body.includes("<!-- DiffSentry Walkthrough -->")) {
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

    // Check if our bot is mentioned. The mention check is the same on PRs
    // and issues — only what we do next differs.
    if (!commentBody.toLowerCase().includes(`@${botName.toLowerCase()}`)) {
      return { status: 200, body: { status: "ignored" } };
    }

    // Comment on a PR → existing PR comment handler.
    if (issue.pull_request) {
      logger.info({ owner, repo, pr: issueOrPRNumber, commentId }, "Bot mentioned in PR comment, processing command");
      reviewer
        .handleComment(installationId, owner, repo, issueOrPRNumber, commentBody, commentId)
        .catch((err) => {
          logger.error({ err, owner, repo, pr: issueOrPRNumber }, "Background comment handling failed");
        });
      return { status: 202, body: { status: "accepted" } };
    }

    // Comment on an actual issue → new issue handler.
    logger.info({ owner, repo, issue: issueOrPRNumber, commentId }, "Bot mentioned in issue comment, processing command");
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
    if (!isMention && !isImplicitReply) {
      return { status: 200, body: { status: "ignored" } };
    }

    // For implicit replies, prepend the mention so parseCommand routes
    // free-form text to the chat handler instead of returning null.
    const dispatchBody = isImplicitReply && !isMention ? `@${botName} ${commentBody}` : commentBody;

    logger.info({ owner, repo, pr: pullNumber, commentId, implicit: isImplicitReply }, "Processing review-thread comment");
    reviewer
      .handleComment(installationId, owner, repo, pullNumber, dispatchBody, commentId, "review_thread")
      .catch((err) => {
        logger.error({ err, owner, repo, pr: pullNumber }, "Background review comment handling failed");
      });
    return { status: 202, body: { status: "accepted", implicit: isImplicitReply } };
  }

  return { status: 200, body: { status: "ignored" } };
}
