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
