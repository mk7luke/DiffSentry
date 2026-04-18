# CodeRabbit Comment Format Reference

Anatomy of CodeRabbit's PR comments, derived from `jasonkneen/codesurf#5`. Use as
the spec when modifying DiffSentry's `src/walkthrough.ts`, `src/ai/prompt.ts`,
`src/ai/parse.ts`, and `src/reviewer.ts` for visual/structural parity.

Raw reference data lives next to this file:
- `coderabbit-walkthroughs.md` — issue-comment bodies (walkthrough + status + chat replies)
- `coderabbit-reviews.md` — review bodies (the structured "Actionable comments posted" wrapper)
- `coderabbit-inline-comments.md` — every inline review comment

---

## Surface 1: Walkthrough (issue comment)

A single issue comment posted on PR open / `@bot summary`. Idempotent — edited in place on subsequent updates.

**Outer structure** (top to bottom):

1. HTML markers — `<!-- This is an auto-generated comment: summarize by coderabbit.ai -->` and `<!-- walkthrough_start --> ... <!-- walkthrough_end -->` wrapping the walkthrough body. Used for re-locate-and-edit.
2. Optional pause/status notice block as `> [!NOTE]` blockquote with management commands.
3. `<details><summary>📝 Walkthrough</summary>` — collapsed by default, contains:
   - `## Walkthrough` — 1–2 sentence prose summary in past tense (e.g. "Adds cross-platform build/distribution scripts...").
   - `## Changes` — table with `|Cohort / File(s)|Summary|` columns. **Files are grouped into thematic cohorts**, not one row per file. Cohort label is bold; files listed below with `<br>` between paths in backticks. Example row: `|**Build & Distribution** <br> \`package.json\`, \`README.md\`|Reworked npm scripts...|`.
   - `## Sequence Diagram(s)` (note plural with `(s)`) — one or more mermaid `sequenceDiagram` blocks.
   - `## Estimated code review effort` — single line: `🎯 N (Word) | ⏱️ ~M minutes` where N is 1–5, Word is `Trivial|Simple|Moderate|Complex|Very Complex`, M is integer minute estimate.
   - `## Possibly related PRs` — bullets like `- org/repo#N — short reason`.
   - `## Poem` — `> 🐇` followed by 4–6 line poem in blockquote, each line ending with two trailing spaces for line break.
4. Separate sibling `<details>` blocks (NOT inside the walkthrough collapse):
   - `🚥 Pre-merge checks | ✅ N | ❌ M` — table of failed checks, then nested `<details>` with passed checks. Includes `<sub>✏️ Tip: ...</sub>` footer.
   - `✨ Finishing Touches` — checkboxes for `Generate unit tests (beta)` etc., each with a UUID `checkboxId` HTML comment.
   - Tips footer: `❤️ Share` collapse with social links, then `<sub>Comment @bot help...</sub>`.
