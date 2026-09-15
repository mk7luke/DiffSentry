# Chat replies

## diffsentry[bot] · chat · 2026-08-22T06:55:04Z

- Source: https://github.com/mk7luke/DiffSentry/pull/146#issuecomment-5378757163
- Location: —

```markdown
<!-- DiffSentry Status -->
> :white_check_mark: **DiffSentry** has completed the review — Looks good!
```

---

## diffsentry[bot] · chat · 2026-08-22T06:55:53Z

- Source: https://github.com/mk7luke/DiffSentry/pull/146#issuecomment-5378766713
- Location: —

```markdown
<!-- DiffSentry Sticky Status -->

# 📌 Status — last updated [`a92a9c7`](https://github.com/mk7luke/DiffSentry/commit/a92a9c784f90debe41bab1f6d7f4a31a45c159e7)

🟢 **Approved**

| | |
|---|---|
| **Risk score** | 5/100 (Low) ▁▄██▄▄▄▄ |
| **Unresolved threads** | 0 |
| **Failing checks** | 0 |
| **Pending checks** | 0 |
| **Files reviewed** | 1 (4 skipped) |
| **Updated** | <code>2026-09-14 21:01Z</code> |

<sub>Live-updated by DiffSentry on every push. Use `@diffsentry ship` for a verdict, `@diffsentry timeline` for full history.</sub>
```

---

## diffsentry[bot] · chat · 2026-08-22T08:46:25Z

- Source: https://github.com/mk7luke/DiffSentry/pull/146#issuecomment-5379390553
- Location: —

```markdown
<!-- DiffSentry Auto Release Notes -->
<!-- DiffSentry Auto Release Notes head: a92a9c784f90debe41bab1f6d7f4a31a45c159e7 -->

# Release Notes

### Improvements

- The legacy dashboard now renders issue bodies, pull request descriptions, findings, and summaries with an allowlist, preserving supported Markdown such as tables, code blocks, collapsible sections, and task lists.

### Bug fixes

- Fixed a stored cross-site scripting issue in the legacy dashboard when webhook-authored Markdown contained encoded unsafe URLs, scriptable HTML, or inline event handlers.

<sub>Drafted automatically once the review of `a92a9c7` came back green, every check passed and every review thread was resolved, and rewritten in place on later commits. Re-run by hand with `@diffsentry release-notes`, or set `release_notes.auto: false` in `.diffsentry.yaml` to stop.</sub>
```

---

## diffsentry[bot] · chat · 2026-08-22T06:55:51Z

- Source: https://github.com/mk7luke/DiffSentry/pull/146#pullrequestreview-4999415215
- Location: —

```markdown
<sub>🛡️ This DiffSentry review has been superseded by a newer one. Its findings, if still present, appear there.</sub>
```

---

## diffsentry[bot] · chat · 2026-08-22T07:04:03Z

- Source: https://github.com/mk7luke/DiffSentry/pull/146#pullrequestreview-4999445075
- Location: —

```markdown
<sub>🛡️ This DiffSentry review has been superseded by a newer one. Its findings, if still present, appear there.</sub>
```

---

## diffsentry[bot] · chat · 2026-08-22T08:19:18Z

- Source: https://github.com/mk7luke/DiffSentry/pull/146#pullrequestreview-4999657660
- Location: —

```markdown
<sub>🛡️ This DiffSentry review has been superseded by a newer one. Its findings, if still present, appear there.</sub>
```

---

## diffsentry[bot] · chat · 2026-08-22T08:07:12Z

- Source: https://github.com/mk7luke/DiffSentry/pull/147#issuecomment-5379176999
- Location: —

```markdown
<!-- DiffSentry Status -->
> ⏭️ **DiffSentry** — no reviewable changes. This update only contains 5 files DiffSentry skips, so there's nothing to review.

<details><summary>Ignored (minified, generated, or lockfile) (2)</summary>

- `package-lock.json`
- `web/package-lock.json`
</details>

<details><summary>No reviewable changes (3)</summary>

- `package.json`
- `src/dashboard/auth.ts`
- `web/package.json`
</details>
```

---

## diffsentry[bot] · chat · 2026-08-22T08:08:18Z

- Source: https://github.com/mk7luke/DiffSentry/pull/147#issuecomment-5379184376
- Location: —

