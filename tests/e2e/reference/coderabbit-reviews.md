## Review state=COMMENTED submitted=2026-04-16T06:41:47Z

**Actionable comments posted: 9**

<details>
<summary>🧹 Nitpick comments (3)</summary><blockquote>

<details>
<summary>src/renderer/src/hooks/useMCPServers.ts (1)</summary><blockquote>

`21-21`: **Inconsistent home directory resolution with MCPPanel.tsx.**

This file omits the `__HOME__` fallback that `MCPPanel.tsx:119` uses as the first priority. Both files read the same config path (`~/.contex/mcp-server.json`), so the resolution logic should be consistent.


<details>
<summary>♻️ Suggested fix to align with MCPPanel.tsx</summary>

```diff
-    const home = (window as any).process?.env?.HOME ?? (window as any).process?.env?.USERPROFILE ?? ''
+    const home = (window as any).__HOME__ ?? (window as any).process?.env?.HOME ?? (window as any).process?.env?.USERPROFILE ?? ''
```
</details>

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against the current code and only fix it if needed.

In `@src/renderer/src/hooks/useMCPServers.ts` at line 21, The home-directory
resolution in useMCPServers.ts (variable `home`) must match MCPPanel.tsx by
checking the `__HOME__` fallback first; update the `home` assignment in
useMCPServers.ts to prefer `(window as any).__HOME__` before falling back to
`(window as any).process?.env?.HOME` and `(window as
any).process?.env?.USERPROFILE` so both files read `~/.contex/mcp-server.json`
the same way and remain consistent with `MCPPanel.tsx`.
```

</details>

</blockquote></details>
<details>
<summary>src/main/ipc/canvas.ts (1)</summary><blockquote>

`468-468`: **Home directory resolution differs from established pattern in `fs.ts`.**

The pattern in `src/main/ipc/fs.ts:63` uses `app.getPath('home')` as the primary method:
```typescript
const resolveHome = (): string => app.getPath('home') || process.env.HOME || process.env.USERPROFILE || homedir()
```

Line 468 skips `app.getPath('home')`, which is the recommended Electron API for obtaining the user's home directory. Consider aligning with this pattern.

<details>
<summary>♻️ Suggested fix</summary>

```diff
-import { BrowserWindow, ipcMain } from 'electron'
+import { app, BrowserWindow, ipcMain } from 'electron'
 // ... at line 468:
-      const indexPath = join(process.env.HOME || process.env.USERPROFILE || homedir(), '.openclaw', 'agents', agentId, 'sessions', 'sessions.json')
+      const home = app.getPath('home') || process.env.HOME || process.env.USERPROFILE || homedir()
+      const indexPath = join(home, '.openclaw', 'agents', agentId, 'sessions', 'sessions.json')
```
</details>

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against the current code and only fix it if needed.

In `@src/main/ipc/canvas.ts` at line 468, The indexPath construction uses
process.env/HOMEDIR fallback directly and should align with the established
resolveHome pattern in fs.ts; update the code that sets the const indexPath to
obtain the home directory via app.getPath('home') first (or call the existing
resolveHome() helper from src/main/ipc/fs.ts) and then fall back to
process.env.HOME, process.env.USERPROFILE, and homedir(), so the indexPath uses
the Electron-recommended home path resolution (refer to the indexPath constant
and the resolveHome function).
```

</details>

</blockquote></details>
<details>
<summary>src/renderer/src/App.tsx (1)</summary><blockquote>

`3553-3553`: **Add `platform` property to `ElectronAPI` interface to eliminate the `any` cast.**

Line 3553 uses `(window as any).electron?.platform` as a workaround because the `ElectronAPI` interface in `src/renderer/src/env.d.ts` doesn't include the `platform` property, even though it's exposed in the preload script (`src/preload/index.ts:463`). Add `platform: string` to the interface instead of casting.

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against the current code and only fix it if needed.

In `@src/renderer/src/App.tsx` at line 3553, The renderer is using (window as
any).electron?.platform because the ElectronAPI interface lacks a platform
property; update the ElectronAPI interface in env.d.ts to include platform:
string so window.electron.platform is typed and you can remove the any cast in
App.tsx (where paddingTop uses (window as any).electron?.platform). Ensure the
interface name ElectronAPI is updated and consistent with the preload export
that exposes platform (referenced by the preload function that sets
electron.platform).
```

</details>

</blockquote></details>

</blockquote></details>

<details>
<summary>🤖 Prompt for all review comments with AI agents</summary>

```
Verify each finding against the current code and only fix it if needed.

Inline comments:
In `@scripts/before-build.js`:
- Around line 18-37: The Windows-specific operations should be gated by the
build target platform using context.platform.name rather than relying on the
called scripts' internal process.platform checks; update the logic around
patchScript (variable patchScript / require(patchScript)) to only
require/execute patch-node-pty-win.js when context.platform.name === 'win32' (or
startsWith 'win') so the file is not loaded on non-Windows targets, and likewise
wrap the cpu-features fallback generation (cpuFeaturesDir / buildcheckGypi
creation branch and its fallback write) with a check using context.platform.name
to avoid writing Windows-only fallbacks for non-Windows targets; locate and
change the conditional surrounding those symbols to use context.platform.name
for cross-compilation correctness.

In `@scripts/patch-node-pty-win.js`:
- Around line 17-25: The script currently calls process.exit() at module
top-level (the console.log branches around process.platform !== 'win32' and the
nodePtyDir exists check), which will terminate the parent before-build hook; to
fix this, refactor the file to export a function (e.g., function
patchNodePtyWin() or module.exports = async function patchNodePtyWin() { ... })
that contains the current logic, replace all process.exit(0) calls with early
returns inside that function (e.g., log and return false/undefined), and update
scripts/before-build.js to import and invoke the exported patchNodePtyWin() so
the hook can continue to completion instead of being killed by process.exit.
- Around line 33-44: The patch script performs several content.replace calls on
the winpty gyp content (the three replaces for the WINPTY_COMMIT_HASH pattern,
the UpdateGenVersion.bat pattern, and the 'SpectreMitigation' pattern) but
doesn’t verify they matched; update scripts/patch-node-pty-win.js to assert that
each critical replacement succeeded by checking the return value (e.g., compare
content before and after each call or test .includes() of the new substring) and
throw an Error if any replacement is a no-op; ensure you reference the specific
replace invocations (the replace for /'WINPTY_COMMIT_HASH%':\s*'<!\(cmd \/c "cd
shared && GetCommitHash\.bat"\)'/, the replace for /'<!\(cmd \/c "cd shared &&
UpdateGenVersion\.bat <\(WINPTY_COMMIT_HASH\)"\)'/, and the replace for
/'SpectreMitigation': 'Spectre'/) and fail-fast before calling
fs.writeFileSync(winptyGyp, content).

