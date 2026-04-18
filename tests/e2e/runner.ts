import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pushScenarioBranch } from "./git.js";
import {
  BOT_LOGIN,
  closePR,
  deleteRefIfExists,
  getInlineComments,
  getIssueComments,
  getReviews,
  getStatusForBranch,
  openPR,
  postIssueComment,
} from "./gh.js";
import type {
  CapturedInlineComment,
  CapturedIssueComment,
  CapturedReview,
  CapturedStatus,
  ExpectationResult,
  Scenario,
  ScenarioRun,
} from "./types.js";

const RUNS_ROOT = path.resolve(process.cwd(), "tests/e2e/runs");
const POLL_INTERVAL_MS = 6_000;
const DEFAULT_TIMEOUT_MS = 240_000;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function fromBot(items: { user: string }[]) {
  return items.filter((x) => x.user === BOT_LOGIN);
}

function findWalkthrough(comments: CapturedIssueComment[]): string | null {
  const c = fromBot(comments).find((x) => x.body.includes("DiffSentry Walkthrough"));
  return c ? c.body : null;
}

async function pollUntil(
  prNumber: number,
  branch: string,
  scenario: Scenario,
): Promise<{
  reviews: CapturedReview[];
  inlineComments: CapturedInlineComment[];
  issueComments: CapturedIssueComment[];
  statuses: CapturedStatus[];
}> {
  const timeoutMs = scenario.waitFor.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const want = scenario.waitFor;
  const wantWalkthrough = want.walkthrough ?? true;
  const wantReview = want.review ?? true;

  let reviews: CapturedReview[] = [];
  let inlineComments: CapturedInlineComment[] = [];
  let issueComments: CapturedIssueComment[] = [];
  let statuses: CapturedStatus[] = [];

  while (Date.now() < deadline) {
    [reviews, inlineComments, issueComments, statuses] = await Promise.all([
      getReviews(prNumber),
      getInlineComments(prNumber),
      getIssueComments(prNumber),
      getStatusForBranch(branch),
    ]);

    const botReviews = fromBot(reviews);
    const botInline = fromBot(inlineComments);
    const botIssue = fromBot(issueComments);

    const walkthroughOK = !wantWalkthrough || !!findWalkthrough(issueComments);
    const reviewOK = !wantReview || botReviews.length > 0;
    const inlineOK =
      want.inlineCommentsAtLeast === undefined ||
      botInline.length >= want.inlineCommentsAtLeast;
    const issueOK =
      want.botIssueCommentsAtLeast === undefined ||
      botIssue.length >= want.botIssueCommentsAtLeast;
    const expectedStatus = scenario.expect?.statusState;
    const statusOK =
      !expectedStatus ||
      statuses.some((s) => s.context === "DiffSentry" && s.state === expectedStatus);

    if (walkthroughOK && reviewOK && inlineOK && issueOK && statusOK) break;
    await sleep(POLL_INTERVAL_MS);
  }

  return { reviews, inlineComments, issueComments, statuses };
}

function evalExpectations(
  scenario: Scenario,
  data: {
    walkthrough: string | null;
    reviews: CapturedReview[];
    inlineComments: CapturedInlineComment[];
    issueComments: CapturedIssueComment[];
    statuses: CapturedStatus[];
  },
): ExpectationResult[] {
  const results: ExpectationResult[] = [];
  const exp = scenario.expect;
  if (!exp) return results;

  if (exp.noBotActivity) {
    const any =
      fromBot(data.reviews).length +
      fromBot(data.inlineComments).length +
      fromBot(data.issueComments).length;
    results.push({
      name: "noBotActivity",
      passed: any === 0,
      detail: `bot activity items: ${any}`,
    });
  }

  if (exp.reviewState) {
    const states = fromBot(data.reviews).map((r) => r.state);
    results.push({
      name: `reviewState=${exp.reviewState}`,
      passed: states.includes(exp.reviewState),
      detail: `bot review states: [${states.join(", ")}]`,
    });
  }

  if (exp.reviewBodyContains) {
    const botBodies = fromBot(data.reviews)
      .map((r) => r.body ?? "")
      .filter(Boolean);
    for (const needle of exp.reviewBodyContains) {
      const ok = botBodies.some((b) => b.includes(needle));
      results.push({
        name: `review body contains "${needle}"`,
        passed: ok,
        detail: ok ? "found" : `not in ${botBodies.length} review body/bodies`,
      });
    }
  }

  if (exp.walkthroughContains) {
    for (const needle of exp.walkthroughContains) {
      const ok = !!data.walkthrough && data.walkthrough.includes(needle);
      results.push({
        name: `walkthrough contains "${needle}"`,
        passed: ok,
        detail: ok ? "found" : "not found",
      });
    }
  }

  if (exp.issueCommentContains) {
    for (const needle of exp.issueCommentContains) {
      const ok = fromBot(data.issueComments).some((c) => c.body.includes(needle));
      results.push({
        name: `issue comment contains "${needle}"`,
        passed: ok,
        detail: ok ? "found" : "not found",
      });
    }
  }

  if (exp.inlineCommentsContain) {
    for (const want of exp.inlineCommentsContain) {
      const candidates = fromBot(data.inlineComments).filter((c) =>
        want.pathContains ? c.path.includes(want.pathContains) : true,
      );
      const allMatched = want.bodyContains.every((needle) =>
        candidates.some((c) => c.body.includes(needle)),
      );
      results.push({
        name: `inline comment ${want.pathContains ? `on ${want.pathContains} ` : ""}contains [${want.bodyContains.join(", ")}]`,
        passed: allMatched,
        detail: `matched ${candidates.length} candidate(s)`,
      });
    }
  }

  if (exp.statusState) {
    const ds = data.statuses.find((s) => s.context === "DiffSentry");
    results.push({
      name: `status=${exp.statusState}`,
      passed: ds?.state === exp.statusState,
      detail: ds ? `actual: ${ds.state}` : "no DiffSentry status",
    });
  }

  return results;
}