```markdown
<!-- DiffSentry Sticky Status -->

# 📌 Status — last updated [`0fca4fb`](https://github.com/mk7luke/DiffSentry/commit/0fca4fba241c961ec98cb55aece4e13f832acef7)

🟢 **Approved**

| | |
|---|---|
| **Risk score** | 29/100 (Moderate) ▂█▅▁▁ |
| **Unresolved threads** | 0 |
| **Failing checks** | 0 |
| **Pending checks** | 1 |
| **Files reviewed** | 1 (45 skipped) |
| **Updated** | <code>2026-09-14 21:20Z</code> |

<sub>Live-updated by DiffSentry on every push. Use `@diffsentry ship` for a verdict, `@diffsentry timeline` for full history.</sub>
```

---

## diffsentry[bot] · chat · 2026-08-22T08:08:31Z

- Source: https://github.com/mk7luke/DiffSentry/pull/147#issuecomment-5379185765
- Location: —

```markdown
<!-- DiffSentry Auto Release Notes -->
<!-- DiffSentry Auto Release Notes head: 0fca4fba241c961ec98cb55aece4e13f832acef7 -->

# Release Notes

### New features

- `npm run preview:dashboard`, `preview:learnings`, `preview:spa`, `preview:webhooks`, and `screenshot` now expose existing local preview and screenshot tools.

### Improvements

- Learnings stored as a JSON object instead of a list now load as no learnings, rather than failing when the dashboard or API filters them.
- Dashboard learning edit and delete forms now reject invalid repository owner or name path segments.

### Breaking changes

- Database migration 8 removes the unused `saved_views` table; anyone querying that table directly must remove or replace those queries before upgrading.

<sub>Drafted automatically once the review of `0fca4fb` came back green, every check passed and every review thread was resolved, and rewritten in place on later commits. Re-run by hand with `@diffsentry release-notes`, or set `release_notes.auto: false` in `.diffsentry.yaml` to stop.</sub>
```

---

## diffsentry[bot] · chat · 2026-08-22T08:08:17Z

- Source: https://github.com/mk7luke/DiffSentry/pull/147#pullrequestreview-4999601091
- Location: —

```markdown
<sub>🛡️ This DiffSentry review has been superseded by a newer one. Its findings, if still present, appear there.</sub>
```

---

## diffsentry[bot] · chat · 2026-09-05T04:31:50Z

- Source: https://github.com/mk7luke/DiffSentry/pull/147#pullrequestreview-5119784671
- Location: —

```markdown
<sub>🛡️ This DiffSentry review has been superseded by a newer one. Its findings, if still present, appear there.</sub>
```

---

## diffsentry[bot] · chat · 2026-09-14T21:38:40Z

- Source: https://github.com/mk7luke/DiffSentry/pull/165#issuecomment-5671165635
- Location: —

```markdown
<!-- DiffSentry Status -->
> :eyes: **DiffSentry** is reviewing this update... hang tight.
```

---

## diffsentry[bot] · chat · 2026-09-14T21:39:14Z

- Source: https://github.com/mk7luke/DiffSentry/pull/165#issuecomment-5671171409
- Location: —

```markdown
<!-- DiffSentry Sticky Status -->

# 📌 Status — last updated [`94e9faf`](https://github.com/mk7luke/DiffSentry/commit/94e9fafc8114ac0f87d33fcb234cdbbf11157883)

🟢 **Approved**

| | |
|---|---|
| **Risk score** | 0/100 (Low) ▁ |
| **Unresolved threads** | 0 |
| **Failing checks** | 0 |
| **Pending checks** | 1 |
| **Files reviewed** | 1 |
| **Updated** | <code>2026-09-14 21:39Z</code> |

<sub>Live-updated by DiffSentry on every push. Use `@diffsentry ship` for a verdict, `@diffsentry timeline` for full history.</sub>
```

---

## diffsentry[bot] · chat · 2026-09-14T21:40:13Z

- Source: https://github.com/mk7luke/DiffSentry/pull/165#issuecomment-5671181715
- Location: —

```markdown
<!-- DiffSentry Auto Release Notes -->
<!-- DiffSentry Auto Release Notes head: d81bf469394437089a6c42ea37d6a74aacec40bc -->

# Release Notes

### Bug fixes

- Fixed `Label PRs` runs being cancelled by subsequent pushes or branch updates, which could leave a cancelled label check blocking Dependabot auto-merge.

<sub>Drafted automatically once the review of `d81bf46` came back green, every check passed and every review thread was resolved, and rewritten in place on later commits. Re-run by hand with `@diffsentry release-notes`, or set `release_notes.auto: false` in `.diffsentry.yaml` to stop.</sub>
```

