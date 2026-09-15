# Inline comments

## diffsentry[bot] · inline · 2026-08-22T06:55:50Z

- Source: https://github.com/mk7luke/DiffSentry/pull/146#discussion_r3835448654
- Location: tests/unit/markdown.test.ts:?

```markdown
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
```

---

## diffsentry[bot] · inline · 2026-08-22T06:55:50Z

- Source: https://github.com/mk7luke/DiffSentry/pull/146#discussion_r3835448692
- Location: src/dashboard/markdown.ts:76

```markdown
_🔒 Security_ | _🟡 Minor_

**Sanitize the parser-error fallback before returning HTML.**

The catch path returns HTML directly, including its generated `<br>` elements, rather than passing it through `sanitizeHtml`. While the current escaping order prevents attacker-controlled tags from being interpreted, this creates a second output construction path outside the stated allowlist boundary and can become unsafe if this fallback is modified later (for example, to preserve a formatting tag or link). Build the escaped fallback, then sanitize it with `SANITIZE_OPTIONS` just like the normal `marked` output.

<details>
<summary>🔧 Proposed fix</summary>

```diff
return sanitizeHtml(
  input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n/g, "<br>"),
  SANITIZE_OPTIONS,
);
```

</details>

<details>
<summary>🤖 Prompt for AI Agents</summary>

```text
Verify each finding against the current code and only fix it if needed.

In src/dashboard/markdown.ts around line 53, route the escaped plaintext fallback in `renderMarkdown` through `sanitizeHtml` using `SANITIZE_OPTIONS`; preserve newline-to-`<br>` formatting while ensuring every returned HTML path crosses the same allowlist sanitizer.
```

</details>

<!-- diffsentry-fingerprint:09be0e0cffd8 -->

<!-- diffsentry-severity:minor -->

<!-- This is an auto-generated reply by DiffSentry -->
```

---

## diffsentry[bot] · inline · 2026-08-22T06:59:43Z

- Source: https://github.com/mk7luke/DiffSentry/pull/146#discussion_r3835459274
- Location: tests/unit/markdown.test.ts:?

```markdown
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
```

---

## diffsentry[bot] · inline · 2026-08-22T07:04:02Z

- Source: https://github.com/mk7luke/DiffSentry/pull/146#discussion_r3835470398
- Location: src/dashboard/markdown.ts:1

```markdown
_⚠️ Potential issue_ | _🟠 Major_

**The claimed `input[type=checkbox]` restriction is not enforced by the sanitizer configuration.**

`SANITIZE_OPTIONS` allows the `input` tag and its `type` attribute without constraining the attribute value, so raw markdown may retain inputs of types other than `checkbox`. The PR description specifically presents the allowed surface as `input[type=checkbox]`.

<details>
<summary>🤖 Prompt for AI Agents</summary>

```text
Verify each finding against the current code and only fix it if needed.

Reconcile the PR description with the actual diff. The claimed `input[type=checkbox]` restriction is not enforced by the sanitizer configuration. `SANITIZE_OPTIONS` allows the `input` tag and its `type` attribute without constraining the attribute value, so raw markdown may retain inputs of types other than `checkbox`. The PR description specifically presents the allowed surface as `input[type=checkbox]`.
```

</details>

<!-- diffsentry-fingerprint:a4f380a24bb7 -->

<!-- diffsentry-severity:major -->

<!-- This is an auto-generated reply by DiffSentry -->
```

---

## diffsentry[bot] · inline · 2026-08-22T08:19:17Z

- Source: https://github.com/mk7luke/DiffSentry/pull/146#discussion_r3835601409
- Location: src/dashboard/markdown.ts:1

```markdown
_⚠️ Potential issue_ | _🟠 Major_

**The claimed http/https/mailto-only URL policy may still permit data: image sources.**

> 🤔 _Medium confidence_ — verify against intent before acting.

`SANITIZE_OPTIONS` sets `allowedSchemes` but does not override `sanitize-html`'s per-tag scheme configuration. sanitize-html permits `data:` for `img` by default, so `<img src="data:...">` may survive despite the PR description's claim that URL schemes are restricted to http/https/mailto; the added data-URL test covers only an `<a>` element.

<details>
<summary>🤖 Prompt for AI Agents</summary>

```text
Verify each finding against the current code and only fix it if needed.

Reconcile the PR description with the actual diff. The claimed http/https/mailto-only URL policy may still permit data: image sources. `SANITIZE_OPTIONS` sets `allowedSchemes` but does not override `sanitize-html`'s per-tag scheme configuration. sanitize-html permits `data:` for `img` by default, so `<img src="data:...">` may survive despite the PR description's claim that URL schemes are restricted to http/https/mailto; the added data-URL test covers only an `<a>` element.
```

</details>

<!-- diffsentry-fingerprint:fd0c61a43c14 -->

<!-- diffsentry-severity:major -->

<!-- This is an auto-generated reply by DiffSentry -->
```

---

## diffsentry[bot] · inline · 2026-08-22T08:39:32Z

- Source: https://github.com/mk7luke/DiffSentry/pull/146#discussion_r3835636520
- Location: tests/unit/markdown.test.ts:?

```markdown
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
```

---

## diffsentry[bot] · inline · 2026-08-22T08:39:33Z

- Source: https://github.com/mk7luke/DiffSentry/pull/146#discussion_r3835636534
- Location: tests/unit/markdown.test.ts:?

```markdown
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
```

---

## diffsentry[bot] · inline · 2026-09-05T04:31:49Z

- Source: https://github.com/mk7luke/DiffSentry/pull/147#discussion_r3939446548
- Location: src/learnings.ts:1

```markdown
_⚠️ Potential issue_ | _🟠 Major_

**The new learnings path validation breaks the documented global learnings scope.**

`GLOBAL_REPO` is `"*"`, but `LearningsStore.filePath()` now requires both segments to pass `validRepoSegment`; `"*"` fails that check and `repo.split("/")` provides no repo-name segment. Consequently global `getLearnings()` calls are swallowed as empty reads and global writes/removals throw, an unmentioned behavioral regression in the claimed defensive validation.

<details>
<summary>🤖 Prompt for AI Agents</summary>

```text
Verify each finding against the current code and only fix it if needed.

Reconcile the PR description with the actual diff. The new learnings path validation breaks the documented global learnings scope. `GLOBAL_REPO` is `"*"`, but `LearningsStore.filePath()` now requires both segments to pass `validRepoSegment`; `"*"` fails that check and `repo.split("/")` provides no repo-name segment. Consequently global `getLearnings()` calls are swallowed as empty reads and global writes/removals throw, an unmentioned behavioral regression in the claimed defensive validation.
```

</details>

<!-- diffsentry-fingerprint:d7bec198a7ba -->

<!-- diffsentry-severity:major -->

<!-- This is an auto-generated reply by DiffSentry -->
```

---