In `@src/main/agent-paths.ts`:
- Around line 393-396: In the ipcMain handler for 'agentPaths:set' (inside the
agentPaths:set callback where cachedPaths, agentId and key are used), validate
agentId against a fixed allowlist of the five supported ids
('claude','codex','opencode','openclaw','hermes') before casting to the union
type and indexing cachedPaths; if agentId is not one of those, return null (or
reject) to avoid treating keys like shellPath/updatedAt as agents. Perform the
allowlist check first, then cast agentId to the narrower type for subsequent
usage (i.e., only after validation use const key = agentId as 'claude' | 'codex'
| 'opencode' | 'openclaw' | 'hermes').
- Around line 140-159: The helper resolveExecutablePath currently may return
.cmd/.bat/.ps1 on Windows; change it so on process.platform === 'win32' it only
returns paths ending with .exe: if filePath already has an extension, return it
only when it's .exe; when given a bare name, probe only for .exe (skip
.cmd/.bat/.ps1) and return filePath + '.exe' when accessible; otherwise fall
through to null. Also ensure callers that persist agent paths (detectBinary and
agentPaths:set) validate or normalize values using resolveExecutablePath so
non-.exe values aren't saved.

In `@src/main/ipc/agents.ts`:
- Around line 137-148: The which/where output may return a .cmd shim on Windows;
update the logic after obtaining whichResult (from runCmd(whichCmd)) to
normalize and prefer a native .exe similarly to src/main/agent-paths.ts: inspect
all newline-separated hits in whichResult, prefer the first path that ends with
.exe (falling back to the first non-empty hit), then set whichPath to that
normalized path before computing version and returning the agent object
(references: whichResult, whichPath, runCmd, agent.cmd, agent.versionFlag,
agent.id).

In `@src/main/ipc/terminal.ts`:
- Around line 319-322: The code sets defaultShell/bin for Windows but still
emits a POSIX-style `terminal:cd` string; update the place that sends the
`terminal:cd` command to branch on the shell/platform (use the existing
defaultShell/bin or process.platform === 'win32' check) and emit Windows-safe
commands: for cmd.exe emit `cd /d "PATH"` (ensure PATH is properly quoted and
internal quotes escaped), for PowerShell emit `Set-Location -LiteralPath 'PATH'`
(or double-quote with escapes), and otherwise keep `cd "PATH"` for POSIX;
reference the `defaultShell`/`bin` variables and the `terminal:cd` emission site
when making the change.

In `@src/renderer/src/components/MCPPanel.tsx`:
- Around line 119-120: The save callback currently builds home with only (window
as any).process?.env?.HOME which fails on Windows; match the load logic in
MCPPanel by computing home using the same fallback chain ((window as
any).__HOME__ ?? (window as any).process?.env?.HOME ?? (window as
any).process?.env?.USERPROFILE ?? '') and then call path.replace('~', home)
before writing; update the save callback's home variable and ensure the write
uses that replaced path.

In `@src/renderer/src/components/Sidebar.tsx`:
- Around line 839-842: The code currently uses projectEntry.workspaceIds[0]
which can pick the wrong workspace; instead use the computed representative
workspace ID for this project. Change the assignment so targetWsId is the
previously computed representativeWorkspaceId (falling back to
projectEntry.workspaceIds[0] only if that is undefined), then call
_onSwitchWorkspace(targetWsId) when targetWsId !== workspace?.id; reference the
projectEntry, representativeWorkspaceId, _onSwitchWorkspace and workspace?.id
symbols when making the change.

---

Nitpick comments:
In `@src/main/ipc/canvas.ts`:
- Line 468: The indexPath construction uses process.env/HOMEDIR fallback
directly and should align with the established resolveHome pattern in fs.ts;
update the code that sets the const indexPath to obtain the home directory via
app.getPath('home') first (or call the existing resolveHome() helper from
src/main/ipc/fs.ts) and then fall back to process.env.HOME,
process.env.USERPROFILE, and homedir(), so the indexPath uses the
Electron-recommended home path resolution (refer to the indexPath constant and
the resolveHome function).

In `@src/renderer/src/App.tsx`:
- Line 3553: The renderer is using (window as any).electron?.platform because
the ElectronAPI interface lacks a platform property; update the ElectronAPI
interface in env.d.ts to include platform: string so window.electron.platform is
typed and you can remove the any cast in App.tsx (where paddingTop uses (window
as any).electron?.platform). Ensure the interface name ElectronAPI is updated
and consistent with the preload export that exposes platform (referenced by the
preload function that sets electron.platform).

