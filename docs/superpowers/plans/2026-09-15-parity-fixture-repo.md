# Parity Fixture Repo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a synthetic-with-realistic-bones repository and a ten-PR series designed so that each PR provokes a specific CodeRabbit surface, ready to push the moment the operator starts a trial.

**Architecture:** The fixture lives entirely inside `tests/e2e/reference/2026-09/fixture-repo/` — a path `.github/codeql/codeql-config.yml` already excludes as "deliberately-fake input". The seed is a working HTTP service whose own tests pass on a clean clone. Each PR is data: a directory of complete file contents plus a metadata record, applied in order by a script that opens the PRs via `gh`. Nothing here is imported by DiffSentry's own source, and the fixture's dependencies are never installed in this repo.

**Tech Stack:** TypeScript and Python for the fixture's own code (never compiled or run by this repo's build), vitest for the validation test, tsx for the apply script, `gh` CLI. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-15-coderabbit-parity-capture-design.md`

## Global Constraints

- **The fixture is inert to this repo.** Its `package.json` is never installed; its code is never imported by `src/`; `tsc` must not compile it.
- **Planted credentials must be provably non-functional** — a well-known documentation value such as AWS's published `AKIAIOSFODNN7EXAMPLE`, never a live or revoked real key.
- **The vulnerable dependency is pinned only in the fixture's own `package.json`.** Never in this repo's `package.json` or lockfile — otherwise DiffSentry's own Dependabot starts reporting a vulnerability we planted.
- **The seed's tests must pass on a clean clone.** A seed that starts red makes PR #7's deliberate CI failure meaningless.
- **No new dependencies** in this repo.

---

### Task 1: Seed service

**Files:**
- Create: `tests/e2e/reference/2026-09/fixture-repo/package.json`, `tsconfig.json`, `README.md`
- Create: `tests/e2e/reference/2026-09/fixture-repo/src/{config,router,store,worker,index}.ts`
- Create: `tests/e2e/reference/2026-09/fixture-repo/test/store.test.ts`, `test/router.test.ts`

**Interfaces:**
- Produces: a `reports` HTTP service — `createRouter(store: Store)`, `class Store { list(ownerId: string): Report[]; insert(r: NewReport): Report }`, `loadConfig(env): Config`, `runWorker(store, clock)`.

"Realistic bones" is the constraint: a router, a persistence layer, a background worker, config loading, and a passing test suite. Written for this purpose rather than copied, so no foreign licence or commit history is inherited. Keep it small — roughly 300 lines across five files — but genuinely working.

- [ ] **Step 1: Write the seed's failing tests first**

```ts
// test/store.test.ts
import { describe, it, expect } from "vitest";
import { Store } from "../src/store.js";