---

## diffsentry[bot] · chat · 2026-09-14T15:37:16Z

- Source: https://github.com/mk7luke/DiffSentry/pull/160#issuecomment-5666542405
- Location: —

```markdown
<!-- DiffSentry Status -->
> ⏭️ **DiffSentry** — no reviewable changes. This update only contains 2 files DiffSentry skips, so there's nothing to review.

<details><summary>Ignored (minified, generated, or lockfile) (1)</summary>

- `package-lock.json`
</details>

<details><summary>No reviewable changes (1)</summary>

- `package.json`
</details>
```

---

## diffsentry[bot] · chat · 2026-09-14T15:40:05Z

- Source: https://github.com/mk7luke/DiffSentry/pull/160#issuecomment-5666582096
- Location: —

```markdown
<!-- DiffSentry Auto Release Notes -->
<!-- DiffSentry Auto Release Notes head: b479d5c97860beda91aef489f4f2f97b38cbc3b4 -->

# Release Notes

No user-visible changes. This PR updates runtime and development dependencies only.

<sub>Drafted automatically once the review of `b479d5c` came back green, every check passed and every review thread was resolved, and rewritten in place on later commits. Re-run by hand with `@diffsentry release-notes`, or set `release_notes.auto: false` in `.diffsentry.yaml` to stop.</sub>
```

---

## diffsentry[bot] · chat · 2026-09-14T15:37:56Z

- Source: https://github.com/mk7luke/DiffSentry/pull/161#issuecomment-5666551967
- Location: —

```markdown
<!-- DiffSentry Status -->
> ⏭️ **DiffSentry** — no reviewable changes. This update only contains 2 files DiffSentry skips, so there's nothing to review.

<details><summary>Ignored (minified, generated, or lockfile) (1)</summary>

- `web/package-lock.json`
</details>

<details><summary>No reviewable changes (1)</summary>

- `web/package.json`
</details>
```

---

## diffsentry[bot] · chat · 2026-09-14T15:39:46Z

- Source: https://github.com/mk7luke/DiffSentry/pull/161#issuecomment-5666577769
- Location: —

```markdown
<!-- DiffSentry Auto Release Notes -->
<!-- DiffSentry Auto Release Notes head: fab1693e77c9f72dece5a956fb08e92dec6ee2f4 -->

# Release Notes

No user-visible changes. This update only refreshes web application dependencies.

<sub>Drafted automatically once the review of `fab1693` came back green, every check passed and every review thread was resolved, and rewritten in place on later commits. Re-run by hand with `@diffsentry release-notes`, or set `release_notes.auto: false` in `.diffsentry.yaml` to stop.</sub>
```

---

## diffsentry[bot] · chat · 2026-09-14T21:33:59Z

- Source: https://github.com/mk7luke/DiffSentry/pull/164#issuecomment-5671116513
- Location: —

```markdown
<!-- DiffSentry Status -->
> :white_check_mark: **DiffSentry** has completed the review — Looks good!
```

---

## diffsentry[bot] · chat · 2026-09-14T21:34:34Z

- Source: https://github.com/mk7luke/DiffSentry/pull/164#issuecomment-5671122649
- Location: —

```markdown
<!-- DiffSentry Sticky Status -->

# 📌 Status — last updated [`10bd8b1`](https://github.com/mk7luke/DiffSentry/commit/10bd8b16e73c15524da8dbd47c8e66afbd16f154)

🟢 **Approved**

| | |
|---|---|
| **Risk score** | 0/100 (Low) ▁ |
| **Unresolved threads** | 0 |
| **Failing checks** | 0 |
| **Pending checks** | 1 |
| **Files reviewed** | 1 |
| **Updated** | <code>2026-09-14 21:34Z</code> |

<sub>Live-updated by DiffSentry on every push. Use `@diffsentry ship` for a verdict, `@diffsentry timeline` for full history.</sub>
```

---

## diffsentry[bot] · chat · 2026-09-14T21:35:40Z

- Source: https://github.com/mk7luke/DiffSentry/pull/164#issuecomment-5671134443
- Location: —