In `@src/renderer/src/hooks/useMCPServers.ts`:
- Line 21: The home-directory resolution in useMCPServers.ts (variable `home`)
must match MCPPanel.tsx by checking the `__HOME__` fallback first; update the
`home` assignment in useMCPServers.ts to prefer `(window as any).__HOME__`
before falling back to `(window as any).process?.env?.HOME` and `(window as
any).process?.env?.USERPROFILE` so both files read `~/.contex/mcp-server.json`
the same way and remain consistent with `MCPPanel.tsx`.
```

</details>

<details>
<summary>🪄 Autofix (Beta)</summary>

Fix all unresolved CodeRabbit comments on this PR:

- [ ] <!-- {"checkboxId": "4b0d0e0a-96d7-4f10-b296-3a18ea78f0b9"} --> Push a commit to this branch (recommended)
- [ ] <!-- {"checkboxId": "ff5b1114-7d8c-49e6-8ac1-43f82af23a33"} --> Create a new PR with the fixes

</details>

---

<details>
<summary>ℹ️ Review info</summary>

<details>
<summary>⚙️ Run configuration</summary>

**Configuration used**: defaults

**Review profile**: CHILL

**Plan**: Pro

**Run ID**: `490d5d84-e7a1-4791-9a4d-62314ecfa7c6`

</details>

<details>
<summary>📥 Commits</summary>

Reviewing files that changed from the base of the PR and between bbebadb612072f5ed301815744bac70d5453f29d and 649ed1461cf04f6f3caf26392fbb16d76dc4e4e5.

</details>

<details>
<summary>⛔ Files ignored due to path filters (2)</summary>

* `package-lock.json` is excluded by `!**/package-lock.json`
* `resources/icon.ico` is excluded by `!**/*.ico`

</details>

<details>
<summary>📒 Files selected for processing (19)</summary>

* `
`
* `.gitignore`
* `package.json`
* `scripts/before-build.js`
* `scripts/create-ico.js`
* `scripts/patch-node-pty-win.js`
* `src/main/agent-paths.ts`
* `src/main/chrome-sync/keychain.ts`
* `src/main/index.ts`
* `src/main/ipc/agents.ts`
* `src/main/ipc/canvas.ts`
* `src/main/ipc/fs.ts`
* `src/main/ipc/terminal.ts`
* `src/main/windowAppearance.ts`
* `src/preload/index.ts`
* `src/renderer/src/App.tsx`
* `src/renderer/src/components/MCPPanel.tsx`
* `src/renderer/src/components/Sidebar.tsx`
* `src/renderer/src/hooks/useMCPServers.ts`

</details>

<details>
<summary>💤 Files with no reviewable changes (1)</summary>

* 


</details>

</details>

<!-- This is an auto-generated comment by CodeRabbit for review status -->

---

## Review state=COMMENTED submitted=2026-04-16T07:00:54Z



---

## Review state=COMMENTED submitted=2026-04-16T07:02:00Z



---

## Review state=COMMENTED submitted=2026-04-16T07:02:59Z



---

## Review state=COMMENTED submitted=2026-04-16T07:03:04Z



---

## Review state=COMMENTED submitted=2026-04-16T07:03:40Z



---

## Review state=COMMENTED submitted=2026-04-16T07:03:40Z



---

## Review state=COMMENTED submitted=2026-04-16T07:04:06Z



---

## Review state=COMMENTED submitted=2026-04-16T15:53:31Z

**Actionable comments posted: 2**

<details>
<summary>🧹 Nitpick comments (1)</summary><blockquote>

<details>
<summary>src/renderer/src/components/TerminalTile.tsx (1)</summary><blockquote>

`174-175`: **Consider adding `fontSize` to the dependency array.**

The `fontSize` prop is used in Terminal options (line 93) but isn't in the dependency array. If font size changes dynamically, the terminal won't reflect the update. If dynamic font size changes are expected, add it to the dependencies; otherwise, a comment clarifying this is intentional would help.



<details>
<summary>♻️ Suggested fix if dynamic fontSize is needed</summary>

```diff
     return () => {
       cancelled = true
       mountedRef.current = false
       ro?.disconnect()
       cleanupRef.current?.()
       // Detach (not destroy) so tmux sessions survive unmount/reload
       window.electron?.terminal?.detach?.(tileId)
       termRef.current?.dispose()
     }
-  }, [tileId, workspaceDir, launchBin, launchArgs])
+  }, [tileId, workspaceDir, launchBin, launchArgs, fontSize])
```
</details>

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against the current code and only fix it if needed.

In `@src/renderer/src/components/TerminalTile.tsx` around lines 174 - 175, The
useEffect that initializes/configures the Terminal (referenced by the dependency
array [tileId, workspaceDir, launchBin, launchArgs]) reads the fontSize prop in
the Terminal options (fontSize), so either add fontSize to the dependency array
to ensure the terminal updates when fontSize changes or add a concise comment
above the useEffect explaining that fontSize is intentionally omitted (and why).
Update the dependency list to include fontSize or add the explanatory comment
near the useEffect to make the decision explicit.
```

</details>

</blockquote></details>

</blockquote></details>

<details>
<summary>🤖 Prompt for all review comments with AI agents</summary>

```
Verify each finding against the current code and only fix it if needed.

Inline comments:
In `@src/main/ipc/agents.ts`:
- Around line 123-154: The detectAgent fallback should delegate to the shared
resolver in src/main/agent-paths.ts instead of directly calling which/where and
pickBestPath; update detectAgent to call the exported resolver (e.g.,
resolveExecutable/findExecutable/resolveAgentPath — whatever the exported
function name is) with agent.cmd and/or candidate bins, and use its result to
decide available: true and the cmd/path/version values so we inherit PATH
hydration for packaged GUI launches and the Windows .cmd/.bat rejection logic
already implemented in the shared resolver; remove the ad-hoc which/where logic
(and pickBestPath usage) and rely on the shared resolver’s return to populate
the AgentInfo.

In `@src/renderer/src/components/MCPPanel.tsx`:
- Around line 117-120: The path construction in MCPPanel.tsx uses
process.env.HOME when creating the `path` const, so `path.replace('~', home)`
later can be skipped when HOME exists and diverge from the intended fallback
chain; change the logic to compute `home` first (from `(window as
any).__HOME__`, `process.env.HOME`, `process.env.USERPROFILE`, etc.), then build
`path` using that `home` (e.g. `${home}/.contex/mcp-server.json`) so
`window.electron.fs.readFile` (and any writes) use the same resolved home
regardless of platform or env ordering.

---

Nitpick comments:
In `@src/renderer/src/components/TerminalTile.tsx`:
- Around line 174-175: The useEffect that initializes/configures the Terminal
(referenced by the dependency array [tileId, workspaceDir, launchBin,
launchArgs]) reads the fontSize prop in the Terminal options (fontSize), so
either add fontSize to the dependency array to ensure the terminal updates when
fontSize changes or add a concise comment above the useEffect explaining that
fontSize is intentionally omitted (and why). Update the dependency list to
include fontSize or add the explanatory comment near the useEffect to make the
decision explicit.
```

</details>

<details>
<summary>🪄 Autofix (Beta)</summary>

Fix all unresolved CodeRabbit comments on this PR:

- [ ] <!-- {"checkboxId": "4b0d0e0a-96d7-4f10-b296-3a18ea78f0b9"} --> Push a commit to this branch (recommended)
- [ ] <!-- {"checkboxId": "ff5b1114-7d8c-49e6-8ac1-43f82af23a33"} --> Create a new PR with the fixes

</details>

---

<details>
<summary>ℹ️ Review info</summary>

<details>
<summary>⚙️ Run configuration</summary>

**Configuration used**: defaults

**Review profile**: CHILL

**Plan**: Pro

**Run ID**: `12d56768-d9ef-43a5-946c-80065df56ee8`

</details>

<details>
<summary>📥 Commits</summary>

Reviewing files that changed from the base of the PR and between 649ed1461cf04f6f3caf26392fbb16d76dc4e4e5 and 020c93c7dc4f9dad680279d2d37040da9eae2fc5.

</details>

<details>
<summary>⛔ Files ignored due to path filters (1)</summary>

* `package-lock.json` is excluded by `!**/package-lock.json`

</details>

<details>
<summary>📒 Files selected for processing (18)</summary>

* `README.md`
* `bin/codesurfd.mjs`
* `package.json`
* `scripts/before-build.js`
* `scripts/patch-node-pty-win.js`
* `src/main/agent-paths.ts`
* `src/main/index.ts`
* `src/main/ipc/agents.ts`
* `src/main/ipc/fs.ts`
* `src/main/ipc/terminal.ts`
* `src/preload/index.ts`
* `src/renderer/src/App.tsx`
* `src/renderer/src/components/MCPPanel.tsx`
* `src/renderer/src/components/Sidebar.tsx`
* `src/renderer/src/components/TerminalTile.tsx`
* `src/renderer/src/env.d.ts`
* `src/renderer/src/hooks/useMCPServers.ts`
* `src/shared/types.ts`

</details>

<details>
<summary>✅ Files skipped from review due to trivial changes (5)</summary>

* src/renderer/src/env.d.ts
* README.md
* src/main/ipc/fs.ts
* src/preload/index.ts
* src/shared/types.ts

</details>

<details>
<summary>🚧 Files skipped from review as they are similar to previous changes (5)</summary>

* src/renderer/src/App.tsx
* src/renderer/src/hooks/useMCPServers.ts
* scripts/before-build.js
* src/main/ipc/terminal.ts
* src/main/agent-paths.ts

</details>

</details>

<!-- This is an auto-generated comment by CodeRabbit for review status -->

---

## Review state=COMMENTED submitted=2026-04-16T16:05:48Z



---

## Review state=COMMENTED submitted=2026-04-16T16:06:19Z



---

## Review state=COMMENTED submitted=2026-04-16T20:13:36Z

**Actionable comments posted: 3**

> [!CAUTION]
> Some comments are outside the diff and can’t be posted inline due to platform limitations.
> 
> 
> 
> <details>
> <summary>⚠️ Outside diff range comments (1)</summary><blockquote>
> 
> <details>
> <summary>package.json (1)</summary><blockquote>
> 
> `11-18`: _⚠️ Potential issue_ | _🟠 Major_
> 
> **`postinstall` will fail for npm consumers — `scripts/` is not in the `files` allowlist.**
> 
> The `files` array (Lines 11–18) does not include `scripts/`, so when this package is installed via npm by end users, the `postinstall` hook (Line 36) will fail immediately trying to execute `scripts/patch-node-pty-win.js`. Additionally, the hook invokes `electron-rebuild`, which depends on `@electron/rebuild` — a devDependency that won't be installed in production consumer environments.
> 
> Either (a) add `"scripts/"` to `files` and guard postinstall to no-op when running on consumers' machines, or (b) move these setup steps to a dev-only script (e.g., `prepare`) that only runs during local development.
> 
> <details>
> <summary>🤖 Prompt for AI Agents</summary>
> 
> ```
> Verify each finding against the current code and only fix it if needed.
> 
> In `@package.json` around lines 11 - 18, The package.json currently omits
> "scripts/" from the files array and has a postinstall script that runs
> scripts/patch-node-pty-win.js and invokes electron-rebuild (which relies on
> devDependency `@electron/rebuild`), causing postinstall to fail for npm consumers;
> fix by either adding "scripts/" to the "files" array and guarding the
> "postinstall" script to no-op when run in a consumer environment (e.g., check
> for CI/consumer flags or NODE_ENV and skip if not a developer machine) or move
> the setup steps into a dev-only hook such as "prepare" (or a new script like
> "dev:setup") that runs only during development, and remove/replace the current
> "postinstall" entry so consumers won’t run electron-rebuild or attempt to
> execute scripts/patch-node-pty-win.js at install time.
> ```
> 
> </details>
> 
> </blockquote></details>
> 
> </blockquote></details>

<details>
<summary>🧹 Nitpick comments (7)</summary><blockquote>

<details>
<summary>src/main/agent-paths.ts (2)</summary><blockquote>

`300-306`: **Dead branch in the Windows re-resolve check.**

On Windows, `resolveExecutablePath` (Line 150–166) only ever returns an `.exe` path or `null`. So when `resolved` is truthy, `!/\.exe$/i.test(resolved)` is always false, and the inner `whichSync` fallback only fires when `resolved` is `null`. The expression can be simplified to `if (process.platform === 'win32' && !resolved)`, which also makes intent clearer.


<details>
<summary>♻️ Proposed simplification</summary>

```diff
-    if (process.platform === 'win32' && (!resolved || !/\.exe$/i.test(resolved))) {
+    if (process.platform === 'win32' && !resolved) {
       const fromWhich = whichSync(key)
       if (fromWhich && /\.exe$/i.test(fromWhich)) best = fromWhich
     }
```
</details>

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against the current code and only fix it if needed.

In `@src/main/agent-paths.ts` around lines 300 - 306, The Windows re-resolve check
contains a dead branch because resolveExecutablePath only returns an .exe or
null; update the condition in the block that uses whichSync so it triggers only
when resolved is falsy (i.e., change the condition to check process.platform ===
'win32' && !resolved), leaving the rest of the logic that assigns best from
whichSync intact; reference resolveExecutablePath, resolved, whichSync and best
to locate and simplify the conditional.
```

</details>

---

`122-140`: **`isExecutable` only checks existence, not executability.**

`fs.access(filePath)` (no mode) just tests existence — a non-executable regular file will pass. On POSIX callers where the returned path gets spawned directly, consider `fs.access(filePath, fs.constants.X_OK)` to avoid reporting a stray file as a usable binary. Not critical since most callers now go through `resolveExecutablePath` + version probing, but worth tightening.

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against the current code and only fix it if needed.

In `@src/main/agent-paths.ts` around lines 122 - 140, The isExecutable function
currently checks only existence via fs.access(filePath) — change it to actually
test execute permission on POSIX by calling fs.access(filePath,
fs.constants.X_OK) (or conditional: use X_OK when process.platform !== 'win32');
keep the Windows extension loop but when checking filePath + ext either use
existence check (Windows) or X_OK on non-Windows, and ensure all try/catch
blocks still return true only when the access call succeeds; update references
in isExecutable to use fs.constants.X_OK so spawned paths won’t report
non-executable files as usable.
```

</details>

</blockquote></details>
<details>
<summary>src/renderer/src/components/TerminalTile.tsx (1)</summary><blockquote>

`92-101`: **Add trailing commas on final object properties.**

Minor style nit: `width: 10` (line 93) and `scrollback: 5000` (line 100) are missing trailing commas.

<details>
<summary>✂️ Proposed fix</summary>

```diff
       overviewRuler: {
-        width: 10
+        width: 10,
       },
       fontFamily: resolvedFont,
       fontSize,
       lineHeight: 1,
       cursorBlink: true,
       allowProposedApi: true,
-      scrollback: 5000
+      scrollback: 5000,
     })