function renderTranscript(run: ScenarioRun): string {
  const lines: string[] = [];
  lines.push(`# ${run.scenario}`);
  lines.push(`PR: ${run.prUrl}`);
  lines.push(`Branch: ${run.branch}`);
  lines.push(`Duration: ${(run.durationMs / 1000).toFixed(1)}s`);
  lines.push(`Result: ${run.passed ? "PASS" : "FAIL"}`);
  lines.push("");

  lines.push("## Expectations");
  if (run.expectations.length === 0) {
    lines.push("(none)");
  } else {
    for (const e of run.expectations) {
      lines.push(`- [${e.passed ? "x" : " "}] ${e.name} — ${e.detail}`);
    }
  }
  lines.push("");

  lines.push("## Statuses");
  for (const s of run.statuses) {
    lines.push(`- ${s.context}: ${s.state}${s.description ? ` — ${s.description}` : ""}`);
  }
  if (run.statuses.length === 0) lines.push("(none)");
  lines.push("");

  lines.push("## Bot Reviews");
  const botReviews = run.reviews.filter((r) => r.user === BOT_LOGIN);
  for (const r of botReviews) {
    lines.push(`### state=${r.state} @ ${r.submitted_at ?? "?"}`);
    lines.push(r.body ?? "(no body)");
    lines.push("");
  }
  if (botReviews.length === 0) lines.push("(none)");
  lines.push("");

  lines.push("## Bot Inline Comments");
  const botInline = run.inlineComments.filter((c) => c.user === BOT_LOGIN);
  for (const c of botInline) {
    lines.push(`### ${c.path}:${c.line ?? "?"}`);
    lines.push(c.body);
    lines.push("");
  }
  if (botInline.length === 0) lines.push("(none)");
  lines.push("");

  lines.push("## Bot Issue Comments");
  const botIssue = run.issueComments.filter((c) => c.user === BOT_LOGIN);
  for (const c of botIssue) {
    lines.push(`### @ ${c.created_at}`);
    lines.push(c.body);
    lines.push("");
  }
  if (botIssue.length === 0) lines.push("(none)");

  return lines.join("\n");
}

export async function runScenario(scenario: Scenario): Promise<ScenarioRun> {
  const startedAt = new Date();
  const slug = `${startedAt.toISOString().replace(/[:.]/g, "-")}_${scenario.name}`;
  const branch = `e2e/${scenario.name}-${startedAt.getTime().toString(36)}`;
  const runDir = path.join(RUNS_ROOT, slug);
  await mkdir(runDir, { recursive: true });

  console.log(`[${scenario.name}] preparing branch ${branch}`);
  await pushScenarioBranch({
    scenarioName: scenario.name,
    branch,
    files: scenario.files,
    commitMessage: `e2e: ${scenario.name}`,
  });

  console.log(`[${scenario.name}] opening PR`);
  const pr = await openPR({
    head: branch,
    title: scenario.prTitle,
    body: scenario.prBody ?? "Automated DiffSentry e2e scenario.",
    draft: scenario.draft,
  });

  let prNumber = pr.number;
  let prUrl = pr.url;
  let cleanupError: unknown = null;

  try {
    if (scenario.postPrActions) {
      // Wait briefly for initial walkthrough/review trigger before injecting comments
      await sleep(5_000);
      for (const action of scenario.postPrActions) {
        if (action.type === "comment") {
          console.log(`[${scenario.name}] posting comment: ${action.body.slice(0, 60)}`);
          await postIssueComment(prNumber, action.body);
        } else if (action.type === "wait") {
          await sleep(action.ms);
        }
      }
    }

    console.log(`[${scenario.name}] polling for bot activity`);
    const data = await pollUntil(prNumber, branch, scenario);
    const walkthrough = findWalkthrough(data.issueComments);

    const expectations = evalExpectations(scenario, { walkthrough, ...data });
    const passed = expectations.every((e) => e.passed);

    const finishedAt = new Date();
    const run: ScenarioRun = {
      scenario: scenario.name,
      branch,
      prNumber,
      prUrl,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      walkthrough,
      reviews: data.reviews,
      inlineComments: data.inlineComments,
      issueComments: data.issueComments,
      statuses: data.statuses,
      expectations,
      passed,
    };

    await writeFile(path.join(runDir, "run.json"), JSON.stringify(run, null, 2));
    if (walkthrough) await writeFile(path.join(runDir, "walkthrough.md"), walkthrough);
    await writeFile(path.join(runDir, "transcript.md"), renderTranscript(run));

    console.log(`[${scenario.name}] ${run.passed ? "PASS" : "FAIL"} — report: ${path.relative(process.cwd(), runDir)}`);
    return run;
  } finally {
    try {
      await closePR(prNumber, true);
      await deleteRefIfExists(branch);
    } catch (err) {
      cleanupError = err;
    }
    if (cleanupError) {
      console.warn(`[${scenario.name}] cleanup warning:`, cleanupError);
    }
  }
}
