# Review summaries

## diffsentry[bot] · review-summary · 2026-08-22T06:55:51Z

- Source: https://github.com/mk7luke/DiffSentry/pull/146#pullrequestreview-4999415215
- Location: —

```markdown
<sub>🛡️ This DiffSentry review has been superseded by a newer one. Its findings, if still present, appear there.</sub>
```

---

## diffsentry[bot] · review-summary · 2026-08-22T06:59:44Z

- Source: https://github.com/mk7luke/DiffSentry/pull/146#pullrequestreview-4999429681
- Location: —

```markdown
**Actionable comments posted: 0**

The sanitizer migration correctly replaces the bypassable regex blacklist with parse-and-rebuild allowlisting, and the configured URL and attribute restrictions address the described XSS vectors. The accompanying regression and preservation tests cover the important dangerous schemes, raw HTML sinks, and supported markdown features. No actionable issues were found in the incremental changes.

<details>
<summary>🧹 Nitpick comments (1)</summary><blockquote>

<details>
<summary>tests/unit/markdown.test.ts (1)</summary><blockquote>

`Line 48`: **<img> without alt attribute**

_⚠️ Potential issue_ | _🟡 Minor_

**<img> without alt attribute**

Images without an `alt` attribute are invisible to screen readers and can fail accessibility audits.

**Suggested fix:** Add `alt=""` for purely decorative images, or a descriptive string for meaningful ones.

_DiffSentry built-in pattern check — disable globally with `reviews.builtin_patterns: false`._

<details>
<summary>🤖 Prompt for AI Agents</summary>

```text
Verify each finding against the current code and only fix it if needed.

In tests/unit/markdown.test.ts at line 48, the line matches the "<img> without alt attribute" anti-pattern. Add `alt=""` for purely decorative images, or a descriptive string for meaningful ones.
```

</details>

<!-- diffsentry-fingerprint:eaab56699dbb -->

<!-- diffsentry-severity:minor -->

<!-- This is an auto-generated reply by DiffSentry -->

<details>
<summary>🤖 Prompt for AI Agents</summary>

```text
Verify each finding against the current code and only fix it if needed.

In tests/unit/markdown.test.ts at line 48, the line matches the "<img> without alt attribute" anti-pattern. Add `alt=""` for purely decorative images, or a descriptive string for meaningful ones.
```

</details>

</blockquote></details>

</blockquote></details>

<details>
<summary>🤖 Prompt for all review comments with AI agents</summary>

```text
Verify each finding against the current code and only fix it if needed.

In `tests/unit/markdown.test.ts`:
- Line 48: In tests/unit/markdown.test.ts at line 48, the line matches the "<img> without alt attribute" anti-pattern. Add `alt=""` for purely decorative images, or a descriptive string for meaningful ones.
```

</details>

<details>
<summary>🪄 Autofix (Beta)</summary>

Fix all unresolved DiffSentry comments on this PR:

- [ ] <!-- {"checkboxId": "086e2ec5-51ad-4240-9116-ecd6ec2779c3"} --> Push a commit to this branch (recommended)
- [ ] <!-- {"checkboxId": "75e02af8-a87a-4603-ab75-fbd53dbb16fe"} --> Create a new PR with the fixes

</details>

---

<details>
<summary>ℹ️ Review info</summary>

<details>
<summary>⚙️ Run configuration</summary>

**Configuration used**: `.diffsentry.yaml`

**Review profile**: ASSERTIVE

**Run ID**: `651eeccf-e5b1-409d-8b73-c2e17d47d0dd`

</details>

<details>
<summary>📥 Commits</summary>

Reviewing files that changed from [`27aef17`](https://github.com/mk7luke/DiffSentry/commit/27aef1780b800822c3992055b69371dd2a04ab96) to [`c582ee7`](https://github.com/mk7luke/DiffSentry/commit/c582ee71dec2df59065445f0dd4bd3ad9ef15357). Previously-reviewed commits are not re-reviewed.

</details>

<details>
<summary>📒 Files selected for processing (2)</summary>

* `src/dashboard/markdown.ts`
* `tests/unit/markdown.test.ts`

</details>

<details>
<summary>✅ Files skipped from review due to trivial changes (2)</summary>

* `package.json`
* `web/src/lib/markdown.ts`

</details>
<details>
<summary>🚧 Files skipped from review as they are similar to previous changes (1)</summary>

* `CHANGELOG.md`

</details>

</details>

<!-- This is an auto-generated comment by DiffSentry for review status -->
```

---

## diffsentry[bot] · review-summary · 2026-08-22T07:04:03Z

- Source: https://github.com/mk7luke/DiffSentry/pull/146#pullrequestreview-4999445075
- Location: —

```markdown
<sub>🛡️ This DiffSentry review has been superseded by a newer one. Its findings, if still present, appear there.</sub>
```

---

## diffsentry[bot] · review-summary · 2026-08-22T08:19:18Z

- Source: https://github.com/mk7luke/DiffSentry/pull/146#pullrequestreview-4999657660
- Location: —