```
</details>

As per coding guidelines: "Use 2-space indent, trailing commas, and no semicolons in code formatting".

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against the current code and only fix it if needed.

In `@src/renderer/src/components/TerminalTile.tsx` around lines 92 - 101, In the
TerminalTile component update the options object that sets overviewRuler,
fontFamily, fontSize, lineHeight, cursorBlink, allowProposedApi, and scrollback
by adding trailing commas after the final properties (specifically after "width:
10" inside overviewRuler and after "scrollback: 5000") so the object literal
conforms to the project's 2-space indent + trailing comma style; locate this
object in the TerminalTile.tsx file where the editor/terminal options are passed
(the options literal inside the TerminalTile component) and add the two missing
commas.
```

</details>

</blockquote></details>
<details>
<summary>package.json (4)</summary><blockquote>

`35-36`: **`rebuild` and `postinstall` are now inconsistent.**

`postinstall` was split into two separate `electron-rebuild -f -o <name>` calls, but the standalone `rebuild` script (Line 35) still uses the older combined `-w node-pty,better-sqlite3` form. If the split was required (e.g., because combined wildcard rebuild order broke on Windows), `rebuild` has the same bug; if it wasn't required, keeping `postinstall` combined would be simpler.

<details>
<summary>♻️ Align both scripts</summary>

```diff
-    "rebuild": "electron-rebuild -f -w node-pty,better-sqlite3",
+    "rebuild": "electron-rebuild -f -o better-sqlite3 && electron-rebuild -f -o node-pty",
```
</details>

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against the current code and only fix it if needed.