describe("Store", () => {
  it("returns only the requesting owner's reports", () => {
    const s = new Store();
    s.insert({ ownerId: "a", title: "one", body: "x" });
    s.insert({ ownerId: "b", title: "two", body: "y" });
    expect(s.list("a").map((r) => r.title)).toEqual(["one"]);
  });

  it("assigns a monotonic id", () => {
    const s = new Store();
    const first = s.insert({ ownerId: "a", title: "one", body: "x" });
    const second = s.insert({ ownerId: "a", title: "two", body: "y" });
    expect(second.id).toBeGreaterThan(first.id);
  });

  it("returns an empty list for an unknown owner", () => {
    expect(new Store().list("nobody")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd tests/e2e/reference/2026-09/fixture-repo && npx vitest run`
Expected: FAIL — `src/store.js` does not resolve.

- [ ] **Step 3: Implement the seed**

`src/store.ts` in full — it is what the tests above pin:

```ts
export type NewReport = { ownerId: string; title: string; body: string };
export type Report = NewReport & { id: number; createdAt: number };

/** In-memory store. Owner scoping lives here so the router cannot forget it. */
export class Store {
  private rows: Report[] = [];
  private nextId = 1;

  list(ownerId: string): Report[] {
    return this.rows.filter((r) => r.ownerId === ownerId);
  }

  insert(r: NewReport): Report {
    const row: Report = { ...r, id: this.nextId++, createdAt: Date.now() };
    this.rows.push(row);
    return row;
  }

  prune(olderThanMs: number, now: number): number {
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => now - r.createdAt < olderThanMs);
    return before - this.rows.length;
  }
}
```

The remaining four files follow the same standard, each small and each honest:

- `src/config.ts` — `loadConfig(env: NodeJS.ProcessEnv): Config` returning `{ port: number; logLevel: string; retentionMs: number }`, with defaults `3000`, `"info"`, seven days.
- `src/router.ts` — `createRouter(store: Store)` serving `GET /reports` (owner from the `x-owner-id` header, 400 when absent) and `POST /reports` (validates `title` and `body` are non-empty strings, 201 with the created row).
- `src/worker.ts` — `runWorker(store: Store, now: () => number, retentionMs: number): number` calling `store.prune`, taking the clock as a parameter so it is testable without waiting.
- `src/index.ts` — wires config, store, router and a worker interval; no logic of its own.

Every file is clean, idiomatic code. **The planted problems arrive in the PR series, never in the seed** — a seed that starts dirty makes the PRs unreadable and PR #7's deliberate CI failure meaningless.

- [ ] **Step 4: Run to verify they pass**

Run: `cd tests/e2e/reference/2026-09/fixture-repo && npx vitest run`
Expected: PASS. This green baseline is what PR #7 will deliberately break.

- [ ] **Step 5: Commit**

```bash
git add tests/e2e/reference/2026-09/fixture-repo
git commit -m "feat(fixture): seed a working reports service"
```

---

### Task 2: Python worker and non-code surfaces

**Files:**
- Create: `fixture-repo/ingest/{worker.py,requirements.txt}`, `ingest/test_worker.py`
- Create: `fixture-repo/.github/workflows/ci.yml`
- Create: `fixture-repo/openapi.yaml`
- Create: `fixture-repo/docs/getting-started.md`

These exist so the PR series can exercise the language-agnostic review path and the brief's P1.2 tooling-pack surfaces. All four are clean at seed time.

- [ ] **Step 1: Write the Python worker and its test**

A small polling ingester with a `poll_once(source, sink)` function and a pytest covering the empty-source and single-item cases. Idiomatic, correct, no planted problems.

- [ ] **Step 2: Write the workflow, spec and doc**

`ci.yml` runs the TS and Python suites, with **actions pinned to full commit SHAs** — the seed is correct so that PR #3 can introduce the unpinned refs. `openapi.yaml` describes the two `/reports` endpoints. `docs/getting-started.md` is clear prose, so PR #5's style regressions are visible against it.

- [ ] **Step 3: Verify the Python test passes**

Run: `cd tests/e2e/reference/2026-09/fixture-repo/ingest && python3 -m pytest -q`
Expected: PASS. If pytest is unavailable, record that in the fixture README as an operator prerequisite rather than skipping the test.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/reference/2026-09/fixture-repo
git commit -m "feat(fixture): add python worker, workflow, openapi spec and docs"
```

---

### Task 3: PR series definitions

**Files:**
- Create: `fixture-repo/pr-series/NN-<slug>/files/**` (complete file contents)
- Create: `fixture-repo/pr-series/NN-<slug>/pr.json` (`{ title, body, base, branch, expects }`)
- Create: `fixture-repo/pr-series/README.md`
- Create: `src/parity/fixture.ts`, `tests/unit/parity-fixture.test.ts`

**Interfaces:**
- Produces: `type PrDef = { dir: string; title: string; body: string; base: string; branch: string; expects: string[] }`; `loadPrSeries(root: string): PrDef[]`; `validatePrSeries(defs: PrDef[]): string[]` (returns problems, empty when valid).

Each PR is data, not a patch file — a directory of complete file contents avoids a nested git repo and stays readable in review. `expects` names the surfaces the PR is designed to provoke, so Phase D can check whether each actually fired.

The ten PRs are those tabulated in the spec. Planted problems by PR: #1 an injection sink, absent input validation and an N+1 query; #3 unpinned action refs and `pull_request_target` misuse; #4 a removed required response field; #5 passive-voice and inconsistent-terminology regressions; #6 a check-then-act race and a bare `except:`; #7 an assertion change that makes the seed's suite fail; #8 a branch editing the same lines as #1, opened after #1 merges.

- [ ] **Step 1: Write the failing validation test**

```ts
import { describe, it, expect } from "vitest";
import { validatePrSeries, type PrDef } from "../../src/parity/fixture.js";

function def(over: Partial<PrDef> = {}): PrDef {
  return { dir: "01-a", title: "feat: a", body: "why", base: "main", branch: "feat/a", expects: ["walkthrough"], ...over };
}

describe("validatePrSeries", () => {
  it("accepts a well-formed series", () => {
    expect(validatePrSeries([def(), def({ dir: "02-b", branch: "fix/b" })])).toEqual([]);
  });

  it("rejects a duplicate branch name", () => {
    expect(validatePrSeries([def(), def({ dir: "02-b" })]).join()).toMatch(/duplicate branch/i);
  });

  it("rejects an empty body, which would trip the description pre-merge check", () => {
    expect(validatePrSeries([def({ body: "" })]).join()).toMatch(/body/i);
  });

  it("rejects a PR that declares no expected surface", () => {
    expect(validatePrSeries([def({ expects: [] })]).join()).toMatch(/expects/i);
  });

  it("rejects a title ending in a period, which the repo's title check warns on", () => {
    expect(validatePrSeries([def({ title: "feat: a." })]).join()).toMatch(/title/i);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/parity-fixture.test.ts`
Expected: FAIL — cannot resolve `src/parity/fixture.js`.

- [ ] **Step 3: Implement the loader and validator**

```ts
import fs from "node:fs";
import path from "node:path";

export type PrDef = {
  dir: string; title: string; body: string; base: string; branch: string; expects: string[];
};

export function loadPrSeries(root: string): PrDef[] {
  return fs.readdirSync(root)
    .filter((d) => /^\d\d-/.test(d))
    .sort()
    .map((d) => ({ dir: d, ...JSON.parse(fs.readFileSync(path.join(root, d, "pr.json"), "utf8")) as Omit<PrDef, "dir"> }));
}

/** Returns human-readable problems; an empty array means the series is valid. */
export function validatePrSeries(defs: PrDef[]): string[] {
  const problems: string[] = [];
  const branches = new Set<string>();
  for (const d of defs) {
    if (branches.has(d.branch)) problems.push(`${d.dir}: duplicate branch ${d.branch}`);
    branches.add(d.branch);
    if (!d.body.trim()) problems.push(`${d.dir}: empty body — the description pre-merge check needs a WHAT and a WHY`);
    if (d.expects.length === 0) problems.push(`${d.dir}: expects is empty — every PR must name the surface it provokes`);
    if (!d.title.trim()) problems.push(`${d.dir}: empty title`);
    else if (d.title.trim().endsWith(".")) problems.push(`${d.dir}: title ends in a period`);
    else if (d.title.length > 72) problems.push(`${d.dir}: title over 72 chars`);
  }
  return problems;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/unit/parity-fixture.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Author the ten PR directories**

Each gets `pr.json` and a `files/` tree. Write a real, reviewable change per PR — the planted problem rides inside a change that has an honest reason to exist.

- [ ] **Step 6: Validate the authored series**

```bash
npx tsx -e "import {loadPrSeries,validatePrSeries} from './src/parity/fixture.js'; const p=validatePrSeries(loadPrSeries('tests/e2e/reference/2026-09/fixture-repo/pr-series')); console.log(p.length?p:'valid'); process.exitCode=p.length?1:0"
```

Expected: prints `valid`.

- [ ] **Step 7: Commit**

```bash
git add tests/e2e/reference/2026-09/fixture-repo/pr-series src/parity/fixture.ts tests/unit/parity-fixture.test.ts
git commit -m "feat(fixture): define the ten-PR capture series"
```

---

### Task 4: PR-opening script

**Files:**
- Create: `scripts/fixture-open-pr.ts`
- Modify: `package.json` (scripts section only)

Opens one PR at a time, on purpose: Phase D captures each bot's response before the next lands, and PR #8 must not be opened until #1 has merged.

- [ ] **Step 1: Write the script**

Takes `--repo owner/name` and `--pr NN`. Verifies the working tree is clean, creates the branch from `base`, copies `files/` over the checkout, commits with the PR title, pushes, and opens the PR via `gh pr create` with the body from `pr.json`. Refuses to run against any repository whose name is not the operator-supplied fixture repo, so it can never push into DiffSentry itself.

- [ ] **Step 2: Add the npm script**

```json
"fixture:open": "tsx scripts/fixture-open-pr.ts",
```

- [ ] **Step 3: Verify it typechecks**

Run: `npm run build:server`
Expected: exit 0.

- [ ] **Step 4: Verify the guard rejects a wrong target**

```bash
npx tsx scripts/fixture-open-pr.ts --repo mk7luke/DiffSentry --pr 01 || echo "correctly refused"
```

Expected: refuses, because the target is not the fixture repo. This guard is the reason the script is safe to hand to an operator.

- [ ] **Step 5: Commit**

```bash
git add scripts/fixture-open-pr.ts package.json
git commit -m "feat(fixture): add guarded PR-opening script"
```

---

### Task 5: Isolation guards

**Files:**
- Modify: `.diffsentry.yaml` (`reviews.path_filters`)
- Modify: `.gitignore`
- Create: `tests/unit/parity-fixture-isolation.test.ts`

- [ ] **Step 1: Write the failing isolation test**

```ts
import { describe, it, expect } from "vitest";
import fs from "node:fs";

const ROOT = "tests/e2e/reference/2026-09/fixture-repo";

describe("fixture isolation", () => {
  it("keeps the fixture's dependencies out of this repo's manifest", () => {
    const fixture = JSON.parse(fs.readFileSync(`${ROOT}/package.json`, "utf8"));
    const ours = JSON.parse(fs.readFileSync("package.json", "utf8"));
    const mine = new Set([...Object.keys(ours.dependencies ?? {}), ...Object.keys(ours.devDependencies ?? {})]);
    for (const dep of Object.keys(fixture.dependencies ?? {})) {
      expect(mine.has(dep), `${dep} must not be a dependency of DiffSentry`).toBe(false);
    }
  });

  it("is excluded from DiffSentry's own review", () => {
    const cfg = fs.readFileSync(".diffsentry.yaml", "utf8");
    expect(cfg).toContain("!tests/e2e/reference/**");
  });

  it("never installed the fixture's dependencies", () => {
    expect(fs.existsSync(`${ROOT}/node_modules`)).toBe(false);
  });

  it("plants only a documented, non-functional credential", () => {
    const planted = fs.readFileSync(`${ROOT}/pr-series/README.md`, "utf8");
    expect(planted).toContain("AKIAIOSFODNN7EXAMPLE");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/parity-fixture-isolation.test.ts`
Expected: FAIL on the `.diffsentry.yaml` assertion.

- [ ] **Step 3: Add the exclusion and the ignore**

Add `- "!tests/e2e/reference/**"` to `reviews.path_filters` in `.diffsentry.yaml`, with a comment saying why. Add `tests/e2e/reference/2026-09/fixture-repo/node_modules/` to `.gitignore`.

Note in the config comment: this repo loads `.diffsentry.yaml` from the **default branch**, so the exclusion does not suppress findings on the PR that introduces it. DiffSentry is expected to flag the planted fixtures on that PR, and those findings are expected noise.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/unit/parity-fixture-isolation.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add .diffsentry.yaml .gitignore tests/unit/parity-fixture-isolation.test.ts
git commit -m "chore(fixture): isolate planted fixtures from this repo's tooling"
```

---

### Task 6: Operator runbook and verification

**Files:**
- Create: `docs/parity/trial-runbook.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Write the runbook**

The operator-facing sequence for Phase D, stating plainly what only they can do: create the public repository, sign up at coderabbit.ai with GitHub, start the 14-day trial (no credit card required) on the **highest tier offered**, and install on that repository only.

Record why the tier matters — Team gates finishing touches and merge-conflict resolution, Advanced gates security review, and the free tier shows neither — and that DiffSentry stays installed, because `src/webhook/dispatch.ts` ignores `user.type === "Bot"` so the two bots cannot feed each other.

Give the capture order: Team- and Advanced-gated surfaces first, since those are what expire.

- [ ] **Step 2: Update the changelog**

Add the fixture repo and runbook under `[Unreleased]`.

- [ ] **Step 3: Full verification**

```bash
npm run lint
npm run build:server
npx vitest run 2>&1 | tail -5
```

Expected: all exit 0. Confirm `tsc` did not compile the fixture — `tsconfig.json`'s include must not reach `tests/e2e/reference/`. If it does, exclude it explicitly and note the change.

- [ ] **Step 4: Confirm nothing leaked into this repo**

```bash
git diff --stat main... -- package.json package-lock.json
```

Expected: `package.json` shows only added `scripts` entries; `package-lock.json` unchanged.

- [ ] **Step 5: Commit**

```bash
git add docs/parity/trial-runbook.md CHANGELOG.md
git commit -m "docs(parity): add the trial runbook for phase D"
```
