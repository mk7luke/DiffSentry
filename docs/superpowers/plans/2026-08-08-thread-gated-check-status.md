# Thread-Gated `DiffSentry` Commit Status — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `DiffSentry` commit status a live function of the PR's unresolved *blocking* review threads, so a merge commit can never flip a red check green and `ship` can turn a green check red.

**Architecture:** Finding severity is stamped into each inline comment body as a hidden HTML marker at post time, read back off the thread's first comment, and folded into `ReviewThreadSummary` as `botUnresolvedBlocking`. A single pure function `resolveReviewStatus` decides `success` vs `failure`, and all four status writers (final verdict, empty-diff path, the refresh helper, `ship`) route through it.

**Tech Stack:** TypeScript (ESM, NodeNext), Vitest, Octokit REST + GraphQL, JSON-schema-driven repo config.

## Global Constraints

- All source is TypeScript ESM. **Relative imports must carry a `.js` extension** (`./thread-severity.js`), even from `.ts` files. This is enforced by `tsconfig.json`'s NodeNext resolution.
- Tests live in `tests/unit/<name>.test.ts` and import from `../../src/<mod>.js`.
- Run tests with `npx vitest run <path>`; the full suite is `npm test`. Typecheck with `npm run build:server`. Lint with `npm run lint`.
- Severity vocabulary is exactly `"critical" | "major" | "minor" | "trivial"` (`CommentSeverity`, `src/types.ts:282`).
- The commit status context string is `REVIEW_STATUS_CONTEXT = "DiffSentry"` (`src/github.ts:12`). Never hardcode the literal in new code — import the constant.
- `reviews.commit_status: false` must remain a hard off-switch: no status write of any kind.
- Blocking severities are `critical` and `major`. **Absent/unparseable severity counts as blocking.**
- Human-opened threads never gate the status. Only threads passing `isOurBotThread`.
- Commit after every task. Conventional commit prefixes (`feat:`, `fix:`, `test:`, `docs:`, `refactor:`).

---

### Task 1: The severity wire format

A new module owns the hidden marker so the writer (`src/ai/parse.ts`) and the reader (`src/github.ts`) share one definition. `src/github.ts` must not import the AI layer — that would invert the dependency direction — hence a dedicated module rather than a helper on `parse.ts`.

**Files:**
- Create: `src/thread-severity.ts`
- Modify: `src/ai/parse.ts:88` (remove the private `VALID_SEVERITIES`, import it instead), `src/ai/parse.ts:341-343` (emit the marker)
- Test: `tests/unit/thread-severity.test.ts`

**Interfaces:**
- Consumes: `CommentSeverity` from `src/types.js`.
- Produces:
  - `VALID_SEVERITIES: readonly CommentSeverity[]`
  - `renderSeverityMarker(severity: CommentSeverity): string`
  - `parseThreadSeverity(body: string): CommentSeverity | undefined`
  - `isBlockingSeverity(severity: CommentSeverity | undefined): boolean`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/thread-severity.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  renderSeverityMarker,
  parseThreadSeverity,
  isBlockingSeverity,
  VALID_SEVERITIES,
} from "../../src/thread-severity.js";

describe("renderSeverityMarker", () => {
  it("renders an HTML comment that survives markdown rendering", () => {
    expect(renderSeverityMarker("critical")).toBe("<!-- diffsentry-severity:critical -->");
  });
});

describe("parseThreadSeverity", () => {
  it("round-trips every severity", () => {
    for (const sev of VALID_SEVERITIES) {
      expect(parseThreadSeverity(`some finding\n\n${renderSeverityMarker(sev)}`)).toBe(sev);
    }
  });

  it("returns undefined when the marker is absent", () => {
    // Every thread posted before this shipped looks like this.
    expect(parseThreadSeverity("a finding with no marker")).toBeUndefined();
  });

  it("returns undefined for an unrecognised severity", () => {
    expect(parseThreadSeverity("<!-- diffsentry-severity:catastrophic -->")).toBeUndefined();
  });

  it("returns undefined for an empty body", () => {
    expect(parseThreadSeverity("")).toBeUndefined();
  });

  it("takes the last marker when several are present", () => {
    // A finding whose prose quotes an earlier marker must not win over the
    // real one, which formatCommentBody always appends at the end.
    const body = "quoting <!-- diffsentry-severity:trivial -->\n\n<!-- diffsentry-severity:critical -->";
    expect(parseThreadSeverity(body)).toBe("critical");
  });

  it("tolerates whitespace variation inside the marker", () => {
    expect(parseThreadSeverity("<!--diffsentry-severity:major-->")).toBe("major");
    expect(parseThreadSeverity("<!--   diffsentry-severity:major   -->")).toBe("major");
  });
});

