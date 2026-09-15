# DiffSentry ↔ CodeRabbit parity brief

**Audience:** Claude Code / Cursor worktree sessions implementing DiffSentry improvements  
**Repo:** https://github.com/mk7luke/DiffSentry  
**As of:** 2026-09-14  
**Sources:** DiffSentry `main` (local clone), CodeRabbit docs changelog + product blog (Agentic Change Management, Security, CLI, Finishing Touches)

Use this as the standing gap map. Prefer implementing one workstream per worktree. Do not treat marketing copy as a feature inventory — verify against `src/` and CodeRabbit docs before claiming parity.

---

## 0. Positioning (read this first)

DiffSentry is already strong on the **classic CodeRabbit PR comment shape** (walkthrough, inline findings, review summary, sticky status, finishing-touch checkboxes, learnings, issue triage) **plus** self-host / own-model advantages and a deep analytics dashboard that CodeRabbit’s SaaS does not fully mirror.

CodeRabbit has moved past “AI PR comments” into **Agentic Change Management**: Triage, Change Stack, and Security, plus a large **CLI / IDE / multi-platform / sandbox remediation** surface. That is where DiffSentry is furthest behind.

**DiffSentry advantages to preserve (do not break while chasing parity):**
- Self-hosted; Anthropic / OpenAI / any OpenAI-compatible + local (Ollama, LM Studio, vLLM, llama.cpp)
- Built-in command-center SPA (cost, ops console, findings triage, pattern analytics, leaderboard)
- Risk score + coverage + dependency-change signals on every walkthrough
- Pre-AI zero-cost safety scanners + custom `anti_patterns`
- Socratic chat commands (`rubber-duck`, `5why`, `ship`, `tour`, …)
- Institutional memory (`@bot learn` + prior-discussion collapses)

**Hard constraint for FOSS self-host:** prefer designs that work without CodeRabbit Cloud (no mandatory SaaS). Sandbox, CLI, and Security should run on the operator’s machine / cluster.

---

## 1. Current DiffSentry inventory (verified)

### Comment / review UX
| Capability | Status | Evidence |
|---|---|---|
| Walkthrough (cohorts, sequence diagrams, effort) | ✅ | `src/walkthrough.ts`, README |
| Inline comments + severity headers + AI-agent prompts | ✅ | `src/ai/parse.ts`, `src/reviewer.ts` |
| Review summary (actionable count, nitpicks, review info) | ✅ | `src/review-body.ts` |
| Sticky status comment + risk sparkline | ✅ | `src/sticky-status.ts` |
| Incremental review + internal state blob | ✅ | `src/walkthrough-state.ts` |
| Finishing Touches checkboxes (tests / docs / simplify / autofix) | ✅ partial | `src/finishing-touches.ts` — commits via GitHub Contents API to **current branch**; no sandbox, no stacked-PR path |
| Chat commands + slash aliases | ✅ | `src/commands.ts`, `src/slash-commands.ts` |
| Issue auto-triage + `@bot plan` | ✅ | `src/issue-commands.ts`, `src/issues.ts` |
| Pre-merge checks section | ✅ | `src/pre-merge.ts` |
| Path instructions | ✅ | `reviews.path_instructions` in schema / prompts |
| In-repo guidelines (AGENTS.md, .cursor/rules, …) | ✅ | `src/guidelines.ts` |
| Code graph context (optional) | ✅ | `src/graph-context.ts` (`.code-review-graph/graph.db`) |
| Opt-in static analysis | ✅ limited | `src/static-analysis.ts` — **eslint / tsc / semgrep only**, needs checkout dir |
| Dashboard + Platform API | ✅ | `web/`, `src/api/`, `src/dashboard/` |
| GitHub App webhooks | ✅ | `src/webhook/` |
| GitLab / Bitbucket / Azure DevOps | ❌ | no matches in `src/` |
| Local review CLI (pre-push / agent JSON) | ❌ | `src/cli/` is **backfill only** |
| IDE plugins | ❌ | — |

### Autofix reality check
`autofix` / `generateTests` / `simplify` / `generateDocstrings` ask the model for a JSON array of `{path, content}` and push via `repos.createOrUpdateFileContents` onto the PR head branch (`src/finishing-touches.ts`). That is **not** CodeRabbit’s sandbox + stacked-PR remediation model.

### Format rubric already in-repo
`tests/e2e/reference/CODERABBIT-FORMAT.md` — use this when changing comment shape. Do not invent a second format doc; extend this one.

---

## 2. CodeRabbit capabilities DiffSentry lacks (priority ranked)

Priority = impact on “feels like CodeRabbit parity for teams using agents heavily” × feasibility for a self-hosted FOSS bot.

### P0 — Product-defining gaps (do these first)