In `@package.json` around lines 35 - 36, The package.json scripts are
inconsistent: "rebuild" uses the combined flag "-w node-pty,better-sqlite3"
while "postinstall" runs two separate electron-rebuild invocations for
better-sqlite3 and node-pty; update "rebuild" to match "postinstall" by
splitting it into two electron-rebuild -f -o better-sqlite3 and electron-rebuild
-f -o node-pty commands (or alternatively make "postinstall" use the combined
"-w node-pty,better-sqlite3" form if that was intended), ensuring the "rebuild"
and "postinstall" script entries are aligned.
```

</details>

---

`29-29`: **Redundant patch invocation — `beforeBuild` already runs it.**

`scripts/before-build.js` (registered at Line 110) calls `patchNodePtyWin()` for Windows targets, so the explicit `node scripts/patch-node-pty-win.js` here runs the same work twice. It's idempotent, but it muddies the intent: a reader can't tell whether the hook or the explicit call is authoritative. Drop one.

<details>
<summary>♻️ Proposed simplification</summary>

```diff
-    "dist:windows": "npm run build && node scripts/patch-node-pty-win.js && electron-builder --win nsis portable",
+    "dist:windows": "npm run build && electron-builder --win nsis portable",
```
</details>

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against the current code and only fix it if needed.

In `@package.json` at line 29, The "dist:windows" npm script redundantly invokes
node scripts/patch-node-pty-win.js even though scripts/before-build.js already
calls patchNodePtyWin() for Windows targets; remove the explicit "node
scripts/patch-node-pty-win.js" invocation from the "dist:windows" script in
package.json so the beforeBuild hook (scripts/before-build.js ->
patchNodePtyWin()) is the single authoritative spot that applies the patch to
scripts/patch-node-pty-win.js.
```

</details>

---

`106-109`: **Asymmetric `from` roots for bundled extensions — inconsistent sourcing detected.**

`agent-kanban` is sourced from `examples/extensions/...` while `livekit-rooms` is sourced from `bundled-extensions/...`. Verification shows both extensions exist in *both* locations (including `bundled-extensions/agent-kanban` and `examples/extensions/livekit-rooms`), making the current split fragile and inconsistent. Standardize by sourcing both from `bundled-extensions/` to align with bundled extension naming and avoid ambiguity.

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against the current code and only fix it if needed.

In `@package.json` around lines 106 - 109, The extraResources entries are
inconsistent: update the "extraResources" array so both bundled extensions
source from "bundled-extensions/"; specifically change the "from" value for the
agent-kanban entry (currently "examples/extensions/agent-kanban") to
"bundled-extensions/agent-kanban" so both entries use
"bundled-extensions/<name>" and keep the "to" targets unchanged.
```

</details>

---

`79-79`: **Consider pinning `node-pty` to an exact version to prevent postinstall failures.**

The `scripts/patch-node-pty-win.js` script uses strict regex assertions against `deps/winpty/src/winpty.gyp` and `binding.gyp`. If a future 1.1.x release of `node-pty` modifies those files, the `postinstall` script (and Windows builds) will hard-fail. Pin to `"node-pty": "1.1.0"` until the patch is upstreamed or made more tolerant.

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against the current code and only fix it if needed.

In `@package.json` at line 79, The dependency declaration for node-pty is using a
caret range which allows 1.1.x updates; change the package.json entry for
"node-pty" from a range ("^1.1.0") to an exact pinned version ("1.1.0") to avoid
future postinstall failures in scripts/patch-node-pty-win.js that rely on exact
winpty/binding.gyp contents and to ensure postinstall and Windows builds remain
stable.
```

</details>

</blockquote></details>

</blockquote></details>

<details>
<summary>🤖 Prompt for all review comments with AI agents</summary>

```
Verify each finding against the current code and only fix it if needed.

Inline comments:
In `@src/main/ipc/agents.ts`:
- Around line 100-108: The bins list for the 'shell' agent contains bare names
like 'powershell.exe'/'pwsh.exe' which fail fileExists() lookups in detectAgent;
update detectAgent to also try resolving each entry in agent.bins with whichSync
or by checking common absolute Windows paths (e.g. SystemRoot System32
PowerShell paths) before falling back to agent.cmd, or alternatively change the
'bins' entries to absolute paths for Windows; modify the logic in detectAgent
(the fileExists(bin) probe and the whichSync(agent.cmd) fallback) to iterate
agent.bins and call whichSync on each candidate so PowerShell-only systems are
detected correctly.
- Around line 129-134: The Shell agent's version probing using runExec(bin,
[agent.versionFlag]) yields meaningless output on Windows; update the logic
around agent.versionFlag / runExec (the block that sets version) to skip probing
for the Shell agent or detect Windows and run shell-specific commands instead
(e.g., for cmd.exe use "cmd.exe /c ver", for powershell use "powershell
-NoProfile -Command $PSVersionTable.PSVersion.ToString()"), and assign version
only from those sanitized outputs; ensure the check remains tied to
agent.versionFlag and bin so other agents still use the existing runExec path.

In `@src/renderer/src/components/TerminalTile.tsx`:
- Around line 74-101: The terminal construction inside
Promise.all(fontLoads).then(...) closes over the mount-time fontSize prop so if
fontSize changes while fonts load the Terminal is created with a stale value;
fix by reading the current fontSize from a ref instead of the closed-over prop
when constructing the Terminal (create a fontSizeRef that you keep updated in
the fontSize effect and use fontSizeRef.current when calling new Terminal or
when setting terminal options), and ensure the existing effect that updates
termRef.current (the font-size update effect) writes to that same ref so the
latest value always wins for Terminal initialization and subsequent option
updates.

---

Outside diff comments:
In `@package.json`:
- Around line 11-18: The package.json currently omits "scripts/" from the files
array and has a postinstall script that runs scripts/patch-node-pty-win.js and
invokes electron-rebuild (which relies on devDependency `@electron/rebuild`),
causing postinstall to fail for npm consumers; fix by either adding "scripts/"
to the "files" array and guarding the "postinstall" script to no-op when run in
a consumer environment (e.g., check for CI/consumer flags or NODE_ENV and skip
if not a developer machine) or move the setup steps into a dev-only hook such as
"prepare" (or a new script like "dev:setup") that runs only during development,
and remove/replace the current "postinstall" entry so consumers won’t run
electron-rebuild or attempt to execute scripts/patch-node-pty-win.js at install
time.

---

Nitpick comments:
In `@package.json`:
- Around line 35-36: The package.json scripts are inconsistent: "rebuild" uses
the combined flag "-w node-pty,better-sqlite3" while "postinstall" runs two
separate electron-rebuild invocations for better-sqlite3 and node-pty; update
"rebuild" to match "postinstall" by splitting it into two electron-rebuild -f -o
better-sqlite3 and electron-rebuild -f -o node-pty commands (or alternatively
make "postinstall" use the combined "-w node-pty,better-sqlite3" form if that
was intended), ensuring the "rebuild" and "postinstall" script entries are
aligned.
- Line 29: The "dist:windows" npm script redundantly invokes node
scripts/patch-node-pty-win.js even though scripts/before-build.js already calls
patchNodePtyWin() for Windows targets; remove the explicit "node
scripts/patch-node-pty-win.js" invocation from the "dist:windows" script in
package.json so the beforeBuild hook (scripts/before-build.js ->
patchNodePtyWin()) is the single authoritative spot that applies the patch to
scripts/patch-node-pty-win.js.
- Around line 106-109: The extraResources entries are inconsistent: update the
"extraResources" array so both bundled extensions source from
"bundled-extensions/"; specifically change the "from" value for the agent-kanban
entry (currently "examples/extensions/agent-kanban") to
"bundled-extensions/agent-kanban" so both entries use
"bundled-extensions/<name>" and keep the "to" targets unchanged.
- Line 79: The dependency declaration for node-pty is using a caret range which
allows 1.1.x updates; change the package.json entry for "node-pty" from a range
("^1.1.0") to an exact pinned version ("1.1.0") to avoid future postinstall
failures in scripts/patch-node-pty-win.js that rely on exact winpty/binding.gyp
contents and to ensure postinstall and Windows builds remain stable.

In `@src/main/agent-paths.ts`:
- Around line 300-306: The Windows re-resolve check contains a dead branch
because resolveExecutablePath only returns an .exe or null; update the condition
in the block that uses whichSync so it triggers only when resolved is falsy
(i.e., change the condition to check process.platform === 'win32' && !resolved),
leaving the rest of the logic that assigns best from whichSync intact; reference
resolveExecutablePath, resolved, whichSync and best to locate and simplify the
conditional.
- Around line 122-140: The isExecutable function currently checks only existence
via fs.access(filePath) — change it to actually test execute permission on POSIX
by calling fs.access(filePath, fs.constants.X_OK) (or conditional: use X_OK when
process.platform !== 'win32'); keep the Windows extension loop but when checking
filePath + ext either use existence check (Windows) or X_OK on non-Windows, and
ensure all try/catch blocks still return true only when the access call
succeeds; update references in isExecutable to use fs.constants.X_OK so spawned
paths won’t report non-executable files as usable.

In `@src/renderer/src/components/TerminalTile.tsx`:
- Around line 92-101: In the TerminalTile component update the options object
that sets overviewRuler, fontFamily, fontSize, lineHeight, cursorBlink,
allowProposedApi, and scrollback by adding trailing commas after the final
properties (specifically after "width: 10" inside overviewRuler and after
"scrollback: 5000") so the object literal conforms to the project's 2-space
indent + trailing comma style; locate this object in the TerminalTile.tsx file
where the editor/terminal options are passed (the options literal inside the
TerminalTile component) and add the two missing commas.
```