```markdown
<!-- DiffSentry Auto Release Notes -->
<!-- DiffSentry Auto Release Notes head: 10bd8b16e73c15524da8dbd47c8e66afbd16f154 -->

# Release Notes

### Bug fixes

- Fixed Dependabot pull requests remaining unmerged when `CodeQL`, `Dependency audit`, or `Label PRs` completed after `CI`.
- Fixed `Label PRs` runs triggered by `pull_request_target` failing to wake Dependabot auto-merge after they complete.

<sub>Drafted automatically once the review of `10bd8b1` came back green, every check passed and every review thread was resolved, and rewritten in place on later commits. Re-run by hand with `@diffsentry release-notes`, or set `release_notes.auto: false` in `.diffsentry.yaml` to stop.</sub>
```

---

## diffsentry[bot] · chat · 2026-09-14T21:02:41Z

- Source: https://github.com/mk7luke/DiffSentry/pull/163#issuecomment-5670767117
- Location: —

```markdown
<!-- DiffSentry Status -->
> :eyes: **DiffSentry** is reviewing this update... hang tight.
```

---

## diffsentry[bot] · chat · 2026-09-14T21:03:17Z

- Source: https://github.com/mk7luke/DiffSentry/pull/163#issuecomment-5670773993
- Location: —

```markdown
<!-- DiffSentry Sticky Status -->

# 📌 Status — last updated [`74bc328`](https://github.com/mk7luke/DiffSentry/commit/74bc3282c495e099ee8eceaa3bfc3da82a25fa4b)

🟢 **Approved**

| | |
|---|---|
| **Risk score** | 0/100 (Low) ▁ |
| **Unresolved threads** | 0 |
| **Failing checks** | 0 |
| **Pending checks** | 1 |
| **Files reviewed** | 1 |
| **Updated** | <code>2026-09-14 21:03Z</code> |

<sub>Live-updated by DiffSentry on every push. Use `@diffsentry ship` for a verdict, `@diffsentry timeline` for full history.</sub>
```

---

## diffsentry[bot] · chat · 2026-09-14T21:04:25Z

- Source: https://github.com/mk7luke/DiffSentry/pull/163#issuecomment-5670786560
- Location: —

```markdown
<!-- DiffSentry Auto Release Notes -->
<!-- DiffSentry Auto Release Notes head: 74bc3282c495e099ee8eceaa3bfc3da82a25fa4b -->

# Release Notes

### Bug fixes

- Fixed `dependabot-auto-merge.yml` skipping Dependabot pull requests when GitHub GraphQL reports the author as `app/dependabot` instead of `dependabot[bot]`.

<sub>Drafted automatically once the review of `74bc328` came back green, every check passed and every review thread was resolved, and rewritten in place on later commits. Re-run by hand with `@diffsentry release-notes`, or set `release_notes.auto: false` in `.diffsentry.yaml` to stop.</sub>
```

---

## diffsentry[bot] · chat · 2026-08-31T15:38:00Z

- Source: https://github.com/mk7luke/DiffSentry/pull/156#issuecomment-5480677517
- Location: —

```markdown
<!-- DiffSentry Status -->
> :eyes: **DiffSentry** is reviewing this update... hang tight.
```

---

## diffsentry[bot] · chat · 2026-08-31T15:38:41Z

- Source: https://github.com/mk7luke/DiffSentry/pull/156#issuecomment-5480686608
- Location: —

```markdown
<!-- DiffSentry Sticky Status -->

# 📌 Status — last updated [`520fc56`](https://github.com/mk7luke/DiffSentry/commit/520fc569280ba953b605f913e9052e815a7c4e55)

🟢 **Approved**

| | |
|---|---|
| **Risk score** | 7/100 (Low) ▁▁ |
| **Unresolved threads** | 0 |
| **Failing checks** | 0 |
| **Pending checks** | 1 |
| **Files reviewed** | 1 |
| **Updated** | <code>2026-09-07 15:38Z</code> |

<sub>Live-updated by DiffSentry on every push. Use `@diffsentry ship` for a verdict, `@diffsentry timeline` for full history.</sub>
```

---

## diffsentry[bot] · chat · 2026-08-31T15:39:45Z

- Source: https://github.com/mk7luke/DiffSentry/pull/156#issuecomment-5480700075
- Location: —

```markdown
<!-- DiffSentry Auto Release Notes -->
<!-- DiffSentry Auto Release Notes head: 58473596cab1e2056ebd59f6ab14cd3de7d841cc -->

# Release Notes

No user-visible changes. This updates the pinned TruffleHog action used by the repository's internal secret-scanning workflow.

<sub>Drafted automatically once the review of `5847359` came back green, every check passed and every review thread was resolved, and rewritten in place on later commits. Re-run by hand with `@diffsentry release-notes`, or set `release_notes.auto: false` in `.diffsentry.yaml` to stop.</sub>
```