#### P0.1 Sandbox finishing touches + Fix CI + Resolve merge conflicts
**CodeRabbit:** `@coderabbitai fix-ci`, resolve merge conflicts, autofix / simplify / generate tests run in a sandbox; deliver as **commit on current branch** *or* **stacked PR**; Fix CI checkbox in Finishing Touches when checks fail.  
**DiffSentry:** Finishing touches exist but are Contents-API commits only; **no Fix CI**; **no merge-conflict resolver**.  
**Worktree goal:**
1. Introduce a pluggable **sandbox runner** (Docker on the DiffSentry host is the natural self-host fit).
2. Clone PR head → apply agent edits → run tests (optional) → open stacked PR *or* push commit.
3. Add `@bot fix-ci` + walkthrough checkbox when failing checks detected (reuse `checks-state.ts`).
4. Add `@bot resolve merge conflict` with hard refuse on auth/crypto/ACL ambiguity (match CR safety stance).
5. Extend Autofix checkbox: “Push commit” vs “Open stacked PR”.

**Acceptance:** E2E on sandbox repo: failing CI → `@bot fix-ci` opens stacked PR with green-intent fix; autofix can choose stacked delivery; merge-conflict path commits a merge or declines with reason.

**Key files:** `src/finishing-touches.ts`, `src/reviewer.ts`, `src/checks-state.ts`, `src/commands.ts`, webhook `check_suite` / `status` handlers.

#### P0.2 Local review CLI + coding-agent skills
**CodeRabbit:** `coderabbit review` (committed/staged/unstaged), `--agent` JSON, `coderabbit skills` for Claude Code / Cursor / Codex / Copilot, doctor/usage/auth.  
**DiffSentry:** no local review CLI.  
**Worktree goal:**
1. `diffsentry review` CLI that reviews local git diff against the same prompt/pipeline core as PR reviews (share `src/ai/` + scanners; do not duplicate).
2. `--agent` structured JSON for Claude Code / Cursor loops.
3. Ship a `skills/` (or Agent Skills) package: “review my changes with DiffSentry”, “fix until clean”.
4. Optional: talk to a running DiffSentry instance **or** run fully offline against local models via existing provider factory.

**Acceptance:** From a dirty worktree, `npx diffsentry review --agent` returns findings Claude Code can apply; skill installs with one command documented in README.

**Key files:** new `packages/cli` or `src/cli/review.ts`; reuse `src/safety-scanner.ts`, `src/ai/prompt.ts`, `src/ai/parse.ts`.

#### P0.3 Change Stack–class explainability (self-hosted)
**CodeRabbit:** Change Stack UI — cohorts/layers, range summaries, architecture impact, security blast radius, code peek, semantic diff; opened from walkthrough button.  
**DiffSentry:** cohort table + sequence diagrams in Markdown only; dashboard PR detail is snapshot/findings, not a guided layer walkthrough.  
**Worktree goal (FOSS-shaped):**
1. Persist structured **change layers** (reuse walkthrough cohorts; add ordered layers with file+line ranges + per-range summary) in DB / walkthrough state.
2. SPA route `/prs/:id/stack` (or embed in PR detail) that walks layers, shows diffs per layer, links back to GitHub comments.
3. Optional “Architecture impact” view fed by `graph-context.ts` (callers/callees, high fan-in).
4. Walkthrough link: `Review Change Stack →` pointing at the self-hosted UI (not a SaaS app).

**Acceptance:** Large multi-file PR opens a stack view ordered by dependency/intent, not alphabetical files; deep-link from walkthrough works without GitHub auth beyond existing dashboard OAuth.

**Key files:** `src/walkthrough.ts`, `src/graph-context.ts`, `web/` SPA, `src/api/pr-diff.ts`.

#### P0.4 Continuous Security (beyond PR diff + secret regex)
**CodeRabbit Security:** on-demand/scheduled full-repo AI Deep Scan; secrets with Verified Active/Inactive/Unknown; dependency CVEs; attack surface map; reachability/exploitability; agent-ready share Markdown; Fix with AI PRs.  
**DiffSentry:** PR-time secret regex + heuristics; opt-in eslint/tsc/semgrep on checkout; dashboard findings from reviews — **no standing codebase scanner**.  
**Worktree goal:**
1. `diffsentry security scan` (CLI + dashboard job) over default branch: secrets (history opt-in), dependency advisories (`npm audit` / OSV), optional Semgrep pack, optional LLM pass for business-logic sinks with evidence.
2. Store findings with status (open / ignored / fixed), reachability tier when graph available.
3. “Share for agents” Markdown export (no app URL required).
4. “Fix with AI” → stacked PR via sandbox runner (depends on P0.1).