</details>

<details>
<summary>🪄 Autofix (Beta)</summary>

Fix all unresolved CodeRabbit comments on this PR:

- [ ] <!-- {"checkboxId": "4b0d0e0a-96d7-4f10-b296-3a18ea78f0b9"} --> Push a commit to this branch (recommended)
- [ ] <!-- {"checkboxId": "ff5b1114-7d8c-49e6-8ac1-43f82af23a33"} --> Create a new PR with the fixes

</details>

---

<details>
<summary>ℹ️ Review info</summary>

<details>
<summary>⚙️ Run configuration</summary>

**Configuration used**: defaults

**Review profile**: CHILL

**Plan**: Pro

**Run ID**: `27357238-958e-42e7-8835-08224aca6607`

</details>

<details>
<summary>📥 Commits</summary>

Reviewing files that changed from the base of the PR and between 020c93c7dc4f9dad680279d2d37040da9eae2fc5 and 6c2caab8e3f7450d27730e43e44d489b1997f8db.

</details>

<details>
<summary>⛔ Files ignored due to path filters (1)</summary>

* `package-lock.json` is excluded by `!**/package-lock.json`

</details>

<details>
<summary>📒 Files selected for processing (10)</summary>

* `package.json`
* `src/main/agent-paths.ts`
* `src/main/ipc/agents.ts`
* `src/preload/index.ts`
* `src/renderer/src/App.tsx`
* `src/renderer/src/components/MCPPanel.tsx`
* `src/renderer/src/components/Sidebar.tsx`
* `src/renderer/src/components/TerminalTile.tsx`
* `src/renderer/src/env.d.ts`
* `src/shared/types.ts`

</details>

<details>
<summary>🚧 Files skipped from review as they are similar to previous changes (2)</summary>

* src/renderer/src/env.d.ts
* src/shared/types.ts

</details>

</details>

<!-- This is an auto-generated comment by CodeRabbit for review status -->

---

## Review state=COMMENTED submitted=2026-04-17T06:00:14Z

**Actionable comments posted: 2**

<details>
<summary>🧹 Nitpick comments (3)</summary><blockquote>

<details>
<summary>src/main/ipc/agents.ts (1)</summary><blockquote>

`116-129`: **`runExec`/`extractVersion` helpers look solid; minor regex nit.**

`execFile` with a fixed timeout and literal args properly closes the shell-injection surface that the prior `exec`-with-interpolated-command carried. Note that `execFile`'s default encoding is already `'utf8'`, so `stdout`/`stderr` are strings and the `.toString()` in line 119 is a harmless no-op.

The version regex `/[\d]+\.[\d]+[\d.]*/` uses unnecessary character classes around single meta-characters and its trailing `[\d.]*` can match a stray dot (e.g. `1.2.` or `1.2..3`). Consider tightening to `/\d+\.\d+(?:\.\d+)*/`.

<details>
<summary>♻️ Suggested tightening</summary>

```diff
-function extractVersion(out: string): string | undefined {
-  const match = out.match(/[\d]+\.[\d]+[\d.]*/)
-  if (match) return match[0]
+function extractVersion(out: string): string | undefined {
+  const match = out.match(/\d+\.\d+(?:\.\d+)*/)
+  if (match) return match[0]
   const firstLine = out.split('\n')[0]?.trim()
   return firstLine ? firstLine.substring(0, 30) : undefined
 }
```
</details>

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against the current code and only fix it if needed.

In `@src/main/ipc/agents.ts` around lines 116 - 129, Update extractVersion's regex
to a stricter pattern to avoid matching trailing dots: replace the current
/[\d]+\.[\d]+[\d.]*/ with /\d+\.\d+(?:\.\d+)*/ in the extractVersion function;
also in runExec you can remove the unnecessary .toString() on stdout/stderr
since execFile defaults to 'utf8' (strings) — adjust the resolve call in runExec
accordingly so it returns the trimmed string result.
```

</details>

</blockquote></details>
<details>
<summary>src/main/ipc/ui.ts (2)</summary><blockquote>

`14-24`: **Minor: array payloads slip past the object guard.**

`typeof [] === 'object'` is true, so a `ui-state.json` containing a JSON array would be cached as state and later spread via `{ ...state, zoomLevel }`, yielding odd numeric-keyed properties on the written object. Unlikely in practice (only main writes the file), but a cheap tightening:

<details>
<summary>♻️ Suggested change</summary>

```diff
-    cached = parsed && typeof parsed === 'object' ? parsed : {}
+    cached = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
```
</details>

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against the current code and only fix it if needed.

In `@src/main/ipc/ui.ts` around lines 14 - 24, The readState function can accept
arrays because typeof [] === 'object'; update the guard in readState (the cached
assignment that currently checks parsed && typeof parsed === 'object') to also
reject arrays and nulls so only plain objects conforming to UIState are cached
(e.g. use Array.isArray(parsed) and null-checking) before assigning cached;
refer to readState, cached, UIState and UI_STATE_PATH to locate the change.
```