---

## diffsentry[bot] · chat · 2026-09-07T15:37:19Z

- Source: https://github.com/mk7luke/DiffSentry/pull/159#issuecomment-5572900471
- Location: —

```markdown
<!-- DiffSentry Status -->
> ⏭️ **DiffSentry** — no reviewable changes. This pull request only contains 2 files DiffSentry skips, so there's nothing to review.

<details><summary>Ignored (minified, generated, or lockfile) (1)</summary>

- `web/package-lock.json`
</details>

<details><summary>No reviewable changes (1)</summary>

- `web/package.json`
</details>
```

---

## diffsentry[bot] · chat · 2026-09-07T15:38:55Z

- Source: https://github.com/mk7luke/DiffSentry/pull/159#issuecomment-5572916949
- Location: —

```markdown
<!-- DiffSentry Auto Release Notes -->
<!-- DiffSentry Auto Release Notes head: 59b7c63aed560d3a6854047122fc3ab7f6019ab5 -->

# Release Notes

No user-visible changes. This update only refreshes web application dependencies.

<sub>Drafted automatically once the review of `59b7c63` came back green, every check passed and every review thread was resolved, and rewritten in place on later commits. Re-run by hand with `@diffsentry release-notes`, or set `release_notes.auto: false` in `.diffsentry.yaml` to stop.</sub>
```

---

## diffsentry[bot] · chat · 2026-09-07T15:36:33Z

- Source: https://github.com/mk7luke/DiffSentry/pull/158#issuecomment-5572892171
- Location: —

```markdown
<!-- DiffSentry Status -->
> ⏭️ **DiffSentry** — no reviewable changes. This pull request only contains 2 files DiffSentry skips, so there's nothing to review.

<details><summary>Ignored (minified, generated, or lockfile) (1)</summary>

- `package-lock.json`
</details>

<details><summary>No reviewable changes (1)</summary>

- `package.json`
</details>
```

---

## diffsentry[bot] · chat · 2026-09-07T15:38:15Z

- Source: https://github.com/mk7luke/DiffSentry/pull/158#issuecomment-5572910072
- Location: —

```markdown
<!-- DiffSentry Auto Release Notes -->
<!-- DiffSentry Auto Release Notes head: c96c1e8fe9de3b4369120c4e578d218156a85b85 -->

# Release Notes

This release only updates development and runtime dependencies; it has no user-visible product changes in this diff.

<sub>Drafted automatically once the review of `c96c1e8` came back green, every check passed and every review thread was resolved, and rewritten in place on later commits. Re-run by hand with `@diffsentry release-notes`, or set `release_notes.auto: false` in `.diffsentry.yaml` to stop.</sub>
```

---

## diffsentry[bot] · chat · 2026-08-31T15:36:57Z

- Source: https://github.com/mk7luke/DiffSentry/pull/155#issuecomment-5480661705
- Location: —

```markdown
<!-- DiffSentry Status -->
> ⏭️ **DiffSentry** — no reviewable changes. This pull request only contains 2 files DiffSentry skips, so there's nothing to review.

<details><summary>Ignored (minified, generated, or lockfile) (1)</summary>

- `web/package-lock.json`
</details>

<details><summary>No reviewable changes (1)</summary>

- `web/package.json`
</details>
```

---

## diffsentry[bot] · chat · 2026-08-31T15:39:05Z

- Source: https://github.com/mk7luke/DiffSentry/pull/155#issuecomment-5480691700
- Location: —

```markdown
<!-- DiffSentry Auto Release Notes -->
<!-- DiffSentry Auto Release Notes head: 9c696f553e6a38374c1247a6ba12999e7a6a30bf -->

# Release Notes

No user-visible changes. This PR updates frontend dependencies only.

<sub>Drafted automatically once the review of `9c696f5` came back green, every check passed and every review thread was resolved, and rewritten in place on later commits. Re-run by hand with `@diffsentry release-notes`, or set `release_notes.auto: false` in `.diffsentry.yaml` to stop.</sub>
```

---

## diffsentry[bot] · chat · 2026-08-31T15:36:35Z

- Source: https://github.com/mk7luke/DiffSentry/pull/154#issuecomment-5480655647
- Location: —

