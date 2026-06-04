import { Link } from "react-router-dom";
import { useAuth } from "../auth/useAuth";
import { ActionButton } from "./ActionButton";
import { GithubIcon } from "./icons";

// ─────────────────────────────────────────────────────────────────────────────
// <ActionBar> — the command strip shared by the PR detail and repo detail
// screens. Every control drives a real /api/v1 command endpoint (W0.4):
//
//   • Re-review (incremental) + Full re-review  → POST …/review {mode}
//   • Resolve threads                           → POST …/resolve
//   • Pause / Resume                            → POST …/pause | …/resume
//   • Cancel                                    → POST …/cancel
//   • Summary / TL;DR / Ship / Changelog /      → POST …/command {command}
//     Generate tests / Docstrings                 (synthesized "@bot <cmd>")
//
// Each button shows a spinner + optimistic toast and surfaces the server's
// audit-logged result. Writes require the `triggerReview` capability (author+):
// the whole write surface is *hidden* for viewers (hideWhenDenied), leaving only
// the GitHub link — matching the acceptance "hidden for viewers". The server
// still enforces requireRole + CSRF on every call.
// ─────────────────────────────────────────────────────────────────────────────

interface ActionBarProps {
  owner: string;
  repo: string;
  number: number;
  /** "repo" adds a note showing which PR the actions target (repo screen has
   * no single PR in scope, so the bar acts on the most recent one). */
  variant?: "pr" | "repo";
}

/** Chat commands surfaced as buttons. `token` is the allowlisted value the
 * /command endpoint maps back to a real "@bot <phrase>". */
const COMMANDS: { token: string; label: string; title: string }[] = [
  { token: "summary", label: "Summary", title: "Regenerate the PR summary + walkthrough" },
  { token: "tldr", label: "TL;DR", title: "Post a one-paragraph TL;DR of the PR" },
  { token: "ship", label: "Ship check", title: "Pre-flight verdict — is this PR ready to merge?" },
  { token: "changelog", label: "Changelog", title: "Post a Keep-a-Changelog entry for this PR" },
  { token: "generate_tests", label: "Gen tests", title: "Generate unit tests and commit to the branch" },
  { token: "generate_docstrings", label: "Docstrings", title: "Add missing docstrings and commit to the branch" },
];

export function ActionBar({ owner, repo, number, variant = "pr" }: ActionBarProps) {
  const { capabilities } = useAuth();
  const canAct = capabilities.triggerReview;
  const enc = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/prs/${number}`;
  // Refetch both the PR detail and (on the repo screen) the repo rollup so the
  // events/audit feed reflects the action without a manual refresh.
  const invalidateKeys: unknown[][] = [
    ["pr", owner, repo, number],
    ["repo", owner, repo],
  ];

  const ghHref = `https://github.com/${owner}/${repo}/pull/${number}`;
  const prPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pr/${number}`;

  return (
    <div className="action-bar">
      {variant === "repo" ? (
        <span className="action-bar-note">
          Actions target <Link to={prPath}>#{number}</Link>
        </span>
      ) : null}

      {canAct ? (
        <>
          <div className="action-bar-group">
            <ActionButton
              path={`${enc}/review`}
              body={{ mode: "incremental" }}
              capability="triggerReview"
              hideWhenDenied
              optimistic
              variant="primary"
              successTitle="Re-review queued"
              pendingLabel="Queuing…"
              invalidateKeys={invalidateKeys}
            >
              Re-review
            </ActionButton>
            <ActionButton
              path={`${enc}/review`}
              body={{ mode: "full" }}
              capability="triggerReview"
              hideWhenDenied
              optimistic
              successTitle="Full re-review queued"
              pendingLabel="Queuing…"
              invalidateKeys={invalidateKeys}
            >
              Full re-review
            </ActionButton>
            <ActionButton
              path={`${enc}/resolve`}
              capability="triggerReview"
              hideWhenDenied
              optimistic
              successTitle="Threads resolved"
              invalidateKeys={invalidateKeys}
            >
              Resolve threads
            </ActionButton>
            <ActionButton
              path={`${enc}/pause`}
              capability="triggerReview"
              hideWhenDenied
              optimistic
              successTitle="Reviews paused"
              invalidateKeys={invalidateKeys}
            >
              Pause
            </ActionButton>
            <ActionButton
              path={`${enc}/resume`}
              capability="triggerReview"
              hideWhenDenied
              optimistic
              successTitle="Reviews resumed"
              invalidateKeys={invalidateKeys}
            >
              Resume
            </ActionButton>
            <ActionButton
              path={`${enc}/cancel`}
              capability="triggerReview"
              hideWhenDenied
              optimistic
              variant="danger"
              successTitle="Review canceled"
              confirm="Abort any in-flight review for this PR?"
              invalidateKeys={invalidateKeys}
            >
              Cancel
            </ActionButton>
          </div>

          <span className="action-bar-sep" aria-hidden="true" />

          <div className="action-bar-group">
            {COMMANDS.map((c) => (
              <ActionButton
                key={c.token}
                path={`${enc}/command`}
                body={{ command: c.token }}
                capability="triggerReview"
                hideWhenDenied
                optimistic
                successTitle={`${c.label} queued`}
                pendingLabel="Queuing…"
                invalidateKeys={invalidateKeys}
                title={c.title}
              >
                {c.label}
              </ActionButton>
            ))}
          </div>
        </>
      ) : null}

      <span className="action-bar-spacer" />
      <a href={ghHref} className="btn btn-ghost" target="_blank" rel="noopener noreferrer">
        <GithubIcon />
        {variant === "repo" ? `Open #${number}` : "Open in GitHub"}
      </a>
    </div>
  );
}