```markdown
<sub>🛡️ This DiffSentry review has been superseded by a newer one. Its findings, if still present, appear there.</sub>
```

---

## diffsentry[bot] · review-summary · 2026-08-22T08:39:34Z

- Source: https://github.com/mk7luke/DiffSentry/pull/146#pullrequestreview-4999773923
- Location: —

```markdown
**Actionable comments posted: 0**

The sanitizer migration is well-scoped and materially improves the legacy dashboard's stored-XSS posture by switching from regex stripping to parse-and-rebuild allowlisting. The configured tag, attribute, scheme, and input-control policies match the stated rendering requirements, and the regression tests cover the previously exploitable encoding and malformed-tag cases. No actionable issues were found in the incremental diff.

<details>
<summary>🧹 Nitpick comments (2)</summary><blockquote>

<details>
<summary>tests/unit/markdown.test.ts (2)</summary><blockquote>

`Line 65`: **<img> without alt attribute**

_⚠️ Potential issue_ | _🟡 Minor_

**<img> without alt attribute**

Images without an `alt` attribute are invisible to screen readers and can fail accessibility audits.

**Suggested fix:** Add `alt=""` for purely decorative images, or a descriptive string for meaningful ones.

_DiffSentry built-in pattern check — disable globally with `reviews.builtin_patterns: false`._

<details>
<summary>🤖 Prompt for AI Agents</summary>

```text
Verify each finding against the current code and only fix it if needed.

In tests/unit/markdown.test.ts at line 65, the line matches the "<img> without alt attribute" anti-pattern. Add `alt=""` for purely decorative images, or a descriptive string for meaningful ones.
```

</details>

<!-- diffsentry-fingerprint:9d92b2a773f4 -->

<!-- diffsentry-severity:minor -->

<!-- This is an auto-generated reply by DiffSentry -->

<details>
<summary>🤖 Prompt for AI Agents</summary>

```text
Verify each finding against the current code and only fix it if needed.

In tests/unit/markdown.test.ts at line 65, the line matches the "<img> without alt attribute" anti-pattern. Add `alt=""` for purely decorative images, or a descriptive string for meaningful ones.
```

</details>

`Line 66`: **<img> without alt attribute**

_⚠️ Potential issue_ | _🟡 Minor_

**<img> without alt attribute**

Images without an `alt` attribute are invisible to screen readers and can fail accessibility audits.

**Suggested fix:** Add `alt=""` for purely decorative images, or a descriptive string for meaningful ones.

_DiffSentry built-in pattern check — disable globally with `reviews.builtin_patterns: false`._

<details>
<summary>🤖 Prompt for AI Agents</summary>

```text
Verify each finding against the current code and only fix it if needed.

In tests/unit/markdown.test.ts at line 66, the line matches the "<img> without alt attribute" anti-pattern. Add `alt=""` for purely decorative images, or a descriptive string for meaningful ones.
```

</details>

<!-- diffsentry-fingerprint:6f60f25f213a -->

<!-- diffsentry-severity:minor -->

<!-- This is an auto-generated reply by DiffSentry -->

<details>
<summary>🤖 Prompt for AI Agents</summary>

```text
Verify each finding against the current code and only fix it if needed.

In tests/unit/markdown.test.ts at line 66, the line matches the "<img> without alt attribute" anti-pattern. Add `alt=""` for purely decorative images, or a descriptive string for meaningful ones.
```

</details>

</blockquote></details>

</blockquote></details>

<details>
<summary>🤖 Prompt for all review comments with AI agents</summary>

```text
Verify each finding against the current code and only fix it if needed.

In `tests/unit/markdown.test.ts`:
- Line 65: In tests/unit/markdown.test.ts at line 65, the line matches the "<img> without alt attribute" anti-pattern. Add `alt=""` for purely decorative images, or a descriptive string for meaningful ones.
- Line 66: In tests/unit/markdown.test.ts at line 66, the line matches the "<img> without alt attribute" anti-pattern. Add `alt=""` for purely decorative images, or a descriptive string for meaningful ones.
```

</details>

<details>
<summary>🪄 Autofix (Beta)</summary>

Fix all unresolved DiffSentry comments on this PR:

- [ ] <!-- {"checkboxId": "b2eec2db-584d-4119-88e9-d99d7c77af6d"} --> Push a commit to this branch (recommended)
- [ ] <!-- {"checkboxId": "cbd32f5a-d8c5-4ece-98af-d3ac23f10b59"} --> Create a new PR with the fixes

</details>

---

<details>
<summary>ℹ️ Review info</summary>

<details>
<summary>⚙️ Run configuration</summary>

**Configuration used**: `.diffsentry.yaml`

**Review profile**: ASSERTIVE

**Run ID**: `6d3a8d4c-b48a-4346-82f7-46c969fa600c`

</details>

<details>
<summary>📥 Commits</summary>

Reviewing files that changed from [`c3c1224`](https://github.com/mk7luke/DiffSentry/commit/c3c1224d0f97c745ddd0741e5a0caf84e9402433) to [`ba78377`](https://github.com/mk7luke/DiffSentry/commit/ba783777e44ec38cae63703d730f7ac963c0816d). Previously-reviewed commits are not re-reviewed.

</details>

<details>
<summary>📒 Files selected for processing (2)</summary>

* `src/dashboard/markdown.ts`
* `tests/unit/markdown.test.ts`

</details>

<details>
<summary>✅ Files skipped from review due to trivial changes (2)</summary>

* `package.json`
* `web/src/lib/markdown.ts`

</details>
<details>
<summary>🚧 Files skipped from review as they are similar to previous changes (1)</summary>

* `CHANGELOG.md`

</details>

</details>

<!-- This is an auto-generated comment by DiffSentry for review status -->
```