```markdown
<!-- DiffSentry Status -->
> ⏭️ **DiffSentry** — no reviewable changes. This pull request only contains 2 files DiffSentry skips, so there's nothing to review.

<details><summary>Ignored (minified, generated, or lockfile) (1)</summary>

- `package-lock.json`
</details>

<details><summary>No reviewable changes (1)</summary>

- `package.json`
</details>
```

---

## diffsentry[bot] · chat · 2026-08-31T15:38:03Z

- Source: https://github.com/mk7luke/DiffSentry/pull/154#issuecomment-5480678281
- Location: —

```markdown
<!-- DiffSentry Auto Release Notes -->
<!-- DiffSentry Auto Release Notes head: 1a7efd0be10079965139b643e9e69381fa660210 -->

# Release Notes

This release contains dependency updates only and has no user-visible changes.

<sub>Drafted automatically once the review of `1a7efd0` came back green, every check passed and every review thread was resolved, and rewritten in place on later commits. Re-run by hand with `@diffsentry release-notes`, or set `release_notes.auto: false` in `.diffsentry.yaml` to stop.</sub>
```

---

## diffsentry[bot] · chat · 2026-08-22T06:53:56Z

- Source: https://github.com/mk7luke/DiffSentry/pull/145#issuecomment-5378741578
- Location: —

```markdown
<!-- DiffSentry Status -->
> :white_check_mark: **DiffSentry** has completed the review — Looks good!
```

---

## diffsentry[bot] · chat · 2026-08-22T06:54:26Z

- Source: https://github.com/mk7luke/DiffSentry/pull/145#issuecomment-5378748332
- Location: —

```markdown
<!-- DiffSentry Sticky Status -->

# 📌 Status — last updated [`876b275`](https://github.com/mk7luke/DiffSentry/commit/876b2750fa03406279878554f0ba00faf2c3fe49)

🟢 **Approved**

| | |
|---|---|
| **Risk score** | 0/100 (Low) ▁▁ |
| **Unresolved threads** | 0 |
| **Failing checks** | 0 |
| **Pending checks** | 1 |
| **Files reviewed** | 1 (2 skipped) |
| **Updated** | <code>2026-09-05 04:30Z</code> |

<sub>Live-updated by DiffSentry on every push. Use `@diffsentry ship` for a verdict, `@diffsentry timeline` for full history.</sub>
```

---

## diffsentry[bot] · chat · 2026-08-22T06:54:33Z

- Source: https://github.com/mk7luke/DiffSentry/pull/145#issuecomment-5378750082
- Location: —

```markdown
<!-- DiffSentry Auto Release Notes -->
<!-- DiffSentry Auto Release Notes head: 876b2750fa03406279878554f0ba00faf2c3fe49 -->

# Release Notes

### Bug fixes

- Fixed a case where editing a user-authored comment containing a forged `<!-- DiffSentry Walkthrough -->` marker could dispatch Finishing Touches commands such as `@diffsentry autofix` to a pull request branch.

<sub>Drafted automatically once the review of `876b275` came back green, every check passed and every review thread was resolved, and rewritten in place on later commits. Re-run by hand with `@diffsentry release-notes`, or set `release_notes.auto: false` in `.diffsentry.yaml` to stop.</sub>
```

---

## diffsentry[bot] · chat · 2026-08-24T15:37:01Z

- Source: https://github.com/mk7luke/DiffSentry/pull/149#issuecomment-5397580081
- Location: —

```markdown
<!-- DiffSentry Status -->
> ⏭️ **DiffSentry** — no reviewable changes. This pull request only contains 2 files DiffSentry skips, so there's nothing to review.

<details><summary>Ignored (minified, generated, or lockfile) (1)</summary>

- `web/package-lock.json`
</details>

<details><summary>No reviewable changes (1)</summary>

- `web/package.json`
</details>
```

---

## diffsentry[bot] · chat · 2026-08-24T15:39:01Z

- Source: https://github.com/mk7luke/DiffSentry/pull/149#issuecomment-5397604219
- Location: —

```markdown
<!-- DiffSentry Auto Release Notes -->
<!-- DiffSentry Auto Release Notes head: 62075f4c414b94f444aa452a1ff21713f1f0fbf6 -->

# Release Notes

No user-visible changes. This PR updates web build and sanitization dependencies only.

<sub>Drafted automatically once the review of `62075f4` came back green, every check passed and every review thread was resolved, and rewritten in place on later commits. Re-run by hand with `@diffsentry release-notes`, or set `release_notes.auto: false` in `.diffsentry.yaml` to stop.</sub>
```