describe("isBlockingSeverity", () => {
  it("blocks on critical and major", () => {
    expect(isBlockingSeverity("critical")).toBe(true);
    expect(isBlockingSeverity("major")).toBe(true);
  });

  it("does not block on minor and trivial", () => {
    expect(isBlockingSeverity("minor")).toBe(false);
    expect(isBlockingSeverity("trivial")).toBe(false);
  });

  it("blocks on unknown severity", () => {
    // Fail-safe: a thread DiffSentry cannot read must not silently go green.
    expect(isBlockingSeverity(undefined)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/thread-severity.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/thread-severity.js"`

- [ ] **Step 3: Create the module**

Create `src/thread-severity.ts`:

```ts
import type { CommentSeverity } from "./types.js";

/**
 * Severity is decided at review time but lost once a finding becomes a GitHub
 * review thread — nothing in the rendered body is machine-readable on the way
 * back. Stamping it as a hidden HTML comment lets `summarizeReviewThreads` tell
 * an unresolved `critical` apart from an unresolved nitpick, which is what
 * makes severity-gated commit statuses possible.
 *
 * This module owns the wire format for both sides. It deliberately depends on
 * nothing but the severity type: `src/github.ts` reads markers and must not
 * import the AI layer that writes them.
 */
export const VALID_SEVERITIES: readonly CommentSeverity[] = ["critical", "major", "minor", "trivial"];

/** Severities that gate the `DiffSentry` commit status. */
const BLOCKING: readonly CommentSeverity[] = ["critical", "major"];

const MARKER_KEY = "diffsentry-severity";

/** Tolerant of the whitespace GitHub's markdown pipeline may normalise. */
const MARKER_RE = new RegExp(`<!--\\s*${MARKER_KEY}:\\s*([a-z]+)\\s*-->`, "gi");

export function renderSeverityMarker(severity: CommentSeverity): string {
  return `<!-- ${MARKER_KEY}:${severity} -->`;
}

/**
 * Severity of the finding a review-thread body represents, or `undefined` when
 * the body carries no readable marker — which is every thread posted before
 * this shipped. Callers treat `undefined` as blocking.
 *
 * The *last* marker wins: `formatCommentBody` always appends the real one after
 * the finding's prose, so a marker quoted inside that prose cannot outrank it.
 */
export function parseThreadSeverity(body: string): CommentSeverity | undefined {
  if (!body) return undefined;
  let found: CommentSeverity | undefined;
  for (const m of body.matchAll(MARKER_RE)) {
    const candidate = m[1].toLowerCase() as CommentSeverity;
    if (VALID_SEVERITIES.includes(candidate)) found = candidate;
  }
  return found;
}

/** Unknown severity blocks: an unreadable thread must never read as green. */
export function isBlockingSeverity(severity: CommentSeverity | undefined): boolean {
  return severity === undefined || BLOCKING.includes(severity);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/thread-severity.test.ts`
Expected: PASS (all 10 assertions)

- [ ] **Step 5: Emit the marker when posting findings**

In `src/ai/parse.ts`, delete the private declaration at line 88:

```ts
const VALID_SEVERITIES: CommentSeverity[] = ["critical", "major", "minor", "trivial"];
```

and add to the import block at the top of the file:

```ts
import { VALID_SEVERITIES, renderSeverityMarker } from "../thread-severity.js";
```

`VALID_SEVERITIES` is used at `parse.ts:467` and `parse.ts:556` via `.includes(...)`; the imported `readonly CommentSeverity[]` supports that unchanged.

Then in `formatCommentBody`, immediately after the existing fingerprint block (currently `src/ai/parse.ts:341-343`):

```ts
  if (comment.fingerprint) {
    parts.push(`<!-- diffsentry-fingerprint:${comment.fingerprint} -->`);
  }

  // Lets summarizeReviewThreads read this finding's severity back off the live
  // thread, so an unresolved nitpick doesn't gate the commit status the way an
  // unresolved critical does.
  if (comment.severity) {
    parts.push(renderSeverityMarker(comment.severity));
  }
```

- [ ] **Step 6: Add a round-trip test through the real renderer**

Append to `tests/unit/thread-severity.test.ts`:

`formatCommentBody` is module-private; `renderInlineCommentBody`
(`src/ai/parse.ts:283`) is its exported wrapper and takes the same object.

```ts
import { renderInlineCommentBody } from "../../src/ai/parse.js";

describe("renderInlineCommentBody integration", () => {
  it("stamps a marker that parseThreadSeverity reads back", () => {
    const body = renderInlineCommentBody({
      title: "Null deref",
      body: "Null deref here.",
      severity: "critical",
      fingerprint: "abc123",
    });
    expect(parseThreadSeverity(body)).toBe("critical");
  });

  it("omits the marker when the finding has no severity", () => {
    const body = renderInlineCommentBody({ title: "FYI", body: "Just a note." });
    expect(parseThreadSeverity(body)).toBeUndefined();
  });
});
```

- [ ] **Step 7: Run the tests and typecheck**

Run: `npx vitest run tests/unit/thread-severity.test.ts && npm run build:server`
Expected: PASS, and a clean `tsc` with no output.

- [ ] **Step 8: Commit**

```bash
git add src/thread-severity.ts src/ai/parse.ts tests/unit/thread-severity.test.ts
git commit -m "feat(threads): stamp finding severity into review comment bodies"
```

---

### Task 2: Count blocking threads in the summary

**Files:**
- Modify: `src/github.ts:16-22` (`ReviewThreadSummary`), `src/github.ts:1430-1432` (GraphQL field), `src/github.ts:1297-1319` (`summarizeReviewThreads`)
- Test: `tests/unit/thread-gate.test.ts`

**Interfaces:**
- Consumes: `parseThreadSeverity`, `isBlockingSeverity` from Task 1.
- Produces: `ReviewThreadSummary.botUnresolvedBlocking: number`, and an exported pure helper `countBlockingThreads(threads: unknown[], botLogin: string): number` so the counting rule is testable without a GitHub client.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/thread-gate.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { countBlockingThreads } from "../../src/github.js";
import { renderSeverityMarker } from "../../src/thread-severity.js";

const BOT = "diffsentry[bot]";

/** Shape of the GraphQL node `fetchAllReviewThreads` returns. */
function thread(over: {
  isResolved?: boolean;
  severity?: "critical" | "major" | "minor" | "trivial";
  marker?: boolean;
  author?: { login: string; __typename: string };
}) {
  const marker = over.marker === false || !over.severity ? "" : `\n\n${renderSeverityMarker(over.severity!)}`;
  return {
    id: "T",
    isResolved: over.isResolved ?? false,
    path: "src/a.ts",
    comments: {
      nodes: [
        {
          body: `A finding.${marker}`,
          author: over.author ?? { login: "diffsentry[bot]", __typename: "Bot" },
        },
      ],
    },
  };
}

describe("countBlockingThreads", () => {
  it("counts unresolved critical and major threads", () => {
    expect(countBlockingThreads([thread({ severity: "critical" }), thread({ severity: "major" })], BOT)).toBe(2);
  });

  it("ignores unresolved minor and trivial threads", () => {
    expect(countBlockingThreads([thread({ severity: "minor" }), thread({ severity: "trivial" })], BOT)).toBe(0);
  });

  it("ignores resolved threads regardless of severity", () => {
    expect(countBlockingThreads([thread({ severity: "critical", isResolved: true })], BOT)).toBe(0);
  });

  it("counts an unresolved thread with no marker as blocking", () => {
    // Every thread posted before this shipped. Fail-safe by design.
    expect(countBlockingThreads([thread({ marker: false })], BOT)).toBe(1);
  });

  it("ignores threads a human opened", () => {
    const human = thread({ author: { login: "mk7luke", __typename: "User" } });
    expect(countBlockingThreads([human], BOT)).toBe(0);
  });

  it("is zero for an empty thread list", () => {
    expect(countBlockingThreads([], BOT)).toBe(0);
  });

  it("tolerates a thread with no comments", () => {
    expect(countBlockingThreads([{ id: "T", isResolved: false, comments: { nodes: [] } }], BOT)).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/thread-gate.test.ts`
Expected: FAIL — `countBlockingThreads is not a function`

- [ ] **Step 3: Add the field to the summary type**

In `src/github.ts`, extend the interface at line 16:

```ts
export interface ReviewThreadSummary {
  total: number;
  unresolved: number;
  /** Threads opened by DiffSentry. */
  botTotal: number;
  botUnresolved: number;
  /**
   * Unresolved DiffSentry threads whose finding is severe enough to gate the
   * commit status — `critical`, `major`, or (fail-safe) unreadable severity.
   * Always `<= botUnresolved`.
   */
  botUnresolvedBlocking: number;
}
```

- [ ] **Step 4: Fetch the body and count**

In `src/github.ts`, add to the import block:

```ts
import { parseThreadSeverity, isBlockingSeverity } from "./thread-severity.js";
```

Change the cheap GraphQL branch at line 1431-1432 so the first comment's body comes back:

```ts
    const commentsBlock = includeAllComments
      ? `comments(first: 100) { nodes { databaseId body author { login __typename } } }`
      : `comments(first: 1) { nodes { body author { login __typename } } }`;
```

Add the exported helper next to `isOurBotThread` (near `src/github.ts:313`):

```ts
/**
 * Unresolved bot threads that gate the commit status.
 *
 * Exported for testing: the rule (which severities block, and that an
 * unreadable one blocks) is the whole point of the gate and deserves coverage
 * without standing up a GitHub client.
 */
export function countBlockingThreads(threads: any[], botLogin: string): number {
  let n = 0;
  for (const t of threads) {
    if (t.isResolved) continue;
    if (!isOurBotThread(t, botLogin)) continue;
    const body = t.comments?.nodes?.[0]?.body ?? "";
    if (isBlockingSeverity(parseThreadSeverity(body))) n++;
  }
  return n;
}
```

Then populate the field in `summarizeReviewThreads` (`src/github.ts:1308-1318`):

```ts
    const summary: ReviewThreadSummary = {
      total: 0, unresolved: 0, botTotal: 0, botUnresolved: 0, botUnresolvedBlocking: 0,
    };
    for (const thread of threads) {
      const ours = isOurBotThread(thread, botLogin);
      summary.total++;
      if (ours) summary.botTotal++;
      if (!thread.isResolved) {
        summary.unresolved++;
        if (ours) summary.botUnresolved++;
      }
    }
    summary.botUnresolvedBlocking = countBlockingThreads(threads, botLogin);
    return summary;
```

- [ ] **Step 5: Fix every other `ReviewThreadSummary` literal**

Adding a required field breaks existing object literals. Find them:

```bash
grep -rn "botUnresolved: 0" src/ tests/
```

Known sites to update by adding `botUnresolvedBlocking: 0`:
- `src/reviewer.ts:2479` — the `.catch()` fallback in the `ship` command
- `tests/unit/ship-check.test.ts:9` — the `threads()` helper's defaults

Add the field to each. `npm run build:server` in the next step is the authority on whether any were missed.

- [ ] **Step 6: Run tests and typecheck**

Run: `npx vitest run tests/unit/thread-gate.test.ts && npm run build:server`
Expected: PASS, clean `tsc`.

- [ ] **Step 7: Commit**

```bash
git add src/github.ts src/reviewer.ts tests/unit/thread-gate.test.ts tests/unit/ship-check.test.ts
git commit -m "feat(threads): count unresolved blocking threads in the summary"
```

---

### Task 3: `resolveReviewStatus` and the config knob

**Files:**
- Modify: `src/ship-check.ts` (add the function), `src/types.ts:95-120` (`ReviewsConfig`), `src/config-schema.ts:61` (schema)
- Test: `tests/unit/ship-check.test.ts`

**Interfaces:**
- Consumes: `ReviewThreadSummary` (Task 2).
- Produces:
  ```ts
  export type ThreadGate = "blocking" | "off";
  export function resolveReviewStatus(input: {
    approval?: "APPROVE" | "COMMENT" | "REQUEST_CHANGES";
    threads: ReviewThreadSummary;
    successDescription: string;
    gate?: ThreadGate;
  }): { state: "success" | "failure"; description: string };
  ```
  and `ReviewsConfig.thread_gate?: ThreadGate`.

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/ship-check.test.ts` (the file's `threads()` helper already exists at line 8; reuse it):

```ts
import { resolveReviewStatus } from "../../src/ship-check.js";

describe("resolveReviewStatus", () => {
  const clean = threads({ total: 0, unresolved: 0, botTotal: 0, botUnresolved: 0, botUnresolvedBlocking: 0 });
  const oneBlocking = threads({ total: 1, unresolved: 1, botTotal: 1, botUnresolved: 1, botUnresolvedBlocking: 1 });
  const onlyNits = threads({ total: 3, unresolved: 3, botTotal: 3, botUnresolved: 3, botUnresolvedBlocking: 0 });

  it("fails on an unresolved blocking thread even when the review only commented", () => {
    // The reported bug: COMMENTED + open threads used to be green.
    const r = resolveReviewStatus({ approval: "COMMENT", threads: oneBlocking, successDescription: "ok" });
    expect(r.state).toBe("failure");
    expect(r.description).toBe("1 unresolved blocking finding");
  });

  it("pluralises the blocking description", () => {
    const many = threads({ botTotal: 3, botUnresolved: 3, botUnresolvedBlocking: 3 });
    expect(resolveReviewStatus({ threads: many, successDescription: "ok" }).description)
      .toBe("3 unresolved blocking findings");
  });

  it("stays green when only nitpicks are open", () => {
    const r = resolveReviewStatus({ approval: "COMMENT", threads: onlyNits, successDescription: "Review complete with comments" });
    expect(r.state).toBe("success");
    expect(r.description).toBe("Review complete with comments");
  });

  it("still fails on REQUEST_CHANGES with no open threads", () => {
    const r = resolveReviewStatus({ approval: "REQUEST_CHANGES", threads: clean, successDescription: "ok" });
    expect(r.state).toBe("failure");
    expect(r.description).toBe("Changes requested");
  });

  it("uses the caller's success description when nothing blocks", () => {
    const r = resolveReviewStatus({ threads: clean, successDescription: "No reviewable files" });
    expect(r).toEqual({ state: "success", description: "No reviewable files" });
  });

  it("works with no approval at all (the empty-diff path has no verdict)", () => {
    expect(resolveReviewStatus({ threads: oneBlocking, successDescription: "No reviewable files" }).state).toBe("failure");
  });

  it("ignores threads entirely when the gate is off", () => {
    const r = resolveReviewStatus({ approval: "COMMENT", threads: oneBlocking, successDescription: "ok", gate: "off" });
    expect(r).toEqual({ state: "success", description: "ok" });
  });

  it("still honours REQUEST_CHANGES when the gate is off", () => {
    const r = resolveReviewStatus({ approval: "REQUEST_CHANGES", threads: clean, successDescription: "ok", gate: "off" });
    expect(r.state).toBe("failure");
  });

  it("defaults to the blocking gate when none is given", () => {
    expect(resolveReviewStatus({ threads: oneBlocking, successDescription: "ok" }).state).toBe("failure");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/ship-check.test.ts`
Expected: FAIL — `resolveReviewStatus is not a function`

- [ ] **Step 3: Implement the function**

Add to `src/ship-check.ts`:

```ts
/** How unresolved DiffSentry threads affect the `DiffSentry` commit status. */
export type ThreadGate = "blocking" | "off";

/**
 * The single decision point for the `DiffSentry` commit status.
 *
 * Before this existed the rule was spread across three call sites that each got
 * it slightly differently — most visibly the empty-diff path, which hard-coded
 * `success` and so let a "Merge branch 'main'…" commit erase a real failure.
 *
 * Unresolved *blocking* findings outrank the review verdict: a `COMMENTED`
 * review that opened a `critical` thread is a failure until that thread is
 * resolved. Nitpicks never gate — see `isBlockingSeverity`.
 */
export function resolveReviewStatus(input: {
  approval?: "APPROVE" | "COMMENT" | "REQUEST_CHANGES";
  threads: ReviewThreadSummary;
  /** Description used when nothing blocks, e.g. "No reviewable files". */
  successDescription: string;
  gate?: ThreadGate;
}): { state: "success" | "failure"; description: string } {
  const blocking = input.threads.botUnresolvedBlocking;
  if ((input.gate ?? "blocking") === "blocking" && blocking > 0) {
    return {
      state: "failure",
      description: `${blocking} unresolved blocking finding${blocking === 1 ? "" : "s"}`,
    };
  }
  if (input.approval === "REQUEST_CHANGES") {
    return { state: "failure", description: "Changes requested" };
  }
  return { state: "success", description: input.successDescription };
}
```

`ReviewThreadSummary` is already imported at the top of `src/ship-check.ts:1`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/ship-check.test.ts`
Expected: PASS

- [ ] **Step 5: Add the config knob**

In `src/types.ts`, inside `ReviewsConfig` (after `commit_status?: boolean;` at line 103):

```ts
  /**
   * Whether unresolved blocking DiffSentry findings gate the `DiffSentry`
   * commit status. "blocking" (default) fails the check while a critical or
   * major thread is open; "off" restores verdict-only behaviour.
   */
  thread_gate?: "blocking" | "off";
```

In `src/config-schema.ts`, after the `commit_status` entry at line 61:

```ts
        thread_gate: {
          type: "string",
          enum: ["blocking", "off"],
          description: "Fail the DiffSentry check while a critical/major review thread is unresolved.",
        },
```

- [ ] **Step 6: Verify the schema accepts the new key**

Run: `npm run build:server && npx vitest run tests/unit/ && npm run smoke:config`
Expected: clean `tsc`, unit suite green, config smoke script exits 0.

If `smoke:config` fails for a reason unrelated to this key (e.g. it needs a live server), note it and rely on the unit suite plus typecheck instead.

- [ ] **Step 7: Commit**

```bash
git add src/ship-check.ts src/types.ts src/config-schema.ts tests/unit/ship-check.test.ts
git commit -m "feat(status): add resolveReviewStatus and the reviews.thread_gate knob"
```

---

### Task 4: Route the two review-pass writers through it

**Files:**
- Modify: `src/reviewer.ts:836-841` (empty-diff path), `src/reviewer.ts:1902-1919` (final verdict)
- Test: `tests/unit/review-status.test.ts`

**Interfaces:**
- Consumes: `resolveReviewStatus` (Task 3), `summarizeReviewThreads` (Task 2).
- Produces: no new exports; behavioural change only.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/review-status.test.ts`. This exercises the decision the two call sites make, with the GitHub client mocked, rather than driving a whole review pass:

```ts
import { describe, it, expect, vi } from "vitest";
import { resolveReviewStatus } from "../../src/ship-check.js";
import type { ReviewThreadSummary } from "../../src/github.js";

function threads(over: Partial<ReviewThreadSummary> = {}): ReviewThreadSummary {
  return { total: 0, unresolved: 0, botTotal: 0, botUnresolved: 0, botUnresolvedBlocking: 0, ...over };
}

/**
 * Mirrors the empty-diff branch at src/reviewer.ts:836 — the "Merge branch
 * 'main' into …" case that used to hard-code success and erase a real failure.
 */
describe("empty-diff status decision", () => {
  it("stays red when a blocking thread is open", () => {
    const r = resolveReviewStatus({
      threads: threads({ botTotal: 3, botUnresolved: 3, botUnresolvedBlocking: 2 }),
      successDescription: "No reviewable files",
    });
    expect(r).toEqual({ state: "failure", description: "2 unresolved blocking findings" });
  });

  it("goes green when nothing blocks", () => {
    const r = resolveReviewStatus({ threads: threads(), successDescription: "No reviewable files" });
    expect(r).toEqual({ state: "success", description: "No reviewable files" });
  });

  it("goes green when the only open threads are nitpicks", () => {
    const r = resolveReviewStatus({
      threads: threads({ botTotal: 2, botUnresolved: 2, botUnresolvedBlocking: 0 }),
      successDescription: "No reviewable files",
    });
    expect(r.state).toBe("success");
  });
});

describe("final-verdict status decision", () => {
  it("reds a COMMENT verdict that left a blocking thread open", () => {
    const r = resolveReviewStatus({
      approval: "COMMENT",
      threads: threads({ botTotal: 1, botUnresolved: 1, botUnresolvedBlocking: 1 }),
      successDescription: "Review complete with comments",
    });
    expect(r.state).toBe("failure");
  });

  it("keeps APPROVE green", () => {
    const r = resolveReviewStatus({ approval: "APPROVE", threads: threads(), successDescription: "Looks good!" });
    expect(r).toEqual({ state: "success", description: "Looks good!" });
  });
});
```

- [ ] **Step 2: Run test to verify it passes already**

Run: `npx vitest run tests/unit/review-status.test.ts`
Expected: PASS — this test locks in Task 3's contract from the call sites' point of view. The wiring below is what makes the call sites actually use it.

- [ ] **Step 3: Rewrite the empty-diff status write**

Replace `src/reviewer.ts:836-841`:

```ts
        if (repoConfig.reviews?.commit_status !== false) {
          await this.github.setCommitStatus(
            installationId, owner, repo, context.headSha,
            "success", "No reviewable files", "DiffSentry", signal
          ).catch(() => {});
        }
        return;
```

with:

```ts
        if (repoConfig.reviews?.commit_status !== false) {
          // A "Merge branch 'main' into …" commit produces an empty incremental
          // diff, which is not the same thing as an addressed review. Writing an
          // unconditional `success` here let a branch update erase a real
          // failure, so the status is re-derived from the PR's live threads
          // instead of assumed green.
          const liveThreads = await this.github
            .summarizeReviewThreads(installationId, owner, repo, pullNumber, signal)
            .catch((): ReviewThreadSummary => ({
              total: 0, unresolved: 0, botTotal: 0, botUnresolved: 0, botUnresolvedBlocking: 0,
            }));
          const status = resolveReviewStatus({
            threads: liveThreads,
            successDescription: "No reviewable files",
            gate: repoConfig.reviews?.thread_gate,
          });
          await this.github.setCommitStatus(
            installationId, owner, repo, context.headSha,
            status.state, status.description, REVIEW_STATUS_CONTEXT, signal
          ).catch(() => {});
        }
        return;
```

Note the fallback on `.catch`: a thread-fetch failure must not red a PR on a guess, so it degrades to "nothing blocking" and the status follows the old behaviour.

- [ ] **Step 4: Rewrite the final-verdict status write**

Replace `src/reviewer.ts:1902-1919`:

```ts
      // Set final commit status
      if (repoConfig.reviews?.commit_status !== false) {
        const statusMap = {
          APPROVE: "success" as const,
          COMMENT: "success" as const,
          REQUEST_CHANGES: "failure" as const,
        };
        await this.github.setCommitStatus(
          installationId, owner, repo, context.headSha,
          statusMap[reviewResult.approval],
          reviewResult.approval === "APPROVE"
            ? "Looks good!"
            : reviewResult.approval === "REQUEST_CHANGES"
            ? "Changes requested"
            : "Review complete with comments",
          "DiffSentry", signal
        ).catch((err) => log.warn({ err }, "Failed to set commit status"));
      }
```

with:

```ts
      // Set final commit status. Read the threads *now*, after this pass has
      // posted its own and after push auto-resolve has run, so the count
      // reflects the PR's true end state rather than its state on entry.
      if (repoConfig.reviews?.commit_status !== false) {
        const liveThreads = await this.github
          .summarizeReviewThreads(installationId, owner, repo, pullNumber, signal)
          .catch((): ReviewThreadSummary => ({
            total: 0, unresolved: 0, botTotal: 0, botUnresolved: 0, botUnresolvedBlocking: 0,
          }));
        const status = resolveReviewStatus({
          approval: reviewResult.approval,
          threads: liveThreads,
          successDescription:
            reviewResult.approval === "APPROVE" ? "Looks good!" : "Review complete with comments",
          gate: repoConfig.reviews?.thread_gate,
        });
        await this.github.setCommitStatus(
          installationId, owner, repo, context.headSha,
          status.state, status.description, REVIEW_STATUS_CONTEXT, signal
        ).catch((err) => log.warn({ err }, "Failed to set commit status"));
      }
```

- [ ] **Step 5: Fix imports**

Confirm `src/reviewer.ts`'s import from `./ship-check.js` (line 7) includes `resolveReviewStatus`:

```ts
import { assessShipSignals, renderShipCheck, resolveReviewStatus, type CommitStatusLike } from "./ship-check.js";
```

and that `REVIEW_STATUS_CONTEXT` and `type ReviewThreadSummary` are imported from `./github.js` (both already are — verify with `grep -n "REVIEW_STATUS_CONTEXT\|ReviewThreadSummary" src/reviewer.ts | head`, and add whichever is missing).

- [ ] **Step 6: Run the full unit suite and typecheck**

Run: `npx vitest run tests/unit/ && npm run build:server`
Expected: PASS, clean `tsc`.

- [ ] **Step 7: Commit**

```bash
git add src/reviewer.ts tests/unit/review-status.test.ts
git commit -m "fix(status): derive the review check from live threads, not an assumed green"
```

---

### Task 5: Make the status sync bidirectional

**Files:**
- Modify: `src/reviewer.ts:462-510` (rename + rewrite `refreshReviewCommitStatus`), plus its call sites
- Test: `tests/unit/status-sync.test.ts`

**Interfaces:**
- Consumes: `resolveReviewStatus` (Task 3), `getCommitStatusState` / `setCommitStatus` on `GitHubClient`.
- Produces: `Reviewer.syncReviewCommitStatus(installationId, owner, repo, pullNumber, opts?): Promise<boolean>` — returns `true` only when the status was actually changed. Replaces `refreshReviewCommitStatus`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/status-sync.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { Reviewer } from "../../src/reviewer.js";
import type { ReviewThreadSummary } from "../../src/github.js";

function threads(over: Partial<ReviewThreadSummary> = {}): ReviewThreadSummary {
  return { total: 0, unresolved: 0, botTotal: 0, botUnresolved: 0, botUnresolvedBlocking: 0, ...over };
}

/** A Reviewer with only the GitHub calls syncReviewCommitStatus touches. */
function reviewerWith(opts: { currentState: string | null; threads: ReviewThreadSummary }) {
  const setCommitStatus = vi.fn().mockResolvedValue(undefined);
  const reviewer = Object.create(Reviewer.prototype) as Reviewer;
  (reviewer as any).github = {
    getHeadSha: vi.fn().mockResolvedValue("abc123"),
    getCommitStatusState: vi.fn().mockResolvedValue(opts.currentState),
    summarizeReviewThreads: vi.fn().mockResolvedValue(opts.threads),
    setCommitStatus,
  };
  return { reviewer, setCommitStatus };
}

describe("syncReviewCommitStatus", () => {
  it("clears a failure once every blocking thread is resolved", async () => {
    const { reviewer, setCommitStatus } = reviewerWith({
      currentState: "failure",
      threads: threads({ botTotal: 2, botUnresolved: 0, botUnresolvedBlocking: 0 }),
    });
    await expect(reviewer.syncReviewCommitStatus(1, "o", "r", 7)).resolves.toBe(true);
    expect(setCommitStatus).toHaveBeenCalledWith(1, "o", "r", "abc123", "success", expect.any(String), "DiffSentry");
  });

  it("reds a passing status when a blocking thread is open", async () => {
    // This is the direction the old refreshReviewCommitStatus could not go,
    // which is why `ship` left the check green on a PR with 3 open threads.
    const { reviewer, setCommitStatus } = reviewerWith({
      currentState: "success",
      threads: threads({ botTotal: 3, botUnresolved: 3, botUnresolvedBlocking: 3 }),
    });
    await expect(reviewer.syncReviewCommitStatus(1, "o", "r", 7)).resolves.toBe(true);
    expect(setCommitStatus).toHaveBeenCalledWith(
      1, "o", "r", "abc123", "failure", "3 unresolved blocking findings", "DiffSentry",
    );
  });

  it("no-ops when the status already matches", async () => {
    const { reviewer, setCommitStatus } = reviewerWith({
      currentState: "success",
      threads: threads({ botTotal: 1, botUnresolved: 0, botUnresolvedBlocking: 0 }),
    });
    await expect(reviewer.syncReviewCommitStatus(1, "o", "r", 7)).resolves.toBe(false);
    expect(setCommitStatus).not.toHaveBeenCalled();
  });

  it("no-ops when no DiffSentry status exists on the SHA", async () => {
    // Covers reviews.commit_status:false without a config read, and keeps the
    // sync from inventing a status for a SHA no review pass has touched.
    const { reviewer, setCommitStatus } = reviewerWith({
      currentState: null,
      threads: threads({ botTotal: 1, botUnresolved: 1, botUnresolvedBlocking: 1 }),
    });
    await expect(reviewer.syncReviewCommitStatus(1, "o", "r", 7)).resolves.toBe(false);
    expect(setCommitStatus).not.toHaveBeenCalled();
  });

  it("no-ops when the head SHA cannot be read", async () => {
    const { reviewer, setCommitStatus } = reviewerWith({ currentState: "failure", threads: threads() });
    (reviewer as any).github.getHeadSha = vi.fn().mockResolvedValue(null);
    await expect(reviewer.syncReviewCommitStatus(1, "o", "r", 7)).resolves.toBe(false);
    expect(setCommitStatus).not.toHaveBeenCalled();
  });

  it("leaves nitpick-only threads green", async () => {
    const { reviewer, setCommitStatus } = reviewerWith({
      currentState: "success",
      threads: threads({ botTotal: 4, botUnresolved: 4, botUnresolvedBlocking: 0 }),
    });
    await expect(reviewer.syncReviewCommitStatus(1, "o", "r", 7)).resolves.toBe(false);
    expect(setCommitStatus).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/status-sync.test.ts`
Expected: FAIL — `reviewer.syncReviewCommitStatus is not a function`

- [ ] **Step 3: Rewrite the method**

Replace the whole of `refreshReviewCommitStatus` (`src/reviewer.ts:477-510`) and the doc comment above it (from roughly line 462) with:

```ts
  /**
   * Bring the `DiffSentry` commit status in line with the PR's live review
   * threads, in whichever direction that requires.
   *
   * The status is only ever written by a review pass, and resolving a thread
   * doesn't trigger one — so without this the check drifts out of date the
   * moment the threads move. It used to drift in one direction only: it could
   * clear a failure it had written, but nothing could re-red a green check, so
   * `ship` reported open blocking threads and a passing check in the same
   * breath.
   *
   * A `null` current state means we've never posted this context on this SHA —
   * either no review pass has run, or the repo set `reviews.commit_status:
   * false`. Both are a no-op, which is how the config is honoured here without
   * a config read.
   *
   * Best-effort; returns true only when the status was actually changed.
   */
  async syncReviewCommitStatus(
    installationId: number,
    owner: string,
    repo: string,
    pullNumber: number,
    opts: { headSha?: string; threads?: ReviewThreadSummary; gate?: "blocking" | "off" } = {},
  ): Promise<boolean> {
    const log = logger.child({ owner, repo, pr: pullNumber });
    try {
      const headSha =
        opts.headSha ?? (await this.github.getHeadSha(installationId, owner, repo, pullNumber));
      if (!headSha) return false;

      const current = await this.github.getCommitStatusState(
        installationId, owner, repo, headSha, REVIEW_STATUS_CONTEXT,
      );
      if (current === null) return false;

      const threads =
        opts.threads ??
        (await this.github.summarizeReviewThreads(installationId, owner, repo, pullNumber));

      // No approval: this path has no verdict of its own, and re-deriving one
      // from the last review would resurrect a REQUEST_CHANGES whose threads are
      // now resolved — the exact staleness this is here to clear.
      const target = resolveReviewStatus({
        threads,
        successDescription: "All review threads resolved",
        gate: opts.gate,
      });
      if (target.state === current) return false;

      await this.github.setCommitStatus(
        installationId, owner, repo, headSha,
        target.state, target.description, REVIEW_STATUS_CONTEXT,
      );
      log.info({ headSha, threads, from: current, to: target.state }, "Synced review commit status");
      return true;
    } catch (err) {
      log.warn({ err }, "Failed to sync review commit status");
      return false;
    }
  }
```

- [ ] **Step 4: Update every call site**

```bash
grep -rn "refreshReviewCommitStatus" src/ tests/
```

Rename at each:
- `src/webhook/dispatch.ts:51` — the interface member on the injected `reviewer`
- `src/webhook/dispatch.ts:464` — the call
- `src/reviewer.ts:2496` — inside the `ship` command
- `tests/unit/slash-dispatch.test.ts` — any mock or assertion naming the old method

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run tests/unit/ && npm run build:server`
Expected: PASS, clean `tsc`.

- [ ] **Step 6: Commit**

```bash
git add src/reviewer.ts src/webhook/dispatch.ts tests/unit/status-sync.test.ts tests/unit/slash-dispatch.test.ts
git commit -m "fix(status): make the review status sync bidirectional"
```

---

### Task 6: React to threads being re-opened

**Files:**
- Modify: `src/webhook/dispatch.ts:437-468`
- Test: `tests/unit/slash-dispatch.test.ts`

**Interfaces:**
- Consumes: `reviewer.syncReviewCommitStatus` (Task 5).
- Produces: no new exports.

- [ ] **Step 1: Write the failing test**

The entry point is `dispatchWebhookEvent(deps, event, payload)`, and `makeDeps`
(`tests/unit/slash-dispatch.test.ts:23`) builds the `WebhookDispatchDeps` stub.
Dispatch is fire-and-forget, so use the file's existing `settle()` helper before
asserting. Add `vi` to the file's `vitest` import.

Append to `tests/unit/slash-dispatch.test.ts`:

```ts
function threadPayload(action: string): any {
  return {
    action,
    installation: { id: 1 },
    repository: { owner: { login: "acme" }, name: "app" },
    pull_request: { number: 7 },
  };
}

describe("pull_request_review_thread", () => {
  it("syncs the status when a thread is re-opened", async () => {
    // The direction the old handler ignored on purpose. Now that the status is
    // derived from live threads, re-opening one must be able to red the check.
    const syncReviewCommitStatus = vi.fn().mockResolvedValue(true);
    const deps = makeDeps({ reviewer: { syncReviewCommitStatus } as any });

    const res = await dispatchWebhookEvent(deps, "pull_request_review_thread", threadPayload("unresolved"));
    await settle();

    expect(res.status).toBe(202);
    expect(syncReviewCommitStatus).toHaveBeenCalledWith(1, "acme", "app", 7);
  });

  it("still syncs when a thread is resolved", async () => {
    const syncReviewCommitStatus = vi.fn().mockResolvedValue(true);
    const deps = makeDeps({ reviewer: { syncReviewCommitStatus } as any });

    await dispatchWebhookEvent(deps, "pull_request_review_thread", threadPayload("resolved"));
    await settle();

    expect(syncReviewCommitStatus).toHaveBeenCalledWith(1, "acme", "app", 7);
  });

  it("ignores other thread actions", async () => {
    const syncReviewCommitStatus = vi.fn();
    const deps = makeDeps({ reviewer: { syncReviewCommitStatus } as any });

    const res = await dispatchWebhookEvent(deps, "pull_request_review_thread", threadPayload("edited"));
    await settle();

    expect(res.status).toBe(200);
    expect(syncReviewCommitStatus).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/slash-dispatch.test.ts`
Expected: FAIL on the `unresolved` case — the handler currently returns `{ status: 200, body: { status: "ignored" } }` for it.

- [ ] **Step 3: Handle both actions**

In `src/webhook/dispatch.ts`, replace the condition at line 449 and rewrite the justification comment at lines 445-448:

```ts
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
```

and update the log line just below it:

```ts
    logger.info({ owner, repo, pr: pullNumber, action: payload.action }, "Review thread resolution changed, syncing review status");
    reviewer.syncReviewCommitStatus(installationId, owner, repo, pullNumber).catch((err) => {
      logger.error({ err, owner, repo, pr: pullNumber }, "Review status sync failed");
    });
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run tests/unit/slash-dispatch.test.ts && npm run build:server`
Expected: PASS, clean `tsc`.

- [ ] **Step 5: Commit**

```bash
git add src/webhook/dispatch.ts tests/unit/slash-dispatch.test.ts
git commit -m "fix(webhook): sync the review status when a thread is re-opened"
```

---

### Task 7: Ship Check and sticky status read blocking vs. nit

**Files:**
- Modify: `src/ship-check.ts:36-52` (`assessShipSignals`), `src/ship-check.ts:65-147` (`renderShipCheck`), `src/reviewer.ts:2489-2499` (ship command), `src/sticky-status.ts:47`, and the `renderStickyStatus` call site in `src/reviewer.ts`
- Test: `tests/unit/ship-check.test.ts`

**Interfaces:**
- Consumes: `ReviewThreadSummary.botUnresolvedBlocking` (Task 2), `resolveReviewStatus` (Task 3), `syncReviewCommitStatus` (Task 5).
- Produces: no new exports; `renderStickyStatus` gains a `blockingThreads: number` option.

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/ship-check.test.ts`:

```ts
describe("renderShipCheck — blocking threads", () => {
  const base = {
    botName: BOT,
    reviewState: "COMMENTED",
    statusRefreshed: false,
  };

  it("files a blocking thread as a blocker and reports Not ready", () => {
    // The reported bug: 3 unresolved threads rendered 🟡 "Probably safe to ship".
    const t = threads({ total: 3, unresolved: 3, botTotal: 3, botUnresolved: 3, botUnresolvedBlocking: 2 });
    const body = renderShipCheck({
      ...base,
      threads: t,
      signals: assessShipSignals({ reviewState: "COMMENTED", threads: t, statuses: [] }),
    });

    expect(body).toContain("🔴 **Not ready.**");
    expect(body).toContain("## Blockers");
    expect(body).toContain("2 unresolved blocking findings");
  });

  it("files nitpick-only threads as a warning and stays amber", () => {
    const t = threads({ total: 2, unresolved: 2, botTotal: 2, botUnresolved: 2, botUnresolvedBlocking: 0 });
    const body = renderShipCheck({
      ...base,
      threads: t,
      signals: assessShipSignals({ reviewState: "COMMENTED", threads: t, statuses: [] }),
    });

    expect(body).toContain("🟡 **Probably safe to ship**");
    expect(body).not.toContain("## Blockers");
    expect(body).toContain("2 unresolved review threads");
  });

  it("shows the blocking breakdown in the status table", () => {
    const t = threads({ total: 3, unresolved: 3, botTotal: 3, botUnresolved: 3, botUnresolvedBlocking: 2 });
    const body = renderShipCheck({
      ...base,
      threads: t,
      signals: assessShipSignals({ reviewState: "COMMENTED", threads: t, statuses: [] }),
    });
    expect(body).toContain("| Unresolved review threads | 3 (2 blocking) |");
  });
});

describe("assessShipSignals — blocking threads", () => {
  it("does not call a failing status stale while a blocking thread is open", () => {
    // botUnresolved is 0 for bot threads that were resolved, but an unreadable
    // legacy thread still counts as blocking — the status is genuinely failing.
    const t = threads({ total: 1, unresolved: 1, botTotal: 2, botUnresolved: 1, botUnresolvedBlocking: 1 });
    const signals = assessShipSignals({ reviewState: "COMMENTED", threads: t, statuses: [STALE_FAILURE] });
    expect(signals.staleFailing).toEqual([]);
    expect(signals.failingChecks).toEqual([STALE_FAILURE]);
  });

  it("still calls a failing status stale when nothing blocks", () => {
    const signals = assessShipSignals({ reviewState: "COMMENTED", threads: ALL_ADDRESSED, statuses: [STALE_FAILURE] });
    expect(signals.staleFailing).toEqual([STALE_FAILURE]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/ship-check.test.ts`
Expected: FAIL — the blocking cases still render 🟡 and put threads under Warnings.

- [ ] **Step 3: Narrow the staleness rule**

In `src/ship-check.ts`, change `assessShipSignals`'s `isStale` predicate (line 42):

```ts
  const reviewFeedbackAddressed = isReviewFeedbackAddressed(input.threads);
  // A failing status is only stale if the current rule would write green. A
  // blocking thread — including a legacy one whose severity we can't read —
  // means the failure is live, not left over.
  const nothingBlocking = input.threads.botUnresolvedBlocking === 0;
  const isStale = (s: CommitStatusLike) =>
    nothingBlocking && reviewFeedbackAddressed && s.context === REVIEW_STATUS_CONTEXT;
```

- [ ] **Step 4: Split blockers from warnings in the render**

In `renderShipCheck`, replace the unresolved-threads warning (lines 76-78):

```ts
  if (unresolvedThreads > 0) {
    warnings.push(`${unresolvedThreads} unresolved review thread${unresolvedThreads === 1 ? "" : "s"}.`);
  }
```

with:

```ts
  // Blocking findings gate the merge; nitpicks are worth naming but not worth
  // blocking on. Splitting them is what keeps the verdict honest — three open
  // criticals used to render the same amber as three open nitpicks.
  const blockingThreads = threads.botUnresolvedBlocking;
  if (blockingThreads > 0) {
    blockers.push(`${blockingThreads} unresolved blocking finding${blockingThreads === 1 ? "" : "s"}.`);
  }
  const nonBlocking = unresolvedThreads - blockingThreads;
  if (nonBlocking > 0) {
    warnings.push(`${nonBlocking} unresolved review thread${nonBlocking === 1 ? "" : "s"}.`);
  }
```

and the threads table row (line 125):

```ts
  lines.push(
    `| Unresolved review threads | ${unresolvedThreads}${blockingThreads > 0 ? ` (${blockingThreads} blocking)` : ""} |`,
  );
```

- [ ] **Step 5: Make the ship command sync unconditionally**

In `src/reviewer.ts:2494-2499`, the sync currently runs only when a stale failure was detected. Since the sync now moves in both directions, it must run whenever a correction is possible:

```ts
          // Push the corrected verdict back to GitHub so the PR's check list
          // matches this comment — reporting a disagreement here while leaving
          // the check wrong is how `ship` ended up saying "3 unresolved
          // threads" next to a green check. Runs unconditionally now that the
          // sync can red a check as well as clear one; it no-ops when the
          // status already matches.
          const statusRefreshed = await this.syncReviewCommitStatus(
            installationId, owner, repo, pullNumber,
            { headSha: context.headSha, threads, gate: repoConfig.reviews?.thread_gate },
          );
```

`repoConfig` is not currently loaded in the `ship` case. Load it the same way the `rubber_duck` case does (`src/reviewer.ts:2545-2546`):

```ts
          const rawConfig = await loadRepoConfig(octokit, owner, repo, context.defaultBranch || "HEAD");
          const repoConfig = mergeWithDefaults(rawConfig);
```

Place it after the `octokit` binding at line 2470. If that adds a noticeable round trip, fold it into the existing `Promise.all` at line 2473 instead — but keep it after `getPRContext`, which supplies `defaultBranch`.

- [ ] **Step 6: Surface the count in the sticky status**

In `src/sticky-status.ts`, add to the options type:

```ts
  unresolvedThreads: number;
  /** Subset of `unresolvedThreads` that gates the commit status. */
  blockingThreads?: number;
```

and change the row at line 47:

```ts
  lines.push(
    `| **Unresolved threads** | ${opts.unresolvedThreads}${opts.blockingThreads ? ` (${opts.blockingThreads} blocking)` : ""} |`,
  );
```

Then pass it at the `renderStickyStatus` call site in `src/reviewer.ts` (find with `grep -n "renderStickyStatus" src/reviewer.ts`), adding `blockingThreads: <summary>.botUnresolvedBlocking` alongside the existing `unresolvedThreads` argument, using whatever thread summary that call site already has in scope.

- [ ] **Step 7: Run the full unit suite and typecheck**

Run: `npx vitest run tests/unit/ && npm run build:server && npm run lint`
Expected: PASS, clean `tsc`, no lint errors.

- [ ] **Step 8: Commit**

```bash
git add src/ship-check.ts src/reviewer.ts src/sticky-status.ts tests/unit/ship-check.test.ts
git commit -m "feat(ship): block on unresolved blocking findings, warn on nitpicks"
```

---

### Task 8: Documentation

**Files:**
- Modify: `README.md` (config reference), `CHANGELOG.md`
- Test: none (docs only) — verified by reading

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Document the config key**

Find the `reviews:` config reference block in `README.md`:

```bash
grep -n "commit_status" README.md
```

Add `thread_gate` next to `commit_status`, in whatever format that block already uses (YAML sample and/or table). The text:

> `thread_gate` — `blocking` (default) or `off`. When `blocking`, the `DiffSentry` check fails while any `critical` or `major` review thread is unresolved, and clears itself once they are resolved. Nitpicks (`minor`, `trivial`) never block. Review threads posted before this feature shipped carry no severity marker and count as blocking.

The CHANGELOG uses Keep a Changelog with an `## [Unreleased]` section and no
version number yet, so refer to "before this feature shipped" rather than a
version.

- [ ] **Step 2: Note the behaviour change in the CHANGELOG**

Add to the top (Unreleased) section of `CHANGELOG.md`, matching the surrounding entry style:

```markdown
### Fixed
- The `DiffSentry` check no longer flips to passing when a branch-update merge
  commit produces an empty diff. The status is re-derived from the PR's live
  review threads instead of assuming green.
- `@diffsentry ship` can now correct a check in either direction. Previously it
  could only clear a stale failure, so it reported unresolved threads next to a
  passing check.

### Changed
- Unresolved `critical` / `major` DiffSentry review threads now fail the
  `DiffSentry` commit status, regardless of the review verdict. `minor` and
  `trivial` findings never block. Opt out with `reviews.thread_gate: off`.
- **Breaking for existing PRs:** review threads posted before this release carry
  no severity marker and are treated as blocking, so open PRs with unresolved
  DiffSentry threads will go red on their next event.
- DiffSentry now reacts to `pull_request_review_thread` `unresolved` events, not
  just `resolved`.
```

- [ ] **Step 3: Verify the docs match the code**

Re-read both edits against `resolveReviewStatus` and the `thread_gate` schema entry. The default, the severity split, and the legacy-thread rule must all agree.

- [ ] **Step 4: Commit**

```bash
git add README.md CHANGELOG.md
git commit -m "docs: document reviews.thread_gate and the check-status behaviour change"
```

---

### Task 9: Full verification

**Files:** none

- [ ] **Step 1: Full test suite**

Run: `npm test`
Expected: all suites pass. If a pre-existing failure appears that this branch did not cause, confirm it against `git stash` + `npm test` on the base commit before dismissing it.

- [ ] **Step 2: Typecheck and lint**

Run: `npm run build:server && npm run lint`
Expected: clean `tsc`, no lint errors.

- [ ] **Step 3: Confirm no stale references remain**

Run:

```bash
grep -rn "refreshReviewCommitStatus" src/ tests/ docs/
grep -rn "botUnresolved: 0" src/ tests/ | grep -v botUnresolvedBlocking
```

Expected: the first returns nothing. The second returns only lines that also set `botUnresolvedBlocking` — any bare literal is a missed site.

- [ ] **Step 4: Confirm the reported bug is covered**

Run: `npx vitest run tests/unit/review-status.test.ts tests/unit/status-sync.test.ts tests/unit/ship-check.test.ts -t "blocking"`
Expected: the blocking-path tests pass — specifically that an empty diff with open blocking threads yields `failure`, and that `ship` reds a green check.