---

## diffsentry[bot] · review-summary · 2026-08-22T08:46:14Z

- Source: https://github.com/mk7luke/DiffSentry/pull/146#pullrequestreview-4999784058
- Location: —

```markdown
**Actionable comments posted: 0**

The added test suite provides strong regression coverage for the sanitizer’s principal XSS bypass classes, supported Markdown output, and parser-failure fallback. The assertions align with the documented allowlist behavior and do not introduce observable correctness, security, or maintainability issues in the changed file.

---

<details>
<summary>ℹ️ Review info</summary>

<details>
<summary>⚙️ Run configuration</summary>

**Configuration used**: `.diffsentry.yaml`

**Review profile**: ASSERTIVE

**Run ID**: `010a0c87-045e-40bf-bb63-57b37a93f0d0`

</details>

<details>
<summary>📥 Commits</summary>

Reviewing files that changed from [`ba78377`](https://github.com/mk7luke/DiffSentry/commit/ba783777e44ec38cae63703d730f7ac963c0816d) to [`00b6d50`](https://github.com/mk7luke/DiffSentry/commit/00b6d50fee0190ce0d0812a59a2011ce1490a08e). Previously-reviewed commits are not re-reviewed.

</details>

<details>
<summary>📒 Files selected for processing (1)</summary>

* `tests/unit/markdown.test.ts`

</details>

<details>
<summary>✅ Files skipped from review due to trivial changes (2)</summary>

* `package.json`
* `web/src/lib/markdown.ts`

</details>
<details>
<summary>🚧 Files skipped from review as they are similar to previous changes (2)</summary>

* `CHANGELOG.md`
* `src/dashboard/markdown.ts`

</details>

</details>

<!-- This is an auto-generated comment by DiffSentry for review status -->
```

---

## diffsentry[bot] · review-summary · 2026-09-05T04:31:00Z

- Source: https://github.com/mk7luke/DiffSentry/pull/146#pullrequestreview-5119783076
- Location: —

```markdown
**Actionable comments posted: 0**

The incremental change only updates the changelog and accurately documents the dashboard Markdown sanitizer security fix already implemented earlier in the PR. The entry clearly explains the affected trust boundary, bypass classes, and preserved rendering features without introducing code or documentation inconsistencies.

---

<details>
<summary>ℹ️ Review info</summary>

<details>
<summary>⚙️ Run configuration</summary>

**Configuration used**: `.diffsentry.yaml`

**Review profile**: ASSERTIVE

**Run ID**: `0a7420ac-5d5e-437a-bdf7-243c9cc22cda`

</details>

<details>
<summary>📥 Commits</summary>

Reviewing files that changed from [`00b6d50`](https://github.com/mk7luke/DiffSentry/commit/00b6d50fee0190ce0d0812a59a2011ce1490a08e) to [`8c70b78`](https://github.com/mk7luke/DiffSentry/commit/8c70b78aa10785c98ea39e25fe2eef4107e7b71e). Previously-reviewed commits are not re-reviewed.

</details>

<details>
<summary>📒 Files selected for processing (1)</summary>

* `CHANGELOG.md`

</details>

<details>
<summary>✅ Files skipped from review due to trivial changes (2)</summary>

* `package.json`
* `web/src/lib/markdown.ts`

</details>
<details>
<summary>🚧 Files skipped from review as they are similar to previous changes (2)</summary>

* `src/dashboard/markdown.ts`
* `tests/unit/markdown.test.ts`

</details>

</details>

<!-- This is an auto-generated comment by DiffSentry for review status -->
```

---

## diffsentry[bot] · review-summary · 2026-09-14T21:01:06Z

- Source: https://github.com/mk7luke/DiffSentry/pull/146#pullrequestreview-5202857430
- Location: —

