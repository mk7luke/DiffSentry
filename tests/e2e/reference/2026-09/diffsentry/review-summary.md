# Review summaries

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