---

## diffsentry[bot] · chat · 2026-08-24T15:36:40Z

- Source: https://github.com/mk7luke/DiffSentry/pull/148#issuecomment-5397575657
- Location: —

```markdown
<!-- DiffSentry Status -->
> ⏭️ **DiffSentry** — no reviewable changes. This pull request only contains 2 files DiffSentry skips, so there's nothing to review.

<details><summary>Ignored (minified, generated, or lockfile) (1)</summary>

- `package-lock.json`
</details>

<details><summary>No reviewable changes (1)</summary>

- `package.json`
</details>
```

---

## diffsentry[bot] · chat · 2026-08-24T15:38:42Z

- Source: https://github.com/mk7luke/DiffSentry/pull/148#issuecomment-5397600546
- Location: —

```markdown
<!-- DiffSentry Auto Release Notes -->
<!-- DiffSentry Auto Release Notes head: e1a6f1066156012af33b79ac9c6c68095c001a46 -->

# Release Notes

This release contains dependency updates only and has no user-visible changes.

<sub>Drafted automatically once the review of `e1a6f10` came back green, every check passed and every review thread was resolved, and rewritten in place on later commits. Re-run by hand with `@diffsentry release-notes`, or set `release_notes.auto: false` in `.diffsentry.yaml` to stop.</sub>
```

---

## diffsentry[bot] · chat · 2026-08-28T18:46:57Z

- Source: https://github.com/mk7luke/DiffSentry/pull/152#issuecomment-5456431649
- Location: —

```markdown
<!-- DiffSentry Status -->
> :white_check_mark: **DiffSentry** has completed the review — Looks good!
```

---

## diffsentry[bot] · chat · 2026-08-28T18:47:35Z

- Source: https://github.com/mk7luke/DiffSentry/pull/152#issuecomment-5456437838
- Location: —

```markdown
<!-- DiffSentry Sticky Status -->

# 📌 Status — last updated [`2177b7b`](https://github.com/mk7luke/DiffSentry/commit/2177b7b205aa974f913db38391fe21102d7cd561)

🟢 **Approved**

| | |
|---|---|
| **Risk score** | 0/100 (Low) ▁ |
| **Unresolved threads** | 0 |
| **Failing checks** | 0 |
| **Pending checks** | 1 |
| **Files reviewed** | 4 |
| **Updated** | <code>2026-08-28 18:47Z</code> |

<sub>Live-updated by DiffSentry on every push. Use `@diffsentry ship` for a verdict, `@diffsentry timeline` for full history.</sub>
```

---

## diffsentry[bot] · chat · 2026-08-28T20:41:26Z

- Source: https://github.com/mk7luke/DiffSentry/pull/152#issuecomment-5457543822
- Location: —

```markdown
<!-- DiffSentry Auto Release Notes -->
<!-- DiffSentry Auto Release Notes head: 2177b7b205aa974f913db38391fe21102d7cd561 -->

# Release Notes

### Improvements

- `npm run setup` now rejects blank or non-numeric `GITHUB_APP_ID` entries and prompts again with guidance to use the GitHub App ID.

### Bug fixes

- Fixed `npm run setup` accepting GitHub Client IDs or app slugs in `GITHUB_APP_ID`, then reporting the generated `.env` file as valid.

### Breaking changes

- `GITHUB_APP_ID` must now contain only digits in setup validation, configuration loading, and diagnostics. Replace Client IDs or app slugs with the numeric App ID from your GitHub App settings.

<sub>Drafted automatically once the review of `2177b7b` came back green, every check passed and every review thread was resolved, and rewritten in place on later commits. Re-run by hand with `@diffsentry release-notes`, or set `release_notes.auto: false` in `.diffsentry.yaml` to stop.</sub>
```

---

## diffsentry[bot] · chat · 2026-08-28T20:32:56Z

- Source: https://github.com/mk7luke/DiffSentry/pull/153#issuecomment-5457469882
- Location: —

```markdown
<!-- DiffSentry Status -->
> :white_check_mark: **DiffSentry** has completed the review — Looks good!
```

---

## diffsentry[bot] · chat · 2026-08-28T20:33:39Z

- Source: https://github.com/mk7luke/DiffSentry/pull/153#issuecomment-5457476293
- Location: —