```markdown
**Actionable comments posted: 0**

The incremental change only updates the changelog and accurately documents the markdown-sanitization security fix already reviewed in the earlier PR context. The entry is clear, scoped to the legacy dashboard path, and correctly describes the affected content sources and preserved rendering features.

---

<details>
<summary>ℹ️ Review info</summary>

<details>
<summary>⚙️ Run configuration</summary>

**Configuration used**: `.diffsentry.yaml`

**Review profile**: ASSERTIVE

**Run ID**: `8ae20f49-209a-4c8c-9caf-9150230e7cbc`

</details>

<details>
<summary>📥 Commits</summary>

Reviewing files that changed from [`8c70b78`](https://github.com/mk7luke/DiffSentry/commit/8c70b78aa10785c98ea39e25fe2eef4107e7b71e) to [`a92a9c7`](https://github.com/mk7luke/DiffSentry/commit/a92a9c784f90debe41bab1f6d7f4a31a45c159e7). Previously-reviewed commits are not re-reviewed.

</details>

<details>
<summary>📒 Files selected for processing (1)</summary>

* `CHANGELOG.md`

</details>

<details>
<summary>✅ Files skipped from review due to trivial changes (2)</summary>

* `package.json`
* `web/src/lib/markdown.ts`

</details>
<details>
<summary>🚧 Files skipped from review as they are similar to previous changes (2)</summary>

* `src/dashboard/markdown.ts`
* `tests/unit/markdown.test.ts`

</details>

</details>

<!-- This is an auto-generated comment by DiffSentry for review status -->
```

---

## diffsentry[bot] · review-summary · 2026-08-22T08:08:17Z

- Source: https://github.com/mk7luke/DiffSentry/pull/147#pullrequestreview-4999601091
- Location: —

```markdown
<sub>🛡️ This DiffSentry review has been superseded by a newer one. Its findings, if still present, appear there.</sub>
```

---

## diffsentry[bot] · review-summary · 2026-09-05T04:31:50Z

- Source: https://github.com/mk7luke/DiffSentry/pull/147#pullrequestreview-5119784671
- Location: —

```markdown
<sub>🛡️ This DiffSentry review has been superseded by a newer one. Its findings, if still present, appear there.</sub>
```

---

## diffsentry[bot] · review-summary · 2026-09-05T22:21:46Z

- Source: https://github.com/mk7luke/DiffSentry/pull/147#pullrequestreview-5123235772
- Location: —

```markdown
**Actionable comments posted: 0**

The incremental changes are cohesive and preserve the stated behavior while centralizing shared helpers and adding defensive validation around learnings paths. The new repository segment validator correctly blocks traversal-special values, and the shared fence-stripping and API envelope helpers retain the prior contracts. No concrete regressions were identified in the newly changed files.

---

<details>
<summary>ℹ️ Review info</summary>

<details>
<summary>⚙️ Run configuration</summary>

**Configuration used**: `.diffsentry.yaml`

**Review profile**: ASSERTIVE

**Run ID**: `4ca9bbba-345c-4aae-a711-5992873e3cbf`

</details>

<details>
<summary>📥 Commits</summary>

Reviewing files that changed from [`33bbbc2`](https://github.com/mk7luke/DiffSentry/commit/33bbbc2b435e89cef3ebef5a11a66963f291794a) to [`232a7c4`](https://github.com/mk7luke/DiffSentry/commit/232a7c42332b3e39ebabd8f5311be2fff2517bca). Previously-reviewed commits are not re-reviewed.

</details>

<details>
<summary>📒 Files selected for processing (2)</summary>

* `CHANGELOG.md`
* `src/learnings.ts`

</details>

<details>
<summary>✅ Files skipped from review due to trivial changes (3)</summary>

* `package.json`
* `src/dashboard/auth.ts`
* `web/package.json`

</details>
<details>
<summary>🚧 Files skipped from review as they are similar to previous changes (40)</summary>

* `README.md`
* `docs/MIGRATIONS.md`
* `scripts/migrate-smoke.ts`
* `src/ai/anthropic.ts`
* `src/ai/openai.ts`
* `src/ai/parse.ts`
* `src/ai/pricing.ts`
* `src/api/actions.ts`
* `src/api/config.ts`
* `src/api/cost.ts`
* `src/api/diagnostics.ts`
* `src/api/http.ts`
* `src/api/learnings.ts`
* `src/api/notifications.ts`
* `src/api/pr-diff.ts`
* `src/api/router.ts`
* `src/api/rules.ts`
* `src/api/settings.ts`
* `src/api/shares.ts`
* `src/api/tokens.ts`
* `src/api/webhooks.ts`
* `src/codeowners.ts`
* `src/config.ts`
* `src/dashboard/queries.ts`
* `src/dashboard/routes.ts`
* `src/drift.ts`
* `src/graph-context.ts`
* `src/guidelines.ts`
* `src/issues.ts`
* `src/repo-config.ts`
* `src/review-body.ts`
* `src/reviewer.ts`
* `src/static-analysis.ts`
* `src/storage/dao.ts`
* `src/storage/db.ts`
* `src/types.ts`
* `src/walkthrough.ts`
* `src/webhook/dispatch.ts`
* `web/src/lib/format.ts`
* `web/src/realtime/useEventStream.tsx`

</details>

</details>

<!-- This is an auto-generated comment by DiffSentry for review status -->
```

---

## diffsentry[bot] · review-summary · 2026-09-14T20:58:53Z

- Source: https://github.com/mk7luke/DiffSentry/pull/147#pullrequestreview-5202837962
- Location: —