5. `<!-- internal state start -->` containing a huge base64 `<!-- ... -->` blob — CodeRabbit stores serialized review state here for incremental reviews. (DiffSentry doesn't need this exact mechanism but should round-trip enough state to do incremental reviews.)

**Severity / completion pattern**: walkthrough is informational, never sets commit status by itself.

---

## Surface 2: Review summary (PR review body, state = `COMMENTED`)

The review object's `body` field — accompanies the inline comments posted in the same review.

**Structure**:

1. Header: `**Actionable comments posted: N**` (bold, no preamble). N is count of *non-nitpick* inline comments.
2. `<details><summary>🧹 Nitpick comments (N)</summary><blockquote>` — wraps all nitpicks so they don't dominate. Inside:
   - Per-file: `<details><summary>path/to/file.ts (N)</summary><blockquote>` (file path + count of nitpicks in that file)
     - Per-comment block: `\`L1-L2\`: **Bold title sentence.**` then prose. Followed by:
       - `<details><summary>♻️ Suggested fix [optional sub-label]</summary>` with a ```diff fence
       - `<details><summary>🤖 Prompt for AI Agents</summary>` with a ```text block in the format `Verify each finding against the current code and only fix it if needed.\n\nIn @path at line N, <imperative instructions referencing identifier names>.`
3. After the nitpicks: `<details><summary>🤖 Prompt for all review comments with AI agents</summary>` — a single bulk-prompt block listing every inline finding with file/line headers. This is the "fix everything in one go" payload for IDE agents.
4. `<details><summary>🪄 Autofix (Beta)</summary>` — checkboxes to "Push a commit to this branch" and "Create a new PR with the fixes", each with a `checkboxId` UUID.
5. `---` divider
6. `<details><summary>ℹ️ Review info</summary>` containing nested:
   - `<details><summary>⚙️ Run configuration</summary>` — `**Configuration used**: defaults`, `**Review profile**: CHILL|ASSERTIVE`, `**Plan**: ...`, `**Run ID**: \`<uuid>\``
   - `<details><summary>📥 Commits</summary>` — `Reviewing files that changed from the base of the PR and between <sha1> and <sha2>.`
   - `<details><summary>⛔ Files ignored due to path filters (N)</summary>` — bullets like `* \`package-lock.json\` is excluded by \`!**/package-lock.json\``
   - `<details><summary>📒 Files selected for processing (N)</summary>` — bullet list of paths
   - `<details><summary>💤 Files with no reviewable changes (N)</summary>`
   - `<details><summary>✅ Files skipped from review due to trivial changes (N)</summary>`
   - `<details><summary>🚧 Files skipped from review as they are similar to previous changes (N)</summary>` (for incremental reviews)
7. Trailing HTML marker: `<!-- This is an auto-generated comment by CodeRabbit for review status -->`

For *incremental* reviews where there's nothing new, the review body is empty (just the auto-generated marker).

---

## Surface 3: Inline review comment (one per finding, on a specific line)

Posted via the PR review-comments endpoint. Each comment is a single Markdown body.

**Structure**:

1. Header line: `_<icon><Type>_ | _<color><Severity>_`
   - Type vocabulary (italicized): `⚠️ Potential issue`, `🛠️ Refactor suggestion`, `🧹 Nitpick`, `📝 Documentation`, `🔒 Security`
   - Severity vocabulary: `🟢 Trivial`, `🟡 Minor`, `🟠 Major`, `🔴 Critical`
   - Separator is ` | ` not ` · `
2. Optional `<details><summary>🧩 Analysis chain</summary>` showing shell commands the reviewer ran for verification, with `Repository: <owner>/<repo>` and `Length of output: <bytes>` per script. (DiffSentry doesn't run shell — skip this surface or repurpose as "Reasoning" if a thinking trace is available.)
3. `**Title sentence in bold.**` (single sentence, ends with period)
4. Body: 1–4 paragraphs of prose. Often includes numbered or bulleted reasoning (`1. ... 2. ...`). May include inline code references in backticks and references to other files (e.g. `src/main/ipc/fs.ts:63`).
5. `<details><summary>🔧 Proposed fix</summary>` OR `<details><summary>♻️ Suggested fix [optional sub-label]</summary>` containing a ```diff block (preferred over ```suggestion when the change spans context lines or modifies imports).
6. `<details><summary>🤖 Prompt for AI Agents</summary>` containing a ```text block with the standard preamble + imperative instruction. Format:
   ```
   Verify each finding against the current code and only fix it if needed.

   In @<path> around lines A - B, <imperative description naming the symbols/variables/functions involved>; <how to fix>; <optional secondary fix>; <reference to identifiers for context>.
   ```
   The instruction must mention the identifiers by name and tell the agent what to do step-by-step. This is the *most differentiating* CodeRabbit feature — it makes their comments directly consumable by Claude/Cursor/Copilot agents.
7. Optional fingerprint comment: `<!-- fingerprinting:phantom:poseidon:hawk:<uuid> -->` for dedup across reviews.
8. Trailing marker: `<!-- This is an auto-generated reply by CodeRabbit -->`

**Severity → review state mapping** (inferred):
- Any `🔴 Critical` or `⚠️ Potential issue` ≥ Major → review state `CHANGES_REQUESTED`, status `failure`
- Only nitpicks/refactors → review state `COMMENTED`, status `success`
- No findings → review state `APPROVED`, status `success`

---

## Surface 4: Status / control issue comments

Posted as separate issue comments (not part of the review body):

- **Initial in-progress**: `> :eyes: **DiffSentry** is reviewing this pull request... hang tight.` (DiffSentry already does this — keep the icon/format.)
- **Final status**: `> :x: **DiffSentry** has completed the review — Changes requested` / `:white_check_mark: ... — Looks good` / `:warning: ... — Comments only`. (DiffSentry already does this.)
- **Review paused**: `> [!NOTE]` blockquote with `## Reviews paused` and management command list — `@bot resume`, `@bot review`. Includes checkbox UI rows.
- **Chat replies**: `<details><summary>✅ Actions performed</summary>` followed by the action description. Always wrap chat-command acknowledgements in this collapse.

---

## Severity & icon cheat sheet

| Use | Glyph | Markdown |
|---|---|---|
| Potential issue (bug) | ⚠️ | `_⚠️ Potential issue_` |
| Refactor suggestion | 🛠️ | `_🛠️ Refactor suggestion_` |
| Nitpick | 🧹 | `_🧹 Nitpick_` |
| Documentation | 📝 | `_📝 Documentation_` |
| Security | 🔒 | `_🔒 Security_` |
| Trivial | 🟢 | `_🟢 Trivial_` |
| Minor | 🟡 | `_🟡 Minor_` |
| Major | 🟠 | `_🟠 Major_` |
| Critical | 🔴 | `_🔴 Critical_` |
| Walkthrough | 📝 | `📝 Walkthrough` |
| Sequence diagrams | (none) | `## Sequence Diagram(s)` |
| Effort | 🎯⏱️ | `🎯 N (Word) \| ⏱️ ~M minutes` |
| Pre-merge | 🚥 | `🚥 Pre-merge checks` |
| Finishing touches | ✨ | `✨ Finishing Touches` |
| Suggested fix | ♻️ / 🔧 | `♻️ Suggested fix` |
| AI agent prompt | 🤖 | `🤖 Prompt for AI Agents` |
| Autofix | 🪄 | `🪄 Autofix (Beta)` |
| Run info | ℹ️ | `ℹ️ Review info` |
| Run config | ⚙️ | `⚙️ Run configuration` |
| Commits | 📥 | `📥 Commits` |
| Files ignored | ⛔ | `⛔ Files ignored due to path filters` |
| Files processed | 📒 | `📒 Files selected for processing` |
| Files no changes | 💤 | `💤 Files with no reviewable changes` |
| Files trivial-skip | ✅ | `✅ Files skipped from review due to trivial changes` |
| Files similar-skip | 🚧 | `🚧 Files skipped from review as they are similar to previous changes` |

---

## DiffSentry parity gap (current vs target)

Based on `tests/e2e/runs/2026-04-18T18-52-09-787Z_divide-by-zero/` baseline.

### Walkthrough
| Feature | Current DiffSentry | CodeRabbit | Action |
|---|---|---|---|
| HTML markers | `<!-- DiffSentry Walkthrough -->` | `<!-- walkthrough_start/end -->` + per-section markers | Add stable markers per section for incremental edits |
| Walkthrough collapse | ✅ `<details><summary>Walkthrough</summary>` | ✅ with 📝 emoji | Add 📝 |
| Prose summary | ✅ | ✅ | Match — make sure it's past tense, 1–2 sentences |
| Changes table | Per-file rows | **Cohort grouping** | Refactor `walkthrough.ts` prompt to ask AI to group files into cohorts |
| Sequence Diagram(s) | Singular header | Plural with `(s)` | Trivial rename |
| Effort | `🔵🔵⚪⚪⚪ (2/5)` dots | `🎯 N (Word) \| ⏱️ ~M minutes` | Replace renderer + extend AI to estimate minutes |
| Possibly related PRs | ❌ | ✅ | New surface — query `pulls?state=open` and prompt AI to filter |
| Poem | ❌ (config option exists per README) | ✅ | Verify the existing poem path produces output |
| Pre-merge checks block | Posts as separate comment per `pre-merge.ts` | Embedded in walkthrough as `<details>` | Move into walkthrough as nested collapse |
| Finishing touches checkboxes | ❌ | ✅ | New surface — checkbox-driven trigger for generate-tests, etc. (replace existing chat-only flow) |
| Tips footer | ❌ | ✅ | Add `<sub>Comment @diffsentry help…</sub>` |
| Internal state | ❌ | base64 blob | Add a small JSON state encoded in HTML comment for incremental review tracking |

### Review summary body
| Feature | Current | CodeRabbit | Action |
|---|---|---|---|
| Header `Actionable comments posted: N` | ❌ (free-form summary) | ✅ | Replace summary with this header |
| Free-form summary | ✅ | ❌ (only header + structured blocks) | Drop or move to walkthrough |
| Nitpicks collapse | ❌ | ✅ collapsed by default | Implement: split AI output into nitpicks vs actionable, render collapsed |
| Per-file nitpick grouping | ❌ | ✅ | Group nitpicks by path inside the collapse |
| Bulk "Prompt for all review comments" | ❌ | ✅ | Generate from inline-comment metadata at review-post time |
| `🪄 Autofix (Beta)` checkboxes | Chat command exists | Checkbox UI | Add checkbox affordance + handler that maps to existing autofix |
| `ℹ️ Review info` block | ❌ | ✅ (config, profile, run id, commits, file lists) | Wire reviewer state into a render step |
| `⛔ Files ignored / 📒 Files selected / 💤 / ✅ / 🚧` | ❌ | ✅ | Expose path-filter and skip decisions in the review state, render lists |

### Inline comments
| Feature | Current | CodeRabbit | Action |
|---|---|---|---|
| Header format | `⚠️ **issue** · 🟠 major` | `_⚠️ Potential issue_ \| _🟠 Major_` | Update prompt + parser/renderer |
| Type vocabulary | `issue/suggestion/nitpick` | `Potential issue / Refactor suggestion / Nitpick / Documentation / Security` | Expand enum, update prompt |
| Bold title sentence | ❌ (prose only) | ✅ first line bold | Add to prompt + renderer |
| Diff vs suggestion blocks | Only ```suggestion | Mostly ```diff in `🔧 Proposed fix` collapse | Switch to `<details>` + ```diff for multi-line changes |
| `🤖 Prompt for AI Agents` | ❌ | ✅ on every comment | Generate at parse time — synthesize an imperative instruction referencing the symbols mentioned in the body |
| Fingerprint dedup hash | ❌ | `<!-- fingerprinting:... -->` | Add stable hash from path + line + body shape for dedup across incremental reviews |
| Trailing marker | ❌ | `<!-- This is an auto-generated reply by DiffSentry -->` | Add |

### Incremental review behavior
- CodeRabbit auto-pauses after N commits (`auto_pause_after_reviewed_commits`, configurable). DiffSentry already supports this — verify the pause notice format matches Surface 4.
- CodeRabbit emits `🚧 Files skipped from review as they are similar to previous changes` — requires diffing the new commits against the previously-reviewed snapshot. DiffSentry's incremental review already does this; just needs to surface the file list.

---

## How to evolve DiffSentry against this spec

1. Pick one row from the gap table.
2. Find a baseline run-transcript that exhibits the gap.
3. Patch the relevant module (`walkthrough.ts` for walkthrough, `ai/prompt.ts` for what AI is asked to produce, `ai/parse.ts` for how response is destructured, `reviewer.ts` for orchestration).
4. Add or update an e2e scenario whose `expect.walkthroughContains` / `expect.issueCommentContains` / `expect.inlineCommentsContain` assertions encode the new format.
5. Commit, redeploy DiffSentry on the host machine, re-run the scenario, confirm pass.

The reference dumps in this folder are the source of truth for what "good" looks like.