```markdown
<!-- DiffSentry Sticky Status -->

# 📌 Status — last updated [`27cf08e`](https://github.com/mk7luke/DiffSentry/commit/27cf08e51818674fe48bc6275b971ed355efc947)

🟢 **Approved**

| | |
|---|---|
| **Risk score** | 0/100 (Low) ▁ |
| **Unresolved threads** | 0 |
| **Failing checks** | 0 |
| **Pending checks** | 1 |
| **Files reviewed** | 4 |
| **Updated** | <code>2026-08-28 20:33Z</code> |

<sub>Live-updated by DiffSentry on every push. Use `@diffsentry ship` for a verdict, `@diffsentry timeline` for full history.</sub>
```

---

## diffsentry[bot] · chat · 2026-08-28T20:33:49Z

- Source: https://github.com/mk7luke/DiffSentry/pull/153#issuecomment-5457477756
- Location: —

```markdown
<!-- DiffSentry Auto Release Notes -->
<!-- DiffSentry Auto Release Notes head: 27cf08e51818674fe48bc6275b971ed355efc947 -->

# Release Notes

### Improvements

- Interactive setup now rejects non-numeric GitHub App IDs and prompts again, with guidance to use the App ID rather than the Client ID.
- Environment validation now reports when `GITHUB_APP_ID` contains a non-numeric value.

### Bug fixes

- Fixed configuration and diagnostics accepting or checking GitHub App IDs inconsistently by using the same numeric validation everywhere.

### Breaking changes

- `GITHUB_APP_ID` must now contain only digits. Deployments using a GitHub Client ID or another non-numeric value must replace it with the numeric App ID from the GitHub App settings page.

<sub>Drafted automatically once the review of `27cf08e` came back green, every check passed and every review thread was resolved, and rewritten in place on later commits. Re-run by hand with `@diffsentry release-notes`, or set `release_notes.auto: false` in `.diffsentry.yaml` to stop.</sub>
```

---

## diffsentry[bot] · chat · 2026-08-28T06:22:46Z

- Source: https://github.com/mk7luke/DiffSentry/pull/150#issuecomment-5449186485
- Location: —

```markdown
<!-- DiffSentry Status -->
> :white_check_mark: **DiffSentry** has completed the review — Looks good!
```

---

## diffsentry[bot] · chat · 2026-08-28T06:23:28Z

- Source: https://github.com/mk7luke/DiffSentry/pull/150#issuecomment-5449191810
- Location: —

```markdown
<!-- DiffSentry Sticky Status -->

# 📌 Status — last updated [`a5447a6`](https://github.com/mk7luke/DiffSentry/commit/a5447a675aef4d85814bf47020cb808b0ca90a3c)

🟢 **Approved**

| | |
|---|---|
| **Risk score** | 0/100 (Low) ▁ |
| **Unresolved threads** | 0 |
| **Failing checks** | 0 |
| **Pending checks** | 1 |
| **Files reviewed** | 5 |
| **Updated** | <code>2026-08-28 06:23Z</code> |

<sub>Live-updated by DiffSentry on every push. Use `@diffsentry ship` for a verdict, `@diffsentry timeline` for full history.</sub>
```

---

## diffsentry[bot] · chat · 2026-08-28T06:23:37Z

- Source: https://github.com/mk7luke/DiffSentry/pull/150#issuecomment-5449192980
- Location: —

```markdown
<!-- DiffSentry Auto Release Notes -->
<!-- DiffSentry Auto Release Notes head: a5447a675aef4d85814bf47020cb808b0ca90a3c -->

# Release Notes

### Improvements

- Diagnostics now reports `github.app_id` as failed when `GITHUB_APP_ID` is missing or contains non-numeric characters, with guidance to use the numeric App ID instead of the Client ID.

### Bug fixes

- Fixed GitHub App authentication failing later with an opaque 401 when `GITHUB_APP_ID` contained a prefix, app slug, or OAuth Client ID. The configured ID is now trimmed before use.

### Breaking changes

- Startup now rejects non-numeric `GITHUB_APP_ID` values. Deployments using an OAuth Client ID, app slug, or other non-digit value must replace it with the numeric App ID from the GitHub App settings page.

<sub>Drafted automatically once the review of `a5447a6` came back green, every check passed and every review thread was resolved, and rewritten in place on later commits. Re-run by hand with `@diffsentry release-notes`, or set `release_notes.auto: false` in `.diffsentry.yaml` to stop.</sub>
```

---