```markdown
**Actionable comments posted: 0**

The incremental changes correctly centralize repository-segment validation and make malformed learnings files degrade safely on the read path. The added tests cover the new path-safety behavior and non-array JSON handling. No actionable regressions are visible in the newly changed files.

---

<details>
<summary>ℹ️ Review info</summary>

<details>
<summary>⚙️ Run configuration</summary>

**Configuration used**: `.diffsentry.yaml`

**Review profile**: ASSERTIVE

**Run ID**: `cbb1e182-602d-4738-8fc2-38856ec4449d`

</details>

<details>
<summary>📥 Commits</summary>

Reviewing files that changed from [`232a7c4`](https://github.com/mk7luke/DiffSentry/commit/232a7c42332b3e39ebabd8f5311be2fff2517bca) to [`ba47196`](https://github.com/mk7luke/DiffSentry/commit/ba4719674187ae67ba38a6ff11832f80affefb07). Previously-reviewed commits are not re-reviewed.

</details>

<details>
<summary>📒 Files selected for processing (2)</summary>

* `src/learnings.ts`
* `tests/unit/learnings-path-safety.test.ts`

</details>

<details>
<summary>✅ Files skipped from review due to trivial changes (3)</summary>

* `package.json`
* `src/dashboard/auth.ts`
* `web/package.json`

</details>
<details>
<summary>🚧 Files skipped from review as they are similar to previous changes (41)</summary>

* `CHANGELOG.md`
* `README.md`
* `docs/MIGRATIONS.md`
* `scripts/migrate-smoke.ts`
* `src/ai/anthropic.ts`
* `src/ai/openai.ts`
* `src/ai/parse.ts`
* `src/ai/pricing.ts`
* `src/api/actions.ts`
* `src/api/config.ts`
* `src/api/cost.ts`
* `src/api/diagnostics.ts`
* `src/api/http.ts`
* `src/api/learnings.ts`
* `src/api/notifications.ts`
* `src/api/pr-diff.ts`
* `src/api/router.ts`
* `src/api/rules.ts`
* `src/api/settings.ts`
* `src/api/shares.ts`
* `src/api/tokens.ts`
* `src/api/webhooks.ts`
* `src/codeowners.ts`
* `src/config.ts`
* `src/dashboard/queries.ts`
* `src/dashboard/routes.ts`
* `src/drift.ts`
* `src/graph-context.ts`
* `src/guidelines.ts`
* `src/issues.ts`
* `src/repo-config.ts`
* `src/review-body.ts`
* `src/reviewer.ts`
* `src/static-analysis.ts`
* `src/storage/dao.ts`
* `src/storage/db.ts`
* `src/types.ts`
* `src/walkthrough.ts`
* `src/webhook/dispatch.ts`
* `web/src/lib/format.ts`
* `web/src/realtime/useEventStream.tsx`

</details>

</details>

<!-- This is an auto-generated comment by DiffSentry for review status -->
```

---

## diffsentry[bot] · review-summary · 2026-09-14T21:20:39Z

- Source: https://github.com/mk7luke/DiffSentry/pull/147#pullrequestreview-5203017310
- Location: —

```markdown
**Actionable comments posted: 0**

The incremental changes are cohesive and correctly consolidate duplicated API and formatting helpers while preserving the documented response shapes. The new learnings-store validation and malformed-file handling are covered by focused tests, and the migration cleanup is idempotent. No actionable defects were found in the changed files.

---

<details>
<summary>ℹ️ Review info</summary>

<details>
<summary>⚙️ Run configuration</summary>

**Configuration used**: `.diffsentry.yaml`

**Review profile**: ASSERTIVE

**Run ID**: `9fb98659-a11b-4f37-b72c-3e6fe640ad70`

</details>

<details>
<summary>📥 Commits</summary>

Reviewing files that changed from [`ba47196`](https://github.com/mk7luke/DiffSentry/commit/ba4719674187ae67ba38a6ff11832f80affefb07) to [`0fca4fb`](https://github.com/mk7luke/DiffSentry/commit/0fca4fba241c961ec98cb55aece4e13f832acef7). Previously-reviewed commits are not re-reviewed.

</details>

<details>
<summary>📒 Files selected for processing (1)</summary>

* `CHANGELOG.md`

</details>

<details>
<summary>✅ Files skipped from review due to trivial changes (3)</summary>

* `package.json`
* `src/dashboard/auth.ts`
* `web/package.json`

</details>
<details>
<summary>🚧 Files skipped from review as they are similar to previous changes (42)</summary>

* `README.md`
* `docs/MIGRATIONS.md`
* `scripts/migrate-smoke.ts`
* `src/ai/anthropic.ts`
* `src/ai/openai.ts`
* `src/ai/parse.ts`
* `src/ai/pricing.ts`
* `src/api/actions.ts`
* `src/api/config.ts`
* `src/api/cost.ts`
* `src/api/diagnostics.ts`
* `src/api/http.ts`
* `src/api/learnings.ts`
* `src/api/notifications.ts`
* `src/api/pr-diff.ts`
* `src/api/router.ts`
* `src/api/rules.ts`
* `src/api/settings.ts`
* `src/api/shares.ts`
* `src/api/tokens.ts`
* `src/api/webhooks.ts`
* `src/codeowners.ts`
* `src/config.ts`
* `src/dashboard/queries.ts`
* `src/dashboard/routes.ts`
* `src/drift.ts`
* `src/graph-context.ts`
* `src/guidelines.ts`
* `src/issues.ts`
* `src/learnings.ts`
* `src/repo-config.ts`
* `src/review-body.ts`
* `src/reviewer.ts`
* `src/static-analysis.ts`
* `src/storage/dao.ts`
* `src/storage/db.ts`
* `src/types.ts`
* `src/walkthrough.ts`
* `src/webhook/dispatch.ts`
* `tests/unit/learnings-path-safety.test.ts`
* `web/src/lib/format.ts`
* `web/src/realtime/useEventStream.tsx`

</details>

</details>

<!-- This is an auto-generated comment by DiffSentry for review status -->
```

