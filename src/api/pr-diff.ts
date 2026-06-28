import type { Request, Response, Router } from "express";
import type { Octokit } from "@octokit/rest";
import { logger } from "../logger.js";
import { getFindingsForPR, getInstallationId, getPR } from "../dashboard/queries.js";
import type { Role } from "../dashboard/roles.js";

// ─────────────────────────────────────────────────────────────────────────────
// GET /repos/:owner/:repo/prs/:number/diff
//
// Returns the PR's raw unified diff (fetched live through the installation
// Octokit, with the github.ts retry/backoff hook already wrapped around it) plus
// the stored findings for the PR — each already carrying { path, line } so the
// SPA can anchor a marker to the changed line. Read-only: requireRole('viewer')
// + the router's global auth gate; a GET only needs the 'read' token scope.
//
// The diff is best-effort: when no GitHub App is configured, no installation is
// on record, or GitHub errors, `diff` is null and `diffError` explains why —
// the findings still return so the panel degrades to a list rather than a 500.
// ─────────────────────────────────────────────────────────────────────────────

type ErrorCode = "forbidden" | "not_found" | "bad_request" | "internal" | "unavailable";

function sendData(res: Response, data: unknown, status = 200): void {
  res.status(status).json({ data });
}

function sendError(res: Response, status: number, code: ErrorCode, message: string): void {
  res.status(status).json({ error: { code, message } });
}

// A unified diff for a large PR can be many megabytes; cap what we ship to the
// browser so a single huge PR can't blow up the response (and the renderer).
// Truncation is surfaced so the UI can show a "diff truncated" notice.
const MAX_DIFF_BYTES = 1_500_000;

export interface PrDiffDeps {
  /** Installation-scoped Octokit factory. Omitted when no GitHub App creds. */
  getInstallationOctokit?: (installationId: number) => Promise<Octokit>;
  requireRole: (role: Role) => import("express").RequestHandler;
}

export function registerPrDiffRoutes(router: Router, deps: PrDiffDeps): void {
  const { getInstallationOctokit, requireRole } = deps;

  router.get(
    "/repos/:owner/:repo/prs/:number/diff",
    requireRole("viewer"),
    async (req: Request, res: Response) => {
      const { owner, repo, number: numberRaw } = req.params as {
        owner: string;
        repo: string;
        number: string;
      };
      const number = Number.parseInt(numberRaw, 10);
      if (!Number.isFinite(number) || number <= 0) {
        sendError(res, 400, "bad_request", "Invalid PR number.");
        return;
      }

      try {
        const pr = getPR(owner, repo, number);
        const findings = getFindingsForPR(owner, repo, number);

        let diff: string | null = null;
        let truncated = false;
        let diffError: string | null = null;

        const installationId = getInstallationId(owner, repo);
        if (!getInstallationOctokit) {
          diffError = "Live diff is unavailable (no GitHub App credentials configured).";
        } else if (installationId == null) {
          diffError = `No installation on record for ${owner}/${repo}.`;
        } else {
          try {
            const octokit = await getInstallationOctokit(installationId);
            // The "diff" media type makes GitHub return the raw unified diff as
            // the response body; at runtime `data` is that string, not the PR
            // object the static types describe — hence the cast.
            const resp = await octokit.pulls.get({
              owner,
              repo,
              pull_number: number,
              mediaType: { format: "diff" },
            });
            const raw = resp.data as unknown as string;
            if (typeof raw === "string") {
              if (raw.length > MAX_DIFF_BYTES) {
                diff = raw.slice(0, MAX_DIFF_BYTES);
                truncated = true;
              } else {
                diff = raw;
              }
            } else {
              diffError = "GitHub returned an unexpected diff payload.";
            }
          } catch (err) {
            diffError = err instanceof Error ? err.message : String(err);
            logger.debug({ err, owner, repo, number }, "api: failed to fetch PR diff");
          }
        }

        // Only a genuine "nothing here" is a 404 — if we have any of PR row,
        // findings, or a diff, return what we have (with diffError when set).
        if (!pr && findings.length === 0 && diff === null) {
          sendError(res, 404, "not_found", `No data for ${owner}/${repo}#${number}.`);
          return;
        }

        sendData(res, { owner, repo, number, pr, diff, truncated, diffError, findings });
      } catch (err) {
        logger.error({ err, owner, repo, number }, "api PR diff failed");
        sendError(res, 500, "internal", "Failed to load PR diff.");
      }
    },
  );
}