**Acceptance:** Scheduled scan produces dashboard findings independent of open PRs; SARIF/CSV export; one click opens fix PR for a supported finding class.

**Key files:** new `src/security/`, `src/dep-scanner.ts` (extend), `src/secret-patterns.ts`, dashboard findings pages.

### P1 — High leverage for “parity” perception

#### P1.1 Multi-repo / cross-repo context
**CodeRabbit:** Multi-Repo Analysis, automatic linking modes, cross-repo Code Guidelines (`repo:path`), branch selection via PR description.  
**DiffSentry:** single-repo review; `@bot diff <PR#>` compares two PRs in same install context; guidelines are same-repo only.  
**Goal:** config `knowledge_base.linked_repositories` + optional auto-link heuristics; pull guideline files from a central standards repo; include cross-repo API breakage hints when linked.

#### P1.2 Tooling pack expansion
**CodeRabbit:** Vale, React Doctor, SkillSpector, zizmor (Actions), Infer, oasdiff, Verilator, Presidio (opt-in), Betterleaks, ast-grep breadth, e18e ESLint plugin, …  
**DiffSentry:** eslint / tsc / semgrep only.  
**Goal:** extend `static-analysis.ts` plugin interface; add Vale (prose), zizmor (workflows), oasdiff (OpenAPI), SkillSpector (agent skill / MCP config) as first FOSS-relevant pack. Keep default-off or smart-detect like today.

#### P1.3 Post-merge actions
**CodeRabbit:** up to 5 natural-language post-merge actions; checkboxes in walkthrough; skip commands; code-changing actions → follow-up PR.  
**DiffSentry:** auto release-notes on green PR (narrow).  
**Goal:** `reviews.post_merge_actions[]` with sandbox execution + result comment.

#### P1.4 Custom finishing-touch recipes
**CodeRabbit:** `reviews.finishing_touches.custom` named recipes, `@bot run 'name'`.  
**DiffSentry:** fixed four recipes.  
**Goal:** YAML-defined recipes executed through sandbox runner.

#### P1.5 Quiet review profile + richer profiles
**CodeRabbit:** `quiet` | `chill` | `assertive`.  
**DiffSentry:** assertive default; chill exists in CR-format docs — confirm schema and add `quiet` (inline only critical/major high-impact; rest collapsed).

#### P1.6 Slop detection (public / OSS maintainer mode)
**CodeRabbit:** flags low-quality AI PRs; optional label.  
**Goal:** heuristic + model classifier on first full review; walkthrough warning + optional label. Especially valuable if DiffSentry is used on public repos.

#### P1.7 Review progress as Check Runs
**CodeRabbit:** progress reports / check runs by default; legacy commit status opt-in.  
**DiffSentry:** commit status + sticky comment.  
**Goal:** emit GitHub Check Run with steps (queued → reviewing → posting) for clearer UX in the Checks UI.

### P2 — Platform & ecosystem (large, schedule deliberately)

| Gap | Notes |
|---|---|
| GitLab / Bitbucket / Azure DevOps | CodeRabbit is multi-forge; DiffSentry is GitHub-App-shaped. Abstract `ForgeClient` before adding a second forge. |
| IDE extension (VS Code) | Depends on CLI `--agent` output stability (P0.2). |
| MCP tool calling during review | CodeRabbit pulls Jira/Linear/Notion/Sentry context; DiffSentry could add optional MCP client for self-hosted operators. |
| Slack/Discord Agent | Lower priority for core FOSS reviewer; nice-to-have after CLI + Security. |
| Org config inheritance / global overrides | Useful once multi-repo orgs adopt DiffSentry heavily. |
| Learning approval delay | Admin queue before learnings apply. |
| Attack-surface map UI | Belongs with P0.4 Security. |
| Triage queue (cross-repo “what to review next”) | CodeRabbit Triage; DiffSentry dashboard has pipeline board + findings — extend into a reviewer-first queue with risk/value ranking (can partially ship without full CR Triage). |

### P3 — Comment-shape polish (use existing rubric)
Extend `tests/e2e/reference/CODERABBIT-FORMAT.md` and e2e harness for any remaining deltas:
- Poem / share footer (optional, brand-dependent)
- Analysis-chain collapses (only if sandbox shell verification exists)
- Committable `suggestion` blocks where a single-hunk fix maps cleanly
- Applied guidelines sources listed in Review info (which files/rules fired)
- Autofix command scope: inline thread vs whole PR (CR recently split these)

---

## 3. Suggested worktree plan (implementation order)