---

## diffsentry[bot] · review-summary · 2026-09-14T21:39:12Z

- Source: https://github.com/mk7luke/DiffSentry/pull/165#pullrequestreview-5203176956
- Location: —

```markdown
**Actionable comments posted: 0**

This is a focused, correct CI configuration change. Setting `cancel-in-progress` to `false` preserves labeler completion for synchronized Dependabot PRs and avoids leaving cancelled check-rollup entries that block strict auto-merge evaluation. The added rationale accurately documents the non-obvious interaction and the trade-off is appropriate for this idempotent workflow.

---

<details>
<summary>ℹ️ Review info</summary>

<details>
<summary>⚙️ Run configuration</summary>

**Configuration used**: `.diffsentry.yaml`

**Review profile**: ASSERTIVE

**Run ID**: `c7b72836-d04e-4cf4-8095-d3649de1d09e`

</details>

<details>
<summary>📥 Commits</summary>

Reviewing files at [`94e9faf`](https://github.com/mk7luke/DiffSentry/commit/94e9fafc8114ac0f87d33fcb234cdbbf11157883) (base SHA unavailable).

</details>

<details>
<summary>📒 Files selected for processing (1)</summary>

* `.github/workflows/labeler.yml`

</details>

</details>

<!-- This is an auto-generated comment by DiffSentry for review status -->
```

---

## diffsentry[bot] · review-summary · 2026-09-14T21:34:32Z

- Source: https://github.com/mk7luke/DiffSentry/pull/164#pullrequestreview-5203140081
- Location: —

```markdown
**Actionable comments posted: 0**

The workflow trigger expansion correctly addresses the described race by waking auto-merge after each independent PR check workflow completes. Removing the triggering run's conclusion filter is safe because the existing rollup validation remains the merge authority, and the event guard now correctly includes the labeler's `pull_request_target` runs. No actionable issues found in the provided change.

---

<details>
<summary>ℹ️ Review info</summary>

<details>
<summary>⚙️ Run configuration</summary>

**Configuration used**: `.diffsentry.yaml`

**Review profile**: ASSERTIVE

**Run ID**: `8d69cedb-3a65-4a94-b5cf-63f2edb60d03`

</details>

<details>
<summary>📥 Commits</summary>

Reviewing files at [`10bd8b1`](https://github.com/mk7luke/DiffSentry/commit/10bd8b16e73c15524da8dbd47c8e66afbd16f154) (base SHA unavailable).

</details>

<details>
<summary>📒 Files selected for processing (1)</summary>

* `.github/workflows/dependabot-auto-merge.yml`

</details>

</details>

<!-- This is an auto-generated comment by DiffSentry for review status -->
```

---

## diffsentry[bot] · review-summary · 2026-09-14T21:03:15Z

- Source: https://github.com/mk7luke/DiffSentry/pull/163#pullrequestreview-5202874934
- Location: —

```markdown
**Actionable comments posted: 0**

The author guard now accepts the GraphQL-rendered `app/dependabot` login as well as the REST and bare variants, directly resolving the workflow's false rejection of Dependabot PRs. The shell `case` expression is correctly quoted and preserves the intended no-op behavior for non-Dependabot authors. No actionable issues were found in the supplied change.

---

<details>
<summary>ℹ️ Review info</summary>

<details>
<summary>⚙️ Run configuration</summary>

**Configuration used**: `.diffsentry.yaml`

**Review profile**: ASSERTIVE

**Run ID**: `a371b44f-25b7-41bf-a53b-8890b3a8742f`

</details>

<details>
<summary>📥 Commits</summary>

Reviewing files at [`74bc328`](https://github.com/mk7luke/DiffSentry/commit/74bc3282c495e099ee8eceaa3bfc3da82a25fa4b) (base SHA unavailable).

</details>

<details>
<summary>📒 Files selected for processing (1)</summary>

* `.github/workflows/dependabot-auto-merge.yml`

</details>

</details>

<!-- This is an auto-generated comment by DiffSentry for review status -->
```

---