</details>

---

`45-56`: **Consider clamping `level` to Electron's supported range before persisting.**

A caller passing an extreme value (e.g. `500`) currently gets persisted to `ui-state.json` and reapplied on every subsequent window load, producing an unusable UI with no in-app recovery path short of deleting the file. Electron's zoom level is commonly exercised in roughly `[-8, +9]`; clamping (and optionally rejecting NaN-ish inputs you already reject) keeps the state recoverable.

<details>
<summary>♻️ Suggested change</summary>

```diff
   ipcMain.handle('ui:setZoomLevel', async (event, level: number) => {
     if (typeof level !== 'number' || !Number.isFinite(level)) return
-    const state = await readState()
-    await writeState({ ...state, zoomLevel: level })
+    const clamped = Math.max(-8, Math.min(9, level))
+    const state = await readState()
+    await writeState({ ...state, zoomLevel: clamped })
     // Apply to the sender's webContents so all windows stay consistent
     // when the same sender drives zoom; other windows pick up the new
     // value on their next did-finish-load restore.
     const win = BrowserWindow.fromWebContents(event.sender)
     if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
-      win.webContents.setZoomLevel(level)
+      win.webContents.setZoomLevel(clamped)
     }
   })
```
</details>

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against the current code and only fix it if needed.

In `@src/main/ipc/ui.ts` around lines 45 - 56, Clamp the incoming zoom level in
the ipcMain handler for 'ui:setZoomLevel' to Electron's supported range (e.g.
min -8, max +9) before calling writeState and before calling
win.webContents.setZoomLevel: validate the numeric input as you already do,
compute a clampedLevel = Math.max(MIN, Math.min(MAX, level)), persist
clampedLevel via writeState({ ...state, zoomLevel: clampedLevel }) and apply
clampedLevel to win.webContents.setZoomLevel; keep the existing
BrowserWindow.fromWebContents and readState logic but ensure the stored value is
the clamped one so extreme values cannot be saved and re-applied.
```

</details>

</blockquote></details>

</blockquote></details>

<details>
<summary>🤖 Prompt for all review comments with AI agents</summary>

```
Verify each finding against the current code and only fix it if needed.

Inline comments:
In `@package.json`:
- Line 22: The dev script hardcodes --max-old-space-size=8192 and thus overrides
the CODESURF_MAX_OLD_SPACE_SIZE_MB env knob read by src/main/index.ts and used
via app.commandLine.appendSwitch('js-flags', …); update the "dev" npm script
(script name "dev") to preserve an environment override instead of hardcoding
8192 (e.g. interpolate the CODESURF_MAX_OLD_SPACE_SIZE_MB env variable into the
js-flags string or use cross-env / a small Node launcher to read
process.env.CODESURF_MAX_OLD_SPACE_SIZE_MB and fall back to 8192) so the
main-process heap size can still be configured at dev time.

In `@src/renderer/src/components/TerminalTile.tsx`:
- Around line 55-181: The effect is re-running whenever the array prop
launchArgs has a new reference; stabilize it by replacing the raw array in the
effect deps with a stable serialized key (e.g., compute const launchArgsKey =
useMemo(() => JSON.stringify(launchArgs || []), [launchArgs]) and use
launchArgsKey in the useEffect dependency array instead of launchArgs) so
equivalent arrays don't trigger teardown/recreation of Terminal/PTY; keep
passing the original launchArgs when calling
window.electron.terminal.create(tileId, workspaceDir, launchBin, launchArgs).
Alternatively, document/require callers to memoize launchArgs and leave deps
unchanged.

---

Nitpick comments:
In `@src/main/ipc/agents.ts`:
- Around line 116-129: Update extractVersion's regex to a stricter pattern to
avoid matching trailing dots: replace the current /[\d]+\.[\d]+[\d.]*/ with
/\d+\.\d+(?:\.\d+)*/ in the extractVersion function; also in runExec you can
remove the unnecessary .toString() on stdout/stderr since execFile defaults to
'utf8' (strings) — adjust the resolve call in runExec accordingly so it returns
the trimmed string result.

In `@src/main/ipc/ui.ts`:
- Around line 14-24: The readState function can accept arrays because typeof []
=== 'object'; update the guard in readState (the cached assignment that
currently checks parsed && typeof parsed === 'object') to also reject arrays and
nulls so only plain objects conforming to UIState are cached (e.g. use
Array.isArray(parsed) and null-checking) before assigning cached; refer to
readState, cached, UIState and UI_STATE_PATH to locate the change.
- Around line 45-56: Clamp the incoming zoom level in the ipcMain handler for
'ui:setZoomLevel' to Electron's supported range (e.g. min -8, max +9) before
calling writeState and before calling win.webContents.setZoomLevel: validate the
numeric input as you already do, compute a clampedLevel = Math.max(MIN,
Math.min(MAX, level)), persist clampedLevel via writeState({ ...state,
zoomLevel: clampedLevel }) and apply clampedLevel to
win.webContents.setZoomLevel; keep the existing BrowserWindow.fromWebContents
and readState logic but ensure the stored value is the clamped one so extreme
values cannot be saved and re-applied.
```

</details>

<details>
<summary>🪄 Autofix (Beta)</summary>

Fix all unresolved CodeRabbit comments on this PR:

- [ ] <!-- {"checkboxId": "4b0d0e0a-96d7-4f10-b296-3a18ea78f0b9"} --> Push a commit to this branch (recommended)
- [ ] <!-- {"checkboxId": "ff5b1114-7d8c-49e6-8ac1-43f82af23a33"} --> Create a new PR with the fixes

</details>

---

<details>
<summary>ℹ️ Review info</summary>

<details>
<summary>⚙️ Run configuration</summary>

**Configuration used**: defaults

**Review profile**: CHILL

**Plan**: Pro

**Run ID**: `57d2dffb-a60f-48ad-a0fc-2c1c2726671e`

</details>

<details>
<summary>📥 Commits</summary>

Reviewing files that changed from the base of the PR and between 6c2caab8e3f7450d27730e43e44d489b1997f8db and 32f75fe928ded68268ef224bc45e66b67d771216.

</details>

<details>
<summary>⛔ Files ignored due to path filters (1)</summary>

* `package-lock.json` is excluded by `!**/package-lock.json`

</details>

<details>
<summary>📒 Files selected for processing (9)</summary>

* `package.json`
* `src/main/agent-paths.ts`
* `src/main/index.ts`
* `src/main/ipc/agents.ts`
* `src/main/ipc/ui.ts`
* `src/preload/index.ts`
* `src/renderer/src/components/Sidebar.tsx`
* `src/renderer/src/components/TerminalTile.tsx`
* `src/renderer/src/env.d.ts`

</details>

<details>
<summary>✅ Files skipped from review due to trivial changes (1)</summary>

* src/main/agent-paths.ts

</details>

<details>
<summary>🚧 Files skipped from review as they are similar to previous changes (2)</summary>

* src/renderer/src/components/Sidebar.tsx
* src/preload/index.ts

</details>

</details>

<!-- This is an auto-generated comment by CodeRabbit for review status -->

---

## Review state=COMMENTED submitted=2026-04-17T06:26:49Z



---

## Review state=COMMENTED submitted=2026-04-17T06:27:48Z



---

## Review state=COMMENTED submitted=2026-04-17T15:50:25Z

**Actionable comments posted: 1**

<details>
<summary>🧹 Nitpick comments (1)</summary><blockquote>

<details>
<summary>package.json (1)</summary><blockquote>

`29-29`: **Redundant target args passed to electron-builder.**

`build.win.target` already lists `nsis` and `portable` (lines 122‑125), so passing `--win nsis portable` on the CLI duplicates the configuration. Not harmful, but if someone updates the config-side targets later, the CLI override here will silently mask the change. Consider dropping the CLI flags (`electron-builder --win`) so the build config is the single source of truth — same goes for `dist:linux`.

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against the current code and only fix it if needed.

In `@package.json` at line 29, The npm script "dist:windows" is passing explicit
CLI target flags ("--win nsis portable") that duplicate and can override the
build configuration; update the script(s) so electron-builder relies on the
package.json build config only (remove the "--win nsis portable" from
"dist:windows" and likewise remove any explicit platform/target flags from
"dist:linux") so build.targets in package.json is the single source of truth.
```