| Wave | Worktree name | Delivers | Depends on |
|---|---|---|---|
| 1 | `wt/sandbox-finishing-touches` | Sandbox runner + stacked PR + Fix CI + merge-conflict | — |
| 2 | `wt/cli-review-skills` | `diffsentry review` + `--agent` + Claude/Cursor skill | share review core; sandbox optional |
| 3 | `wt/change-stack-spa` | Layer persistence + SPA Change Stack + walkthrough link | graph-context nice-to-have |
| 4 | `wt/security-agent` | Scheduled/on-demand repo scan + exports + Fix with AI | Wave 1 sandbox |
| 5 | `wt/tools-vale-zizmor-oasdiff` | Static-analysis plugin pack | checkout dir story |
| 6 | `wt/multi-repo-guidelines` | Linked repos + central guidelines | — |
| 7 | `wt/post-merge-and-recipes` | Post-merge actions + custom recipes | Wave 1 |
| 8 | `wt/forge-abstraction` | `ForgeClient` + GitLab MVP | stable review core |

Each worktree PR should:
1. Update `CHANGELOG.md` under `[Unreleased]`
2. Add/extend unit tests + at least one `tests/e2e` scenario when behavior is user-visible on GitHub
3. Update README only for user-facing commands/config (avoid second comparison table sprawl)
4. Keep MIT / self-host story honest — no fake “Cloud-only” dependencies

---

## 4. Claude Code session prompt (copy-paste)

```text
You are working in the DiffSentry repo (https://github.com/mk7luke/DiffSentry).

Read docs/parity/CodeRabbit-parity-brief.md (or the brief in this prompt) and implement ONLY the assigned workstream below. Do not boil the ocean.

Constraints:
- Self-hosted FOSS: features must work without CodeRabbit Cloud.
- Reuse existing review/AI/scanner pipelines; do not fork a second reviewer.
- Match CodeRabbit comment shape via tests/e2e/reference/CODERABBIT-FORMAT.md when touching PR comments.
- Prefer Docker sandbox on the DiffSentry host for any code-mutating agent work.
- Update CHANGELOG.md; add tests; keep types strict (tsc).

Assigned workstream: <P0.x / name>
Acceptance criteria: <paste from brief>
Out of scope: <list neighboring waves>
```

---

## 5. Config / API seams to introduce early (avoid rewrite later)

Add these stubs even if behavior is minimal at first:

```yaml
# .diffsentry.yaml (proposed)
reviews:
  profile: assertive | chill | quiet
  finishing_touches:
    fix_ci:
      enabled: true
      delivery: stacked_pr | commit   # default stacked_pr
    resolve_merge_conflict:
      enabled: true
    custom: []    # { name, instructions }
  post_merge_actions: []  # { name, instructions, when }
  static_analysis:
    enabled: false
    analyzers: [eslint, tsc, semgrep]  # extend with vale, zizmor, …
  slop_detection:
    enabled: false
    label: slop

knowledge_base:
  linked_repositories: []   # owner/name
  code_guidelines:
    filePatterns: []        # support owner/repo:path later

security:
  scans:
    secrets: { enabled: true, git_history: false }
    dependencies: { enabled: true }
    semgrep: { enabled: false }
    ai_deep: { enabled: false }

sandbox:
  enabled: false
  runtime: docker
  image: diffsentry-sandbox:latest
  network: false
```

Mirror into `src/config-schema.ts` + `src/types.ts` in the first wave that needs each key.

---

## 6. What NOT to chase (yet)

- Feature-matching CodeRabbit’s 40+ SaaS connectors and marketing Agent Slack surface
- Pixel-perfect poem / social share footers
- Usage-based billing / seat rate-limit product (irrelevant to self-host)
- Enterprise audit-log SaaS APIs (add a simple self-host audit table only when admins ask)

---

## 7. Quick reference links

**DiffSentry**
- Repo: https://github.com/mk7luke/DiffSentry
- Format rubric: `tests/e2e/reference/CODERABBIT-FORMAT.md`
- Finishing touches: `src/finishing-touches.ts`
- Commands: `src/commands.ts`
- Static analysis: `src/static-analysis.ts`
- Graph context: `src/graph-context.ts`

**CodeRabbit (external)**
- Changelog: https://docs.coderabbit.ai/changelog
- Agentic Change Management: https://www.coderabbit.ai/blog/introducing-agentic-change-management
- Security: https://docs.coderabbit.ai/security
- Autofix: https://docs.coderabbit.ai/finishing-touches/autofix
- CLI: https://docs.coderabbit.ai/cli

---

## 8. One-line executive summary

DiffSentry has caught up on **PR comment theater** and pulled ahead on **self-host analytics + local models**; to stay credible against CodeRabbit in 2026 it needs **sandbox remediation (Fix CI / stacked autofix)**, a **local CLI + agent skills loop**, a **Change Stack explainability UI**, and a **post-merge Security scanner** — in that order.