## diffsentry[bot] · review-summary · 2026-08-31T15:38:38Z

- Source: https://github.com/mk7luke/DiffSentry/pull/156#pullrequestreview-5068332724
- Location: —

```markdown
**Actionable comments posted: 0**

This Dependabot update correctly advances `trufflesecurity/trufflehog` from v3.97.0 to v3.97.1 and updates the immutable commit SHA consistently with the version comment. The workflow remains pinned to a full commit digest, preserving supply-chain integrity. No issues found.

---

<details>
<summary>ℹ️ Review info</summary>

<details>
<summary>⚙️ Run configuration</summary>

**Configuration used**: `.diffsentry.yaml`

**Review profile**: ASSERTIVE

**Run ID**: `6ea2900c-5704-4691-b885-5bbe01b6d8a7`

</details>

<details>
<summary>📥 Commits</summary>

Reviewing files at [`874649b`](https://github.com/mk7luke/DiffSentry/commit/874649b178ea46f43fb0bcc6891934a176f3f572) (base SHA unavailable).

</details>

<details>
<summary>📒 Files selected for processing (1)</summary>

* `.github/workflows/secret-scan.yml`

</details>

</details>

<!-- This is an auto-generated comment by DiffSentry for review status -->
```

---

## diffsentry[bot] · review-summary · 2026-09-07T15:38:19Z

- Source: https://github.com/mk7luke/DiffSentry/pull/156#pullrequestreview-5133664269
- Location: —

```markdown
**Actionable comments posted: 0**

This dependency update correctly advances the TruffleHog action from v3.97.0 to v3.97.4 while retaining immutable commit-SHA pinning. The trailing version comment matches the pinned release, and the workflow configuration is otherwise unchanged.

---

<details>
<summary>ℹ️ Review info</summary>

<details>
<summary>⚙️ Run configuration</summary>

**Configuration used**: `.diffsentry.yaml`

**Review profile**: ASSERTIVE

**Run ID**: `001aec25-baaf-4204-bf1b-1a09d2064e7d`

</details>

<details>
<summary>📥 Commits</summary>

Reviewing files that changed from [`874649b`](https://github.com/mk7luke/DiffSentry/commit/874649b178ea46f43fb0bcc6891934a176f3f572) to [`520fc56`](https://github.com/mk7luke/DiffSentry/commit/520fc569280ba953b605f913e9052e815a7c4e55). Previously-reviewed commits are not re-reviewed.

</details>

<details>
<summary>📒 Files selected for processing (1)</summary>

* `.github/workflows/secret-scan.yml`

</details>

</details>

<!-- This is an auto-generated comment by DiffSentry for review status -->
```

---

## diffsentry[bot] · review-summary · 2026-08-22T06:54:24Z

- Source: https://github.com/mk7luke/DiffSentry/pull/145#pullrequestreview-4999410380
- Location: —

```markdown
**Actionable comments posted: 0**

The bot-author guard correctly closes the forged walkthrough-marker path before checkbox edits can dispatch Finishing Touches commands. The regression tests cover the exploit, the intended bot-authored path, and no-op checkbox edits. No correctness, security, or maintainability issues were found in the proposed changes.

---

<details>
<summary>ℹ️ Review info</summary>

<details>
<summary>⚙️ Run configuration</summary>

**Configuration used**: `.diffsentry.yaml`

**Review profile**: ASSERTIVE

**Run ID**: `2c2d4aad-27a9-4da5-9358-b2a159a063b3`

</details>

<details>
<summary>📥 Commits</summary>

Reviewing files at [`5c4ece5`](https://github.com/mk7luke/DiffSentry/commit/5c4ece55398c54ae455cf515dbbfa5e16816042b) (base SHA unavailable).

</details>

<details>
<summary>📒 Files selected for processing (3)</summary>

* `CHANGELOG.md`
* `src/webhook/dispatch.ts`
* `tests/unit/slash-dispatch.test.ts`

</details>

</details>

<!-- This is an auto-generated comment by DiffSentry for review status -->
```

---

## diffsentry[bot] · review-summary · 2026-09-05T04:30:23Z

- Source: https://github.com/mk7luke/DiffSentry/pull/145#pullrequestreview-5119781835
- Location: —

```markdown
**Actionable comments posted: 0**

The incremental change updates only the changelog, while the previously reviewed implementation and regression tests correctly enforce bot authorship before honoring walkthrough checkbox edits. The documented security impact and behavior align with the supplied code context, and no additional issues are present in the newly changed file.

---

<details>
<summary>ℹ️ Review info</summary>

<details>
<summary>⚙️ Run configuration</summary>

**Configuration used**: `.diffsentry.yaml`

**Review profile**: ASSERTIVE

**Run ID**: `7ebfd526-3401-42dd-a87b-edb317fb3bfe`

</details>

<details>
<summary>📥 Commits</summary>

Reviewing files that changed from [`5c4ece5`](https://github.com/mk7luke/DiffSentry/commit/5c4ece55398c54ae455cf515dbbfa5e16816042b) to [`876b275`](https://github.com/mk7luke/DiffSentry/commit/876b2750fa03406279878554f0ba00faf2c3fe49). Previously-reviewed commits are not re-reviewed.

</details>

<details>
<summary>📒 Files selected for processing (1)</summary>

* `CHANGELOG.md`

</details>

<details>
<summary>🚧 Files skipped from review as they are similar to previous changes (2)</summary>

* `src/webhook/dispatch.ts`
* `tests/unit/slash-dispatch.test.ts`

</details>

</details>

<!-- This is an auto-generated comment by DiffSentry for review status -->
```