</details>

</blockquote></details>

</blockquote></details>

<details>
<summary>🤖 Prompt for all review comments with AI agents</summary>

```
Verify each finding against the current code and only fix it if needed.

Inline comments:
In `@scripts/dev.js`:
- Around line 12-18: Validate and sanitize the CODESURF_MAX_OLD_SPACE_SIZE_MB
env before building jsFlags and avoid passing a shell-interpolated command to
execSync: parseInt(process.env.CODESURF_MAX_OLD_SPACE_SIZE_MB, 10) (falling back
to 8192) and ensure it's a finite positive integer within a sensible range; if
invalid, log a clear error and exit non-zero. Replace the execSync call with
spawnSync('electron-vite', ['dev', '--', `--js-flags=--expose-gc
--max-old-space-size=${validatedValue}`], { stdio: 'inherit', env: process.env
}) and then inspect spawnResult.status (or spawnResult.signal) and call
process.exit(status || 0) so child failures (including Ctrl-C) produce a clean
exit instead of throwing; reference maxOldSpace, jsFlags, execSync and switch to
spawnSync.

---

Nitpick comments:
In `@package.json`:
- Line 29: The npm script "dist:windows" is passing explicit CLI target flags
("--win nsis portable") that duplicate and can override the build configuration;
update the script(s) so electron-builder relies on the package.json build config
only (remove the "--win nsis portable" from "dist:windows" and likewise remove
any explicit platform/target flags from "dist:linux") so build.targets in
package.json is the single source of truth.
```

</details>

<details>
<summary>🪄 Autofix (Beta)</summary>

Fix all unresolved CodeRabbit comments on this PR:

- [ ] <!-- {"checkboxId": "4b0d0e0a-96d7-4f10-b296-3a18ea78f0b9"} --> Push a commit to this branch (recommended)
- [ ] <!-- {"checkboxId": "ff5b1114-7d8c-49e6-8ac1-43f82af23a33"} --> Create a new PR with the fixes

</details>

---

<details>
<summary>ℹ️ Review info</summary>

<details>
<summary>⚙️ Run configuration</summary>

**Configuration used**: defaults

**Review profile**: CHILL

**Plan**: Pro

**Run ID**: `f52d4a3b-ed30-4e91-95a9-7d1adcc5f9a7`

</details>

<details>
<summary>📥 Commits</summary>

Reviewing files that changed from the base of the PR and between 32f75fe928ded68268ef224bc45e66b67d771216 and d936d0977650c9167d46d8cef526037d7509fe3a.

</details>

<details>
<summary>📒 Files selected for processing (2)</summary>

* `package.json`
* `scripts/dev.js`

</details>

</details>

<!-- This is an auto-generated comment by CodeRabbit for review status -->

---

## Review state=COMMENTED submitted=2026-04-18T18:31:47Z

**Actionable comments posted: 1**

<details>
<summary>🤖 Prompt for all review comments with AI agents</summary>

```
Verify each finding against the current code and only fix it if needed.

Inline comments:
In `@package.json`:
- Around line 35-36: The rebuild npm script needs to run the Windows node-pty
patch like postinstall does; update the "rebuild" script in package.json so it
invokes the patch script (scripts/patch-node-pty-win.js) before calling
electron-rebuild for better-sqlite3 and node-pty, mirroring the ordering used in
"postinstall" to avoid Windows rebuild failures when running npm run rebuild
directly.
```

</details>

<details>
<summary>🪄 Autofix (Beta)</summary>

Fix all unresolved CodeRabbit comments on this PR:

- [ ] <!-- {"checkboxId": "4b0d0e0a-96d7-4f10-b296-3a18ea78f0b9"} --> Push a commit to this branch (recommended)
- [ ] <!-- {"checkboxId": "ff5b1114-7d8c-49e6-8ac1-43f82af23a33"} --> Create a new PR with the fixes

</details>

---

<details>
<summary>ℹ️ Review info</summary>

<details>
<summary>⚙️ Run configuration</summary>

**Configuration used**: defaults

**Review profile**: CHILL

**Plan**: Pro

**Run ID**: `440fd4df-e3d0-4908-881b-cea2668bc9fa`

</details>

<details>
<summary>📥 Commits</summary>

Reviewing files that changed from the base of the PR and between 32f75fe928ded68268ef224bc45e66b67d771216 and 964424b37028c357c5e18f5eee6f1f79ea75e969.

</details>

<details>
<summary>📒 Files selected for processing (8)</summary>

* `package.json`
* `scripts/dev.js`
* `src/main/index.ts`
* `src/preload/index.ts`
* `src/renderer/src/App.tsx`
* `src/renderer/src/components/Sidebar.tsx`
* `src/renderer/src/env.d.ts`
* `src/shared/types.ts`

</details>

<details>
<summary>✅ Files skipped from review due to trivial changes (1)</summary>

* src/shared/types.ts

</details>

<details>
<summary>🚧 Files skipped from review as they are similar to previous changes (5)</summary>

* src/renderer/src/components/Sidebar.tsx
* scripts/dev.js
* src/main/index.ts
* src/preload/index.ts
* src/renderer/src/App.tsx

</details>

</details>

<!-- This is an auto-generated comment by CodeRabbit for review status -->

---