---

## diffsentry[bot] · review-summary · 2026-08-28T18:47:33Z

- Source: https://github.com/mk7luke/DiffSentry/pull/152#pullrequestreview-5054083705
- Location: —

```markdown
**Actionable comments posted: 0**

This PR correctly centralizes GitHub App ID validation and applies the shared predicate to configuration loading, diagnostics, and setup-time validation. The interactive setup flow now prevents invalid Client IDs and slugs from being written, while the added validator tests cover the important accepted and rejected `.env` cases. No correctness, security, or maintainability issues were found in the provided changes.

---

<details>
<summary>ℹ️ Review info</summary>

<details>
<summary>⚙️ Run configuration</summary>

**Configuration used**: `.diffsentry.yaml`

**Review profile**: ASSERTIVE

**Run ID**: `acbd0d86-2d58-4c86-aa47-1e8d598dd179`

</details>

<details>
<summary>📥 Commits</summary>

Reviewing files at [`2177b7b`](https://github.com/mk7luke/DiffSentry/commit/2177b7b205aa974f913db38391fe21102d7cd561) (base SHA unavailable).

</details>

<details>
<summary>📒 Files selected for processing (4)</summary>

* `scripts/setup.ts`
* `src/api/diagnostics.ts`
* `src/config.ts`
* `tests/unit/setup-env-validation.test.ts`

</details>

</details>

<!-- This is an auto-generated comment by DiffSentry for review status -->
```

---

## diffsentry[bot] · review-summary · 2026-08-28T20:33:37Z

- Source: https://github.com/mk7luke/DiffSentry/pull/153#pullrequestreview-5054874967
- Location: —

```markdown
**Actionable comments posted: 0**

The PR cleanly centralizes GitHub App ID validation and applies the shared predicate consistently in runtime configuration, diagnostics, and interactive setup. The added tests cover numeric, whitespace-padded, empty, and Client-ID-like inputs along with `.env` validation behavior. No correctness, security, or maintainability issues were found in the provided changes.

---

<details>
<summary>ℹ️ Review info</summary>

<details>
<summary>⚙️ Run configuration</summary>

**Configuration used**: `.diffsentry.yaml`

**Review profile**: ASSERTIVE

**Run ID**: `45509a04-c3f2-4afa-a886-688a836411d1`

</details>

<details>
<summary>📥 Commits</summary>

Reviewing files at [`27cf08e`](https://github.com/mk7luke/DiffSentry/commit/27cf08e51818674fe48bc6275b971ed355efc947) (base SHA unavailable).

</details>

<details>
<summary>📒 Files selected for processing (4)</summary>

* `scripts/setup.ts`
* `src/api/diagnostics.ts`
* `src/config.ts`
* `tests/unit/config-github-app-id.test.ts`

</details>

</details>

<!-- This is an auto-generated comment by DiffSentry for review status -->
```

---

## diffsentry[bot] · review-summary · 2026-08-28T06:23:26Z

- Source: https://github.com/mk7luke/DiffSentry/pull/150#pullrequestreview-5048434754
- Location: —

```markdown
**Actionable comments posted: 0**

This PR correctly validates and normalizes `GITHUB_APP_ID` during configuration loading, aligns the diagnostics check with the same numeric requirement, and documents the distinction from a GitHub Client ID. The validation preserves the intended string representation for JWT construction while preventing whitespace and non-numeric values from reaching the `iss` claim. The focused tests cover valid, trimmed, missing, and representative invalid inputs.

---

<details>
<summary>ℹ️ Review info</summary>

<details>
<summary>⚙️ Run configuration</summary>

**Configuration used**: `.diffsentry.yaml`

**Review profile**: ASSERTIVE

**Run ID**: `8834558d-d203-4229-8894-446a2df0d59e`

</details>

<details>
<summary>📥 Commits</summary>

Reviewing files at [`a5447a6`](https://github.com/mk7luke/DiffSentry/commit/a5447a675aef4d85814bf47020cb808b0ca90a3c) (base SHA unavailable).

</details>

<details>
<summary>⛔ Files ignored due to path filters (1)</summary>

* `.env.example` is excluded by `!.env.example`

</details>
<details>
<summary>📒 Files selected for processing (5)</summary>

* `CHANGELOG.md`
* `README.md`
* `src/api/diagnostics.ts`
* `src/config.ts`
* `tests/unit/config-github-app-id.test.ts`

</details>

</details>

<!-- This is an auto-generated comment by DiffSentry for review status -->
```

---
