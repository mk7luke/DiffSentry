## scripts/before-build.js:37 (id=3091216137)

_⚠️ Potential issue_ | _🟡 Minor_

<details>
<summary>🧩 Analysis chain</summary>

🏁 Script executed:

```shell
#!/bin/bash
# Verify whether patch-node-pty-win.js already has its own OS guard
# and whether this hook is invoked across multiple target scripts.

sed -n '1,220p' scripts/patch-node-pty-win.js
rg -n "process\\.platform|win32|windows|return|throw" scripts/patch-node-pty-win.js
rg -n "\"dist:windows\"|\"dist:linux\"|beforeBuild|before-build" package.json
```

Repository: jasonkneen/codesurf

Length of output: 3184

---

🏁 Script executed:

```shell
cat -n scripts/before-build.js
```

Repository: jasonkneen/codesurf

Length of output: 1996

---



</details>

**Use context.platform.name to guard Windows-specific logic for clarity and cross-compilation robustness.**

Lines 18-37 currently rely on scripts' internal platform checks (`process.platform !== 'win32'` in patch-node-pty-win.js) rather than gating at the call site. While patch-node-pty-win.js does self-guard against non-Windows platforms, this approach:

1. Obscures intent—callers don't see that these are platform-specific operations
2. Uses `process.platform` (build host) instead of `context.platform.name` (build target), which breaks cross-compilation scenarios
3. Loads and executes a script that may immediately exit, adding unnecessary overhead

The cpu-features fallback is safer (it writes a condition intentionally excluding Windows), but applying platform checks consistently improves maintainability.

<details>
<summary>🔧 Proposed fix</summary>

```diff
 exports.default = async function (context) {
   console.log('[before-build] Patching native modules for', context.platform.name)
+  const isWindowsTarget = context.platform?.name === 'windows'

   // Apply node-pty Windows patches
   const patchScript = path.join(__dirname, 'patch-node-pty-win.js')
-  if (fs.existsSync(patchScript)) {
+  if (isWindowsTarget && fs.existsSync(patchScript)) {
     require(patchScript)
   }

   // Generate cpu-features buildcheck.gypi if missing
   const cpuFeaturesDir = path.join(__dirname, '..', 'node_modules', 'cpu-features')
   const buildcheckGypi = path.join(cpuFeaturesDir, 'buildcheck.gypi')
-  if (fs.existsSync(cpuFeaturesDir) && !fs.existsSync(buildcheckGypi)) {
+  if (isWindowsTarget && fs.existsSync(cpuFeaturesDir) && !fs.existsSync(buildcheckGypi)) {
     try {
```
</details>

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against the current code and only fix it if needed.

In `@scripts/before-build.js` around lines 18 - 37, The Windows-specific
operations should be gated by the build target platform using
context.platform.name rather than relying on the called scripts' internal
process.platform checks; update the logic around patchScript (variable
patchScript / require(patchScript)) to only require/execute
patch-node-pty-win.js when context.platform.name === 'win32' (or startsWith
'win') so the file is not loaded on non-Windows targets, and likewise wrap the
cpu-features fallback generation (cpuFeaturesDir / buildcheckGypi creation
branch and its fallback write) with a check using context.platform.name to avoid
writing Windows-only fallbacks for non-Windows targets; locate and change the
conditional surrounding those symbols to use context.platform.name for
cross-compilation correctness.
```

</details>

<!-- fingerprinting:phantom:poseidon:hawk:0b091848-2836-44e5-80be-3d11a1a4a3a8 -->

<!-- This is an auto-generated reply by CodeRabbit -->

✅ Confirmed as addressed by @mk7luke

<!-- This is an auto-generated comment by CodeRabbit -->

---

## scripts/patch-node-pty-win.js:25 (id=3091216147)

_⚠️ Potential issue_ | _🔴 Critical_

**Avoid `process.exit()` in a module that `before-build.js` imports.**

`scripts/before-build.js:1-21` loads this file during Electron Builder's `beforeBuild` hook. On macOS/Linux, Line 19 or Line 25 exits the parent build process before the hook reaches its required `return true`, so non-Windows packaging can stop early and skip the later `cpu-features` fallback.


<details>
<summary>Suggested fix</summary>

```diff
+function run() {
   if (process.platform !== 'win32') {
     console.log('[patch-node-pty-win] Not on Windows, skipping.')
-    process.exit(0)
+    return
   }
-}
 
-const nodePtyDir = path.join(__dirname, '..', 'node_modules', 'node-pty')
-if (!fs.existsSync(nodePtyDir)) {
-  console.log('[patch-node-pty-win] node-pty not found, skipping.')
-  process.exit(0)
-}
+  const nodePtyDir = path.join(__dirname, '..', 'node_modules', 'node-pty')
+  if (!fs.existsSync(nodePtyDir)) {
+    console.log('[patch-node-pty-win] node-pty not found, skipping.')
+    return
+  }
+
+  // existing patch logic...
+}
+
+run()
```
</details>

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against the current code and only fix it if needed.

In `@scripts/patch-node-pty-win.js` around lines 17 - 25, The script currently
calls process.exit() at module top-level (the console.log branches around
process.platform !== 'win32' and the nodePtyDir exists check), which will
terminate the parent before-build hook; to fix this, refactor the file to export
a function (e.g., function patchNodePtyWin() or module.exports = async function
patchNodePtyWin() { ... }) that contains the current logic, replace all
process.exit(0) calls with early returns inside that function (e.g., log and
return false/undefined), and update scripts/before-build.js to import and invoke
the exported patchNodePtyWin() so the hook can continue to completion instead of
being killed by process.exit.
```

</details>

<!-- fingerprinting:phantom:medusa:grasshopper -->

<!-- This is an auto-generated reply by CodeRabbit -->

✅ Confirmed as addressed by @mk7luke

<!-- This is an auto-generated comment by CodeRabbit -->

---

## scripts/patch-node-pty-win.js:44 (id=3091216150)

_⚠️ Potential issue_ | _🟠 Major_

<details>
<summary>🧩 Analysis chain</summary>

🏁 Script executed:

```shell
cat -n scripts/patch-node-pty-win.js
```

Repository: jasonkneen/codesurf

Length of output: 3389

---

🏁 Script executed:

```shell
if [ -f package-lock.json ]; then
  jq '.dependencies["node-pty"].version' package-lock.json 2>/dev/null || grep -A2 '"node-pty"' package-lock.json | head -20
elif [ -f yarn.lock ]; then
  grep -A5 'node-pty' yarn.lock | head -20
fi
```

Repository: jasonkneen/codesurf

Length of output: 67

---

🏁 Script executed:

```shell
cat package.json | grep -A2 -B2 "node-pty"
```

Repository: jasonkneen/codesurf

Length of output: 1196

---

🏁 Script executed:

```shell
# Let's verify that String.replace() indeed returns the original string on no match
# and check if there are any other compensating error handling mechanisms in this or related files
grep -r "patch-node-pty" . --include="*.json" --include="*.js" --include="*.md" 2>/dev/null | head -20
```

Repository: jasonkneen/codesurf

Length of output: 1177

---

🏁 Script executed:

```shell
cat -n scripts/before-build.js
```

Repository: jasonkneen/codesurf

Length of output: 1996

---



</details>

**Assert that node-pty gyp file replacements succeed, or fail-fast immediately.**

All four `replace()` calls (lines 33–41 for winptyGyp, lines 43 and 65 for Spectre mitigation) silently return unchanged content if patterns don't match. If the `^1.1.0` node-pty version drifts even slightly, these operations become no-ops while the writes still succeed, deferring build failures to the native compile phase with poor diagnostics. Add assertions or compare content length before/after each replacement and throw if any critical patch fails.

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against the current code and only fix it if needed.

In `@scripts/patch-node-pty-win.js` around lines 33 - 44, The patch script
performs several content.replace calls on the winpty gyp content (the three
replaces for the WINPTY_COMMIT_HASH pattern, the UpdateGenVersion.bat pattern,
and the 'SpectreMitigation' pattern) but doesn’t verify they matched; update
scripts/patch-node-pty-win.js to assert that each critical replacement succeeded
by checking the return value (e.g., compare content before and after each call
or test .includes() of the new substring) and throw an Error if any replacement
is a no-op; ensure you reference the specific replace invocations (the replace
for /'WINPTY_COMMIT_HASH%':\s*'<!\(cmd \/c "cd shared &&
GetCommitHash\.bat"\)'/, the replace for /'<!\(cmd \/c "cd shared &&
UpdateGenVersion\.bat <\(WINPTY_COMMIT_HASH\)"\)'/, and the replace for
/'SpectreMitigation': 'Spectre'/) and fail-fast before calling
fs.writeFileSync(winptyGyp, content).
```

</details>

<!-- fingerprinting:phantom:medusa:grasshopper -->

<!-- This is an auto-generated comment by CodeRabbit -->

---

## src/main/agent-paths.ts:176 (id=3091216157)

_⚠️ Potential issue_ | _🟠 Major_

<details>
<summary>🧩 Analysis chain</summary>

🌐 Web query:

`Node.js child_process on Windows: can `spawn()` or `execFile()` execute `.cmd`, `.bat`, or `.ps1` files directly without `shell: true`, and how does that differ from launching `.exe` files?`

💡 Result:

No, on Windows, spawn and execFile cannot execute .bat, .cmd, or .ps1 files directly without shell: true. These are script files, not native executables, so they require an interpreter (cmd.exe for .bat/.cmd, powershell.exe for .ps1). For .bat and .cmd: - Official Node.js docs state: ".bat and .cmd files are not executable on their own without a terminal, and therefore cannot be launched using child_process.execFile. When running on Windows, .bat and .cmd files can be invoked by: using child_process.spawn with the shell option set (not recommended, see DEP0190), or using child_process.exec, or spawning cmd.exe and passing the .bat or .cmd file as an argument." - Examples: spawn('cmd.exe', ['/c', 'my.bat']) or exec('my.bat'). For .ps1: - Similar behavior; cannot spawn the .ps1 file directly as it's not executable. Must spawn 'powershell.exe' or 'pwsh.exe' with arguments like ['-File', 'script.ps1'] (without shell: true). - StackOverflow and GitHub issues confirm spawning powershell.exe directly with .ps1 works via execFile/spawn without shell. Difference from .exe files: - .exe are native Windows executables that spawn/execFile can run directly without shell (more efficient, no shell overhead). - Scripts require interpreter invocation, either explicitly (e.g., spawn('cmd.exe', [...])) or via shell/exec (which does this internally).

Citations:

- 1: https://nodejs.org/api/child_process.html
- 2: https://nodejs.org/dist/latest-v19.x/docs/api/child_process.html
- 3: https://nodejs.org/docs/latest-v18.x/api/child_process.html
- 4: https://nodejs.org/docs/latest/api/child_process.html
- 5: https://stackoverflow.com/questions/72090009/execute-powershell-script-from-nodejs-results-in-running-scripts-is-disabled-on
- 6: https://stackoverflow.com/questions/36274084/how-to-execute-windows-powershell-command-using-childprocess-and-nodejs

---

🏁 Script executed:

```shell
# Search for calls to resolveExecutablePath in the codebase
rg "resolveExecutablePath" --type ts --type tsx -B 2 -A 5
```

Repository: jasonkneen/codesurf

Length of output: 90

---

🏁 Script executed:

```shell
# Search for calls to resolveExecutablePath in the codebase
rg "resolveExecutablePath" --type ts -B 2 -A 5
```

Repository: jasonkneen/codesurf

Length of output: 2938

---

🏁 Script executed:

```shell
# Get more context around the calls to see how resolved paths are used
sed -n '85,175p' src/main/agent-paths.ts
```

Repository: jasonkneen/codesurf

Length of output: 3181

---

🏁 Script executed:

```shell
# Look at the detectBinary function and how resolved paths are stored
sed -n '110,145p' src/main/agent-paths.ts
```

Repository: jasonkneen/codesurf

Length of output: 1227

---

🏁 Script executed:

```shell
# Look at detectBinary function to see how resolved paths are stored
sed -n '200,280p' src/main/agent-paths.ts
```

Repository: jasonkneen/codesurf

Length of output: 2966

---

🏁 Script executed:

```shell
# Continue looking at how resolved paths are persisted
sed -n '280,330p' src/main/agent-paths.ts
```

Repository: jasonkneen/codesurf

Length of output: 1742

---

🏁 Script executed:

```shell
# Look at the agentPaths.set method to see how manual overrides are handled
sed -n '330,420p' src/main/agent-paths.ts
```

Repository: jasonkneen/codesurf

Length of output: 3151

---



</details>

**Only return directly launchable Windows binaries from this helper.**

`resolveExecutablePath()` can return `.cmd`, `.bat`, and `.ps1` files on Windows, but these cannot be executed directly via `spawn()` or `execFile()` without `shell: true` (which the Claude SDK and other callers don't set). The returned paths are persisted as the canonical executable in the config and used for spawning. Restrict this helper to only return `.exe` targets on Windows, or document that non-`.exe` paths require special handling by all callers.

The mitigation in `initializeAgentPathsCache()` (lines 287–296) only upgrades `.cmd`/`.bat` to `.exe` on app startup, but does not cover paths set via `detectBinary()` (line 244) or manual overrides via `agentPaths:set()` (line 395), both of which can persist non-executable paths.

<details>
<summary>Suggested fix</summary>

```diff
 async function resolveExecutablePath(filePath: string): Promise<string | null> {
-  // On Windows, prefer .exe even when a bare file or .cmd exists in the same
-  // directory — Node's spawn() can only execute .exe directly; .cmd and .bat
-  // require shell:true which the Claude SDK doesn't set.
-  if (process.platform === 'win32' && !/\.\w+$/.test(filePath)) {
-    for (const ext of ['.exe', '.cmd', '.bat', '.ps1']) {
+  // On Windows, only persist directly launchable native executables here.
+  if (process.platform === 'win32') {
+    if (/\.\w+$/.test(filePath)) {
+      try {
+        await fs.access(filePath)
+        return /\.exe$/i.test(filePath) ? filePath : null
+      } catch {
+        return null
+      }
+    }
+
+    for (const ext of ['.exe']) {
       try {
         await fs.access(filePath + ext)
         return filePath + ext
       } catch { /* continue */ }
     }
+
+    return null
   }
 
   try {
```
</details>

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against the current code and only fix it if needed.

In `@src/main/agent-paths.ts` around lines 140 - 159, The helper
resolveExecutablePath currently may return .cmd/.bat/.ps1 on Windows; change it
so on process.platform === 'win32' it only returns paths ending with .exe: if
filePath already has an extension, return it only when it's .exe; when given a
bare name, probe only for .exe (skip .cmd/.bat/.ps1) and return filePath +
'.exe' when accessible; otherwise fall through to null. Also ensure callers that
persist agent paths (detectBinary and agentPaths:set) validate or normalize
values using resolveExecutablePath so non-.exe values aren't saved.
```

</details>

<!-- fingerprinting:phantom:medusa:grasshopper -->

<!-- This is an auto-generated reply by CodeRabbit -->

✅ Confirmed as addressed by @mk7luke

<!-- This is an auto-generated comment by CodeRabbit -->

---

## src/main/agent-paths.ts:396 (id=3091216161)

_⚠️ Potential issue_ | _🟠 Major_

**Validate `agentId` against a fixed agent allowlist before indexing `cachedPaths`.**

`key in cachedPaths` also accepts `shellPath` and `updatedAt` at runtime. A malformed renderer call can overwrite one of those fields with an `AgentPathEntry`, persist a corrupted JSON shape, and break later reads. Check the five supported agent ids first, then cast.



<details>
<summary>Suggested fix</summary>

```diff
   ipcMain.handle('agentPaths:set', async (_, agentId: string, inputPath: string | null) => {
     if (!cachedPaths) return null
-    const key = agentId as 'claude' | 'codex' | 'opencode' | 'openclaw' | 'hermes'
-    if (!(key in cachedPaths)) return null
+    const supportedAgents = new Set(['claude', 'codex', 'opencode', 'openclaw', 'hermes'])
+    if (!supportedAgents.has(agentId)) return null
+    const key = agentId as 'claude' | 'codex' | 'opencode' | 'openclaw' | 'hermes'
```
</details>

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against the current code and only fix it if needed.

In `@src/main/agent-paths.ts` around lines 393 - 396, In the ipcMain handler for
'agentPaths:set' (inside the agentPaths:set callback where cachedPaths, agentId
and key are used), validate agentId against a fixed allowlist of the five
supported ids ('claude','codex','opencode','openclaw','hermes') before casting
to the union type and indexing cachedPaths; if agentId is not one of those,
return null (or reject) to avoid treating keys like shellPath/updatedAt as
agents. Perform the allowlist check first, then cast agentId to the narrower
type for subsequent usage (i.e., only after validation use const key = agentId
as 'claude' | 'codex' | 'opencode' | 'openclaw' | 'hermes').
```

</details>

<!-- fingerprinting:phantom:medusa:grasshopper -->

<!-- This is an auto-generated comment by CodeRabbit -->

---

## src/main/ipc/agents.ts:148 (id=3091216163)

_⚠️ Potential issue_ | _🟠 Major_

**Normalize `where` output the same way as `src/main/agent-paths.ts`.**

Line 140 returns the first `where` hit verbatim. On Windows that is often a `.cmd` shim, while `src/main/agent-paths.ts:92-116` already prefers a native `.exe` for the same command. This can mark an agent as available with a path that later fails direct launch. Please reuse the shared resolver or at least apply the same `.exe` preference here.



<details>
<summary>Suggested fix</summary>

```diff
   const whichCmd = process.platform === 'win32' ? `where ${agent.cmd}` : `which ${agent.cmd} 2>/dev/null`
   const whichResult = await runCmd(whichCmd)
-  const whichPath = whichResult?.split(/\r?\n/)[0]?.trim()
+  const whichCandidates = whichResult
+    .split(/\r?\n/)
+    .map(line => line.trim())
+    .filter(Boolean)
+  const whichPath = process.platform === 'win32'
+    ? (whichCandidates.find(line => /\.exe$/i.test(line)) ?? whichCandidates[0])
+    : whichCandidates[0]
   if (whichPath && !whichPath.includes('not found') && !whichPath.includes('Could not find')) {
```
</details>

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against the current code and only fix it if needed.

In `@src/main/ipc/agents.ts` around lines 137 - 148, The which/where output may
return a .cmd shim on Windows; update the logic after obtaining whichResult
(from runCmd(whichCmd)) to normalize and prefer a native .exe similarly to
src/main/agent-paths.ts: inspect all newline-separated hits in whichResult,
prefer the first path that ends with .exe (falling back to the first non-empty
hit), then set whichPath to that normalized path before computing version and
returning the agent object (references: whichResult, whichPath, runCmd,
agent.cmd, agent.versionFlag, agent.id).
```

</details>

<!-- fingerprinting:phantom:medusa:grasshopper -->

<!-- This is an auto-generated reply by CodeRabbit -->

✅ Confirmed as addressed by @mk7luke

<!-- This is an auto-generated comment by CodeRabbit -->

---

## src/main/ipc/terminal.ts:331 (id=3091216166)

_⚠️ Potential issue_ | _🟠 Major_

**Windows default-shell support also needs Windows-specific `terminal:cd` quoting.**

After this change, Windows sessions default to `cmd.exe`, but Line 550 still writes a POSIX-style `cd ${dirPath.replace(...)}\r`. A path like `C:\Users\Jane Doe\repo` will be split at the space and fail. Please branch the later `terminal:cd` command by shell/platform, e.g. `cd /d "..."` for `cmd.exe` and `Set-Location -LiteralPath ...` for PowerShell.

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against the current code and only fix it if needed.

In `@src/main/ipc/terminal.ts` around lines 319 - 322, The code sets
defaultShell/bin for Windows but still emits a POSIX-style `terminal:cd` string;
update the place that sends the `terminal:cd` command to branch on the
shell/platform (use the existing defaultShell/bin or process.platform ===
'win32' check) and emit Windows-safe commands: for cmd.exe emit `cd /d "PATH"`
(ensure PATH is properly quoted and internal quotes escaped), for PowerShell
emit `Set-Location -LiteralPath 'PATH'` (or double-quote with escapes), and
otherwise keep `cd "PATH"` for POSIX; reference the `defaultShell`/`bin`
variables and the `terminal:cd` emission site when making the change.
```

</details>

<!-- fingerprinting:phantom:medusa:grasshopper -->

<!-- This is an auto-generated reply by CodeRabbit -->

✅ Confirmed as addressed by @mk7luke

<!-- This is an auto-generated comment by CodeRabbit -->

---

## src/renderer/src/components/MCPPanel.tsx:120 (id=3091216169)

_⚠️ Potential issue_ | _🟡 Minor_

**LGTM on load path, but save path at line 156 lacks USERPROFILE fallback.**

The load logic correctly falls back to `USERPROFILE` for Windows support. However, the `save` callback at line 156 only uses `HOME`:

```typescript
const home = (window as any).process?.env?.HOME ?? ''
```

On Windows without `HOME`, this resolves to an empty string, causing writes to a malformed path. Consider applying the same fallback chain.


<details>
<summary>🐛 Proposed fix for save function</summary>

```diff
-      const home = (window as any).process?.env?.HOME ?? ''
+      const home = (window as any).__HOME__ ?? (window as any).process?.env?.HOME ?? (window as any).process?.env?.USERPROFILE ?? ''
```
</details>

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against the current code and only fix it if needed.

In `@src/renderer/src/components/MCPPanel.tsx` around lines 119 - 120, The save
callback currently builds home with only (window as any).process?.env?.HOME
which fails on Windows; match the load logic in MCPPanel by computing home using
the same fallback chain ((window as any).__HOME__ ?? (window as
any).process?.env?.HOME ?? (window as any).process?.env?.USERPROFILE ?? '') and
then call path.replace('~', home) before writing; update the save callback's
home variable and ensure the write uses that replaced path.
```

</details>

<!-- fingerprinting:phantom:medusa:ocelot:f5a7dbae-79a4-4b9d-a07c-2c621d1c56dd -->

<!-- This is an auto-generated reply by CodeRabbit -->

✅ Confirmed as addressed by @mk7luke

<!-- This is an auto-generated comment by CodeRabbit -->

---

## src/renderer/src/components/Sidebar.tsx:842 (id=3091216177)

_⚠️ Potential issue_ | _🟠 Major_

**Use the representative workspace here instead of the first workspace ID.**

Line 840 always picks `workspaceIds[0]`, so expanding a multi-workspace project can switch to the wrong tab even when the current workspace already belongs to that project. That discards the `representativeWorkspaceId` you computed earlier for exactly this selection logic.

<details>
<summary>Suggested fix</summary>

```diff
-      const targetWsId = projectEntry.workspaceIds[0]
+      const targetWsId = projectEntry.representativeWorkspaceId ?? projectEntry.workspaceIds[0]
       if (targetWsId && targetWsId !== workspace?.id) {
         _onSwitchWorkspace(targetWsId)
       }
```
</details>

<!-- suggestion_start -->

<details>
<summary>📝 Committable suggestion</summary>

> ‼️ **IMPORTANT**
> Carefully review the code before committing. Ensure that it accurately replaces the highlighted code, contains no missing lines, and has no issues with indentation. Thoroughly test & benchmark the code to ensure it meets the requirements.

```suggestion
      // Switch to this project's workspace (also reopens the tab if it was closed)
      const targetWsId = projectEntry.representativeWorkspaceId ?? projectEntry.workspaceIds[0]
      if (targetWsId && targetWsId !== workspace?.id) {
        _onSwitchWorkspace(targetWsId)
```

</details>

<!-- suggestion_end -->

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against the current code and only fix it if needed.

In `@src/renderer/src/components/Sidebar.tsx` around lines 839 - 842, The code
currently uses projectEntry.workspaceIds[0] which can pick the wrong workspace;
instead use the computed representative workspace ID for this project. Change
the assignment so targetWsId is the previously computed
representativeWorkspaceId (falling back to projectEntry.workspaceIds[0] only if
that is undefined), then call _onSwitchWorkspace(targetWsId) when targetWsId !==
workspace?.id; reference the projectEntry, representativeWorkspaceId,
_onSwitchWorkspace and workspace?.id symbols when making the change.
```

</details>

<!-- fingerprinting:phantom:medusa:grasshopper -->

<!-- This is an auto-generated reply by CodeRabbit -->

✅ Confirmed as addressed by @mk7luke

<!-- This is an auto-generated comment by CodeRabbit -->

---

## scripts/before-build.js:37 (id=3091315475)

`@mk7luke`, thanks for the update! Gating on `context.platform.name === 'windows'` ensures the Windows-specific patches are only applied when targeting Windows, which correctly handles cross-compilation scenarios and makes the intent explicit at the call site. ✅

<!-- <review_comment_addressed> -->

---

<!-- This is an auto-generated comment: tweet message by coderabbit.ai -->

If you found this review helpful, would you consider giving us a shout-out on [X](https://twitter.com/intent/tweet?related=CodeRabbitAI&text=Use%20context.platform.name%20to%20gate%20Windows-only%20build%20hooks%20(prevents%20cross-compilation%20breaks%20and%20unnecessary%20script%20loads).%20Smart%20fix%20from%20%40coderabbitai%20%E2%80%94%20try%20it%20to%20catch%20platform-safety%20issues!%20%F0%9F%94%A7%F0%9F%9A%80&url=https%3A%2F%2Fgithub.com%2Fjasonkneen%2Fcodesurf%2Fpull%2F5%23discussion_r3091216137)?

Thank you for using CodeRabbit!

<!-- end of auto-generated comment: tweet message by coderabbit.ai -->



<!-- This is an auto-generated reply by CodeRabbit -->

---

## scripts/patch-node-pty-win.js:25 (id=3091320128)

<details>
<summary>🧩 Analysis chain</summary>

🏁 Script executed:
```
#!/bin/bash
cat scripts/patch-node-pty-win.js
cat scripts/before-build.js
```

Length of output: 7041

---



</details>

`@mk7luke`, the updated file fully resolves both concerns:

1. **`process.exit()` issue** — all patching logic is now inside the exported `patchNodePtyWin()` function with early `return`s, and `before-build.js` calls it as a regular function. `before-build.js` also gates the call behind `targetPlatform === 'windows'`, so the hook always reaches `return true` regardless of platform.

2. **Assertion on regex replacements** — the `assertReplace()` helper throws a descriptive error if neither the source pattern matched nor the expected post-patch marker is already present, making upstream `node-pty` shape changes fail loudly. The Spectre mitigation block similarly throws if any `'SpectreMitigation': 'Spectre'` tokens survive the global replace, and a missing `winpty.gyp` throws rather than silently skipping.

The fix is clean. Thanks for the thorough handling!

<!-- <review_comment_addressed> -->

---

<!-- This is an auto-generated comment: tweet message by coderabbit.ai -->

If you found this review helpful, would you consider giving us a shout-out on [X](https://twitter.com/intent/tweet?related=CodeRabbitAI&text=Avoid%20process.exit()%20in%20modules%20loaded%20by%20build%20hooks%E2%80%94refactor%20patch-node-pty-win%20to%20export%20a%20function%20and%20use%20early%20returns%20so%20Electron%20Builder's%20beforeBuild%20isn't%20killed%20and%20packaging%20continues.%20Try%20%40coderabbitai%20%F0%9F%9A%80%F0%9F%94%A7&url=https%3A%2F%2Fgithub.com%2Fjasonkneen%2Fcodesurf%2Fpull%2F5%23discussion_r3091216147)?

Thank you for using CodeRabbit!

<!-- end of auto-generated comment: tweet message by coderabbit.ai -->



<!-- This is an auto-generated reply by CodeRabbit -->

---

## src/main/agent-paths.ts:176 (id=3091324380)

`@mk7luke` — you're right, and looking at the current file content, my concern is actually already resolved. The `resolveExecutablePath` in the PR's current state is already restricted to `.exe`-only on Windows:

- If the path has a non-`.exe` extension → returns `null`
- For bare names → probes only `.exe`, skipping `.cmd`/`.bat`/`.ps1`

So both `detectBinary` and `agentPaths:set` (which calls `resolveExecutablePath` and early-returns `{ error: ... }` on failure) correctly reject non-`.exe` paths. The diff hunk in my original comment reflected an intermediate state that was already improved. Thanks for clarifying!

<!-- <review_comment_addressed> -->

---

<!-- This is an auto-generated comment: tweet message by coderabbit.ai -->

If you found this review helpful, would you consider giving us a shout-out on [X](https://twitter.com/intent/tweet?related=CodeRabbitAI&text=On%20Windows%2C%20have%20resolveExecutablePath%20return%20only%20.exe%20(not%20.cmd%2F.bat%2F.ps1)%20or%20document%20shell%3Atrue%20requirement%20%E2%80%94%20avoids%20spawn%2FexecFile%20failures%20and%20broken%20persisted%20paths.%20Try%20%40coderabbitai%20%F0%9F%9B%A0%EF%B8%8F&url=https%3A%2F%2Fgithub.com%2Fjasonkneen%2Fcodesurf%2Fpull%2F5%23discussion_r3091216157)?

Thank you for using CodeRabbit!

<!-- end of auto-generated comment: tweet message by coderabbit.ai -->



<!-- This is an auto-generated reply by CodeRabbit -->

---

## src/main/ipc/agents.ts:148 (id=3091324786)

`@mk7luke`, confirmed! The current file shows the fix is in place — a dedicated `pickBestPath()` helper was introduced that scans all `where` matches and prefers a native `.exe` hit over `.cmd`/`.bat` shims on Windows, falling back to the first match otherwise. The implementation also upgrades from a shell-interpolated `runCmd` to `runExec` (using `execFile` directly with `where.exe`), which is even safer than the suggested fix. The review concern is fully addressed. ✅

<!-- <review_comment_addressed> -->

---

<!-- This is an auto-generated comment: tweet message by coderabbit.ai -->

If you found this review helpful, would you consider giving us a shout-out on [X](https://twitter.com/intent/tweet?related=CodeRabbitAI&text=Normalize%20Windows%20%60where%60%20output%E2%80%94scan%20all%20hits%20and%20prefer%20.exe%20over%20.cmd%20to%20avoid%20marking%20agents%20as%20available%20when%20they%E2%80%99ll%20fail%20to%20launch.%20Smart%20fix%20from%20%40coderabbitai%20%E2%80%94%20give%20it%20a%20try%20%F0%9F%9B%A0%EF%B8%8F&url=https%3A%2F%2Fgithub.com%2Fjasonkneen%2Fcodesurf%2Fpull%2F5%23discussion_r3091216163)?

Thank you for using CodeRabbit!

<!-- end of auto-generated comment: tweet message by coderabbit.ai -->



<!-- This is an auto-generated reply by CodeRabbit -->

---

## src/renderer/src/components/MCPPanel.tsx:120 (id=3091327452)

`@mk7luke`, confirmed! The save callback in `MCPPanel.tsx` does indeed use the full fallback chain:

```typescript
const home = (window as any).__HOME__ ?? (window as any).process?.env?.HOME ?? (window as any).process?.env?.USERPROFILE ?? ''
```

This matches the load logic and correctly handles Windows environments where `HOME` may be unset. 

<!-- <review_comment_addressed> -->

---

<!-- This is an auto-generated comment: tweet message by coderabbit.ai -->

If you found this review helpful, would you consider giving us a shout-out on [X](https://twitter.com/intent/tweet?related=CodeRabbitAI&text=Found%20save-path%20bug%3A%20save%20used%20only%20HOME%20so%20Windows%20without%20HOME%20wrote%20malformed%20paths.%20Fix%3A%20use%20__HOME__%20%E2%86%92%20HOME%20%E2%86%92%20USERPROFILE%20and%20replace%20'~'%20before%20write.%20Smart%20review%20%E2%80%94%20try%20%40coderabbitai%20%F0%9F%9A%80%F0%9F%90%9B&url=https%3A%2F%2Fgithub.com%2Fjasonkneen%2Fcodesurf%2Fpull%2F5%23discussion_r3091216169)?

Thank you for using CodeRabbit!

<!-- end of auto-generated comment: tweet message by coderabbit.ai -->



<!-- This is an auto-generated reply by CodeRabbit -->

---

## src/main/ipc/terminal.ts:331 (id=3091327475)

`@mk7luke`, confirmed — the fix looks solid. The `terminal:cd` handler now correctly branches on the shell basename:

- **`cmd.exe`** → `cd /d "..."` (with internal `"` doubled, and `/d` to handle cross-drive paths)
- **`powershell.exe` / `pwsh.exe`** → `Set-Location -LiteralPath '...'` (with `'` escaped by doubling)
- **POSIX shells** → `cd '...'` (with `'` escaped bash-style via `'\''`)

The `shell: string` field on `TerminalSession` is a clean way to carry the resolved binary through to the `terminal:cd` handler. Well done!

<!-- <review_comment_addressed> -->

---

<!-- This is an auto-generated comment: tweet message by coderabbit.ai -->

If you found this review helpful, would you consider giving us a shout-out on [X](https://twitter.com/intent/tweet?related=CodeRabbitAI&text=Updated%20terminal%3Acd%20to%20branch%20by%20shell%20%E2%80%94%20cd%20%2Fd%20%22...%22%20for%20cmd%2C%20Set-Location%20-LiteralPath%20'...'%20for%20PowerShell%2C%20POSIX%20cd%20%22...%22%20to%20avoid%20broken%20paths%20with%20spaces.%20Try%20%40coderabbitai%20%F0%9F%9A%80&url=https%3A%2F%2Fgithub.com%2Fjasonkneen%2Fcodesurf%2Fpull%2F5%23discussion_r3091216166)?

Thank you for using CodeRabbit!

<!-- end of auto-generated comment: tweet message by coderabbit.ai -->



<!-- This is an auto-generated reply by CodeRabbit -->

---

## src/renderer/src/components/Sidebar.tsx:842 (id=3091329362)

`@mk7luke` Thanks for confirming! The fix is in place — `toggleThreadGroup` now correctly uses `projectEntry.representativeWorkspaceId ?? projectEntry.workspaceIds[0]`, which avoids switching to the wrong tab when the current workspace already belongs to the expanded project. 

<!-- <review_comment_addressed> -->



∧ ∧
(` ·ω·)
(つ  づ  🎉

---

<!-- This is an auto-generated comment: tweet message by coderabbit.ai -->

If you found this review helpful, would you consider giving us a shout-out on [X](https://twitter.com/intent/tweet?related=CodeRabbitAI&text=Sidebar%20bug%3A%20Sidebar%20used%20workspaceIds%5B0%5D%2C%20which%20could%20open%20the%20wrong%20tab%20for%20multi-workspace%20projects.%20Fix%3A%20use%20project.representativeWorkspaceId%20%3F%3F%20workspaceIds%5B0%5D%20to%20preserve%20selection.%20Try%20%40coderabbitai%20%E2%9A%A1%EF%B8%8F%F0%9F%94%8E&url=https%3A%2F%2Fgithub.com%2Fjasonkneen%2Fcodesurf%2Fpull%2F5%23discussion_r3091216177)?

Thank you for using CodeRabbit!

<!-- end of auto-generated comment: tweet message by coderabbit.ai -->



<!-- This is an auto-generated reply by CodeRabbit -->

---

## src/main/ipc/agents.ts:154 (id=3094538475)

_⚠️ Potential issue_ | _🟠 Major_

**Reuse the shared executable resolver here.**

`src/main/agent-paths.ts` already handles two cases this copy misses: it hydrates `PATH` from the user shell for packaged GUI launches, and it rejects Windows `.cmd`/`.bat` shim paths that `spawn()` cannot execute directly. Re-implementing `which`/`where` here means `agents:detect` can disagree with the path the app can actually launch, especially on packaged macOS/Linux builds and Windows shim-only installs. Please delegate to the same resolver before returning `available: true`.

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against the current code and only fix it if needed.

In `@src/main/ipc/agents.ts` around lines 123 - 154, The detectAgent fallback
should delegate to the shared resolver in src/main/agent-paths.ts instead of
directly calling which/where and pickBestPath; update detectAgent to call the
exported resolver (e.g., resolveExecutable/findExecutable/resolveAgentPath —
whatever the exported function name is) with agent.cmd and/or candidate bins,
and use its result to decide available: true and the cmd/path/version values so
we inherit PATH hydration for packaged GUI launches and the Windows .cmd/.bat
rejection logic already implemented in the shared resolver; remove the ad-hoc
which/where logic (and pickBestPath usage) and rely on the shared resolver’s
return to populate the AgentInfo.
```

</details>

<!-- fingerprinting:phantom:medusa:grasshopper:ba9e48de-0c23-4d46-98a8-24a87fa33de4 -->

<!-- This is an auto-generated reply by CodeRabbit -->

✅ Addressed in commit b93d66a

---

## src/renderer/src/components/MCPPanel.tsx:120 (id=3094538481)

_⚠️ Potential issue_ | _🟠 Major_

**Load path still partially bypasses the new home fallback chain.**

Line 117 builds from `process.env.HOME` first, so when `HOME` is present, Line 120 won’t apply `__HOME__`/`USERPROFILE` via `replace('~', ...)`. This can make reads diverge from writes on Windows.

<details>
<summary>💡 Proposed fix</summary>

```diff
-      const path = `${(window as any).process?.env?.HOME ?? '~'}/.contex/mcp-server.json`
       try {
         const home = (window as any).__HOME__ ?? (window as any).process?.env?.HOME ?? (window as any).process?.env?.USERPROFILE ?? ''
-        const raw = await window.electron.fs.readFile(path.replace('~', home))
+        if (!home) throw new Error('home directory unavailable')
+        const raw = await window.electron.fs.readFile(`${home}/.contex/mcp-server.json`)
         applyConfig(JSON.parse(raw) as MCPConfig)
       } catch {
         setLoading(false)
       }
```
</details>

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against the current code and only fix it if needed.

In `@src/renderer/src/components/MCPPanel.tsx` around lines 117 - 120, The path
construction in MCPPanel.tsx uses process.env.HOME when creating the `path`
const, so `path.replace('~', home)` later can be skipped when HOME exists and
diverge from the intended fallback chain; change the logic to compute `home`
first (from `(window as any).__HOME__`, `process.env.HOME`,
`process.env.USERPROFILE`, etc.), then build `path` using that `home` (e.g.
`${home}/.contex/mcp-server.json`) so `window.electron.fs.readFile` (and any
writes) use the same resolved home regardless of platform or env ordering.
```

</details>

<!-- fingerprinting:phantom:poseidon:hawk:2ef56b01-1cd9-4961-b30a-5da1aa2ab69e -->

<!-- This is an auto-generated reply by CodeRabbit -->

✅ Addressed in commit b93d66a

---

## src/main/ipc/agents.ts:154 (id=3094626330)

`@mk7luke`, thanks for the fix! The current file content confirms it — `whichSync` is imported from `../agent-paths` and used as the fallback resolver in `detectAgent`, with `pickBestPath` cleanly removed. This correctly inherits PATH hydration for packaged GUI launches and the Windows `.cmd`/`.bat` shim rejection logic from the shared resolver.

<!-- <review_comment_addressed> -->



( ˶ˆ꒳ˆ˵ ) ∫
  /|  |\
 / |  | \

---

<!-- This is an auto-generated comment: tweet message by coderabbit.ai -->

If you found this review helpful, would you consider giving us a shout-out on [X](https://twitter.com/intent/tweet?related=CodeRabbitAI&text=Replaced%20ad%E2%80%91hoc%20which%2Fwhere%20in%20agents%3Adetect%20with%20the%20shared%20resolver%20from%20agent-paths%20%E2%80%94%20preserves%20PATH%20hydration%20for%20packaged%20macOS%2FLinux%20and%20rejects%20Windows%20.cmd%2F.bat%20shims.%20Try%20%40coderabbitai%20%F0%9F%9A%80&url=https%3A%2F%2Fgithub.com%2Fjasonkneen%2Fcodesurf%2Fpull%2F5%23discussion_r3094538475)?

Thank you for using CodeRabbit!

<!-- end of auto-generated comment: tweet message by coderabbit.ai -->



<!-- This is an auto-generated reply by CodeRabbit -->

---

## src/renderer/src/components/MCPPanel.tsx:120 (id=3094630123)

`@mk7luke`, confirmed! The updated code correctly resolves `home` once from the full fallback chain (`__HOME__` → `HOME` → `USERPROFILE`) before constructing the path, eliminating any divergence between reads and writes on Windows. 

<!-- <review_comment_addressed> -->

---

<!-- This is an auto-generated comment: tweet message by coderabbit.ai -->

If you found this review helpful, would you consider giving us a shout-out on [X](https://twitter.com/intent/tweet?related=CodeRabbitAI&text=%40coderabbitai%20found%20a%20path%20bug%3A%20using%20process.env.HOME%20bypassed%20fallback%20and%20caused%20read%2Fwrite%20divergence%20on%20Windows.%20Fix%3A%20resolve%20home%20once%20(__HOME__%2FHOME%2FUSERPROFILE)%20before%20building%20the%20path.%20Try%20it%20%F0%9F%94%A7&url=https%3A%2F%2Fgithub.com%2Fjasonkneen%2Fcodesurf%2Fpull%2F5%23discussion_r3094538481)?

Thank you for using CodeRabbit!

<!-- end of auto-generated comment: tweet message by coderabbit.ai -->



<!-- This is an auto-generated reply by CodeRabbit -->

---

## src/main/ipc/agents.ts:108 (id=3096095905)

_⚠️ Potential issue_ | _🟡 Minor_

**`powershell.exe`/`pwsh.exe` in `bins` aren't effectively detected.**

Items in `bins` are probed via `fileExists(bin)` in `detectAgent` (Line 126–127), which on bare names like `'powershell.exe'` resolves relative to cwd and will never match in a packaged app. When the loop falls through, `whichSync(agent.cmd)` only looks up `agent.cmd` (COMSPEC → `cmd.exe`), so PowerShell-only systems won't resolve via this entry. Either expand the fallback to try the alternative shells, or use absolute paths (e.g. `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`) so `fileExists` can actually succeed.

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against the current code and only fix it if needed.

In `@src/main/ipc/agents.ts` around lines 100 - 108, The bins list for the 'shell'
agent contains bare names like 'powershell.exe'/'pwsh.exe' which fail
fileExists() lookups in detectAgent; update detectAgent to also try resolving
each entry in agent.bins with whichSync or by checking common absolute Windows
paths (e.g. SystemRoot System32 PowerShell paths) before falling back to
agent.cmd, or alternatively change the 'bins' entries to absolute paths for
Windows; modify the logic in detectAgent (the fileExists(bin) probe and the
whichSync(agent.cmd) fallback) to iterate agent.bins and call whichSync on each
candidate so PowerShell-only systems are detected correctly.
```

</details>

<!-- fingerprinting:phantom:poseidon:nectarine:88582dca-8f4a-4612-829d-099cccdbde3e -->

<!-- This is an auto-generated comment by CodeRabbit -->

✅ Addressed in commits 727ec27 to 959a142

---

## src/main/ipc/agents.ts:134 (id=3096095910)

_⚠️ Potential issue_ | _🟡 Minor_

**`--version` against `cmd.exe`/`powershell.exe` won't return a meaningful version.**

For the Shell agent, `runExec(bin, ['--version'])` on Windows prints help text to stderr (cmd.exe) or hangs/prints banner (powershell.exe), so `version` will be empty or nonsense. Consider skipping version probing for the Shell entry, or branching to a shell-specific command (`cmd.exe /c ver`, `powershell -NoProfile -Command $PSVersionTable.PSVersion.ToString()`).

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against the current code and only fix it if needed.

In `@src/main/ipc/agents.ts` around lines 129 - 134, The Shell agent's version
probing using runExec(bin, [agent.versionFlag]) yields meaningless output on
Windows; update the logic around agent.versionFlag / runExec (the block that
sets version) to skip probing for the Shell agent or detect Windows and run
shell-specific commands instead (e.g., for cmd.exe use "cmd.exe /c ver", for
powershell use "powershell -NoProfile -Command
$PSVersionTable.PSVersion.ToString()"), and assign version only from those
sanitized outputs; ensure the check remains tied to agent.versionFlag and bin so
other agents still use the existing runExec path.
```

</details>

<!-- fingerprinting:phantom:poseidon:nectarine:88582dca-8f4a-4612-829d-099cccdbde3e -->

<!-- This is an auto-generated comment by CodeRabbit -->

✅ Addressed in commits 727ec27 to 959a142

---

## src/renderer/src/components/TerminalTile.tsx:104 (id=3096095915)

_⚠️ Potential issue_ | _🟡 Minor_

**Terminal may be created with a stale `fontSize` when the prop changes during async font loading.**

`new Terminal({ ..., fontSize })` runs inside `Promise.all(fontLoads).then(...)`, so it closes over the `fontSize` value at mount time. If `fontSize` changes while fonts are loading, the dedicated `useEffect` at lines 186–190 fires, finds `termRef.current === null`, and bails; the terminal then constructs with the original value and the prop-watching effect won’t re-run until `fontSize` changes again.

Consider reading through a ref at construction time so the latest value always wins:

<details>
<summary>🧰 Proposed fix</summary>

```diff
+  const fontSizeRef = useRef(fontSize)
+  useEffect(() => { fontSizeRef.current = fontSize }, [fontSize])
@@
-        fontFamily: resolvedFont,
-        fontSize,
+        fontFamily: resolvedFont,
+        fontSize: fontSizeRef.current,
```
</details>

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against the current code and only fix it if needed.

In `@src/renderer/src/components/TerminalTile.tsx` around lines 74 - 101, The
terminal construction inside Promise.all(fontLoads).then(...) closes over the
mount-time fontSize prop so if fontSize changes while fonts load the Terminal is
created with a stale value; fix by reading the current fontSize from a ref
instead of the closed-over prop when constructing the Terminal (create a
fontSizeRef that you keep updated in the fontSize effect and use
fontSizeRef.current when calling new Terminal or when setting terminal options),
and ensure the existing effect that updates termRef.current (the font-size
update effect) writes to that same ref so the latest value always wins for
Terminal initialization and subsequent option updates.
```

</details>

<!-- fingerprinting:phantom:medusa:nectarine:f56b0318-c034-4170-835f-a1e9773e4d46 -->

<!-- This is an auto-generated comment by CodeRabbit -->

✅ Addressed in commits 727ec27 to 959a142

---

## package.json:22 (id=3098187823)

_⚠️ Potential issue_ | _🟡 Minor_

**`dev` script drops the `CODESURF_MAX_OLD_SPACE_SIZE_MB` override.**

`src/main/index.ts` (lines 37–45) still reads `process.env.CODESURF_MAX_OLD_SPACE_SIZE_MB` as a configurable knob, but at runtime `app.commandLine.appendSwitch('js-flags', …)` runs after main's V8 is already initialized, so main-process heap in dev is effectively governed by this CLI `--js-flags`. Hardcoding `8192` here removes the only dev-time escape hatch for the env var.

Consider keeping shell interpolation (or reading from env via `cross-env`/Node) so the variable still works in dev:

<details>
<summary>♻️ Suggested change</summary>

```diff
-    "dev": "electron-vite dev -- --js-flags=\"--expose-gc --max-old-space-size=8192\"",
+    "dev": "electron-vite dev -- --js-flags=\"--expose-gc --max-old-space-size=${CODESURF_MAX_OLD_SPACE_SIZE_MB:-8192}\"",
```
Note: If cross-shell portability matters (Windows `cmd.exe`), move the resolution into a small Node launcher or a `cross-env`-driven script instead of POSIX shell expansion.
</details>

<!-- suggestion_start -->

<details>
<summary>📝 Committable suggestion</summary>

> ‼️ **IMPORTANT**
> Carefully review the code before committing. Ensure that it accurately replaces the highlighted code, contains no missing lines, and has no issues with indentation. Thoroughly test & benchmark the code to ensure it meets the requirements.

```suggestion
    "dev": "electron-vite dev -- --js-flags=\"--expose-gc --max-old-space-size=${CODESURF_MAX_OLD_SPACE_SIZE_MB:-8192}\"",
```

</details>

<!-- suggestion_end -->

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against the current code and only fix it if needed.

In `@package.json` at line 22, The dev script hardcodes --max-old-space-size=8192
and thus overrides the CODESURF_MAX_OLD_SPACE_SIZE_MB env knob read by
src/main/index.ts and used via app.commandLine.appendSwitch('js-flags', …);
update the "dev" npm script (script name "dev") to preserve an environment
override instead of hardcoding 8192 (e.g. interpolate the
CODESURF_MAX_OLD_SPACE_SIZE_MB env variable into the js-flags string or use
cross-env / a small Node launcher to read
process.env.CODESURF_MAX_OLD_SPACE_SIZE_MB and fall back to 8192) so the
main-process heap size can still be configured at dev time.
```

</details>

<!-- fingerprinting:phantom:medusa:nectarine:95965251-7e51-4cf6-9920-c9ac9bdf5d82 -->

<!-- This is an auto-generated reply by CodeRabbit -->

✅ Confirmed as addressed by @mk7luke

<!-- This is an auto-generated comment by CodeRabbit -->

---

## src/renderer/src/components/TerminalTile.tsx:181 (id=3098187838)

_⚠️ Potential issue_ | _🟡 Minor_

**`launchArgs` in the mount-effect deps can churn the Terminal/PTY on every parent render.**

`launchArgs` is an array prop; if the parent doesn't pass a stable reference (e.g. `useMemo`), this effect will re-run every render. The cleanup path disconnects the ResizeObserver, detaches the PTY, and disposes the xterm instance, then the effect re-creates everything from scratch — wiping xterm scrollback/rendering state even though the tmux/PTY backend survives. `tileId`/`workspaceDir`/`launchBin` are primitives and fine, but `launchArgs` is the odd one out.

Consider stabilizing the dep (e.g., by its serialized form) so cosmetically-equivalent arrays don't trigger remounts:

<details>
<summary>♻️ Suggested change</summary>

```diff
-  }, [tileId, workspaceDir, launchBin, launchArgs])
+  }, [tileId, workspaceDir, launchBin, JSON.stringify(launchArgs ?? [])])
```
Or require callers to memoize `launchArgs` and leave the deps as-is, documenting the expectation.
</details>

<!-- suggestion_start -->

<details>
<summary>📝 Committable suggestion</summary>

> ‼️ **IMPORTANT**
> Carefully review the code before committing. Ensure that it accurately replaces the highlighted code, contains no missing lines, and has no issues with indentation. Thoroughly test & benchmark the code to ensure it meets the requirements.

```suggestion
  useEffect(() => {
    if (!containerRef.current || mountedRef.current) return
    mountedRef.current = true
    const container = containerRef.current
    let cancelled = false
    let ro: ResizeObserver | null = null

    // Register system fonts (e.g. Nerd Fonts) via `@font-face` local() so
    // Chromium's Canvas/WebGL text renderers can resolve them. Without this,
    // system-installed fonts may not be available to canvas contexts, causing
    // Private Use Area glyphs (Nerd Font icons) to render as underscores.
    const fontLoads: Promise<void>[] = []
    for (const raw of resolvedFont.split(',')) {
      const name = raw.trim().replace(/^["']|["']$/g, '')
      if (!name || name === 'monospace' || name === 'sans-serif') continue
      const alreadyDeclared = [...document.fonts].some(f => f.family.replace(/["']/g, '') === name)
      if (!alreadyDeclared) {
        const face = new FontFace(name, `local("${name}")`)
        fontLoads.push(face.load().then(loaded => { document.fonts.add(loaded) }).catch(() => {}))
      }
    }

    Promise.all(fontLoads).then(() => {
      if (cancelled) return

      const term = new Terminal({
        theme: {
          background: theme.terminal.background,
          foreground: theme.terminal.foreground,
          cursor: theme.terminal.cursor,
          cursorAccent: theme.terminal.cursorAccent,
          selectionBackground: theme.terminal.selection,
          black: theme.terminal.black, red: theme.terminal.red, green: theme.terminal.green,
          yellow: theme.terminal.yellow, blue: theme.terminal.blue, magenta: theme.terminal.magenta,
          cyan: theme.terminal.cyan, white: theme.terminal.white,
          brightBlack: theme.terminal.brightBlack, brightRed: theme.terminal.brightRed, brightGreen: theme.terminal.brightGreen,
          brightYellow: theme.terminal.brightYellow, brightBlue: theme.terminal.brightBlue, brightMagenta: theme.terminal.brightMagenta,
          brightCyan: theme.terminal.brightCyan, brightWhite: theme.terminal.brightWhite,
          overviewRulerBorder: theme.terminal.background,
        },
        overviewRuler: {
          width: 10,
        },
        fontFamily: resolvedFont,
        fontSize: fontSizeRef.current,
        lineHeight: 1,
        cursorBlink: true,
        allowProposedApi: true,
        scrollback: 5000,
      })

      const fitAddon = new FitAddon()
      const unicode11 = new Unicode11Addon()
      term.loadAddon(fitAddon)
      term.loadAddon(unicode11)
      term.unicode.activeVersion = '11'
      term.open(container)

      // WebGL renderer handles Nerd Font / PUA glyphs better than the canvas renderer
      try {
        const webgl = new WebglAddon()
        webgl.onContextLoss(() => { webgl.dispose() })
        term.loadAddon(webgl)
      } catch { /* fall back to canvas renderer */ }

      // Apply padding inside xterm element so viewport bg covers behind it
      const xtermEl = container.querySelector('.xterm') as HTMLElement | null
      if (xtermEl) {
        xtermEl.style.paddingLeft = '8px'
        xtermEl.style.paddingTop = '8px'
      }

      termRef.current = term
      fitRef.current = fitAddon

      // ResizeObserver so fit runs whenever the container actually changes size
      ro = new ResizeObserver(() => doFit())
      ro.observe(container)

      // Initial fit after paint
      requestAnimationFrame(() => requestAnimationFrame(() => doFit()))

      // Track PTY readiness so key handler can write safely
      let ptyReady = false

      // Shift+Enter → send escaped newline so shells continue on next line
      // and TUI apps (Claude CLI) treat it as multi-line input.
      term.attachCustomKeyEventHandler((ev: KeyboardEvent) => {
        if (ev.key === 'Enter' && ev.shiftKey && ev.type === 'keydown') {
          if (ptyReady) {
            // Send backslash + carriage return — universal shell line continuation
            window.electron.terminal.write(tileId, '\\\r')
            return false
          }
        }
        return true
      })

      window.electron.terminal.create(tileId, workspaceDir, launchBin, launchArgs).then(({ buffer }) => {
        ptyReady = true
        if (buffer) term.write(buffer)
        const cleanup = window.electron.terminal.onData(tileId, (data: string) => {
          term.write(data)
        })
        cleanupRef.current = cleanup

        term.onData((data: string) => {
          window.electron.terminal.write(tileId, data)
        })

        // Fit once more after pty is ready
        doFit()
      }).catch(err => {
        term.write(`\r\n\x1b[31mFailed to start terminal: ${err?.message ?? err}\x1b[0m\r\n`)
      })
    })

    return () => {
      cancelled = true
      mountedRef.current = false
      ro?.disconnect()
      cleanupRef.current?.()
      // Detach (not destroy) so tmux sessions survive unmount/reload
      window.electron?.terminal?.detach?.(tileId)
      termRef.current?.dispose()
    }
  }, [tileId, workspaceDir, launchBin, JSON.stringify(launchArgs ?? [])])
```

</details>

<!-- suggestion_end -->

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against the current code and only fix it if needed.

In `@src/renderer/src/components/TerminalTile.tsx` around lines 55 - 181, The
effect is re-running whenever the array prop launchArgs has a new reference;
stabilize it by replacing the raw array in the effect deps with a stable
serialized key (e.g., compute const launchArgsKey = useMemo(() =>
JSON.stringify(launchArgs || []), [launchArgs]) and use launchArgsKey in the
useEffect dependency array instead of launchArgs) so equivalent arrays don't
trigger teardown/recreation of Terminal/PTY; keep passing the original
launchArgs when calling window.electron.terminal.create(tileId, workspaceDir,
launchBin, launchArgs). Alternatively, document/require callers to memoize
launchArgs and leave deps unchanged.
```

</details>

<!-- fingerprinting:phantom:medusa:nectarine:95965251-7e51-4cf6-9920-c9ac9bdf5d82 -->

<!-- This is an auto-generated reply by CodeRabbit -->

---

## src/renderer/src/components/TerminalTile.tsx:181 (id=3098291141)

`@mk7luke`, thanks for the clarification! That makes sense — since `launchArgs` is a direct property reference from a stable tile state object (not an inline array literal or derived value), the reference identity is preserved across renders and the effect won't churn. No fix needed.

---

<details>
<summary>✏️ Learnings added</summary>

```
Learnt from: mk7luke
Repo: jasonkneen/codesurf PR: 5
File: src/renderer/src/components/TerminalTile.tsx:55-181
Timestamp: 2026-04-17T06:26:42.359Z
Learning: In `src/renderer/src/components/TerminalTile.tsx`, the `launchArgs` prop passed to `TerminalTile` comes from `tile.launchArgs` on a persistent tile state object. Its reference is stable across renders and only changes if the tile itself is recreated, so using it directly in the mount-effect dependency array (`[tileId, workspaceDir, launchBin, launchArgs]`) does not cause unwanted Terminal/PTY teardown-and-recreation cycles.
```

> Note: Learnings are effective only in the context of similar code segments. To apply general coding guidelines, please configure [review instructions](https://docs.coderabbit.ai/guides/review-instructions). You can manage existing learnings in the [app](https://app.coderabbit.ai/learnings).

</details>



<!-- This is an auto-generated reply by CodeRabbit -->

---

## package.json:22 (id=3098294632)

<details>
<summary>🧩 Analysis chain</summary>

Let me verify the implementation in `scripts/dev.js`.

---

🏁 Script executed:
```
#!/bin/bash
cat scripts/dev.js
```

Length of output: 600

---



</details>

`@mk7luke`, confirmed — `scripts/dev.js` correctly reads `process.env.CODESURF_MAX_OLD_SPACE_SIZE_MB` with a `|| '8192'` fallback and forwards it as `--max-old-space-size` to `electron-vite dev`. That's the right cross-platform approach; the POSIX `${VAR:-default}` syntax is indeed a no-go on Windows `cmd.exe`/PowerShell. The env-var override is fully restored. Thanks for the explanation!

<!-- <review_comment_addressed> -->

---

<!-- This is an auto-generated comment: tweet message by coderabbit.ai -->

If you found this review helpful, would you consider giving us a shout-out on [X](https://twitter.com/intent/tweet?related=CodeRabbitAI&text=Preserved%20CODESURF_MAX_OLD_SPACE_SIZE_MB%20in%20dev%3A%20replaced%20hardcoded%20--max-old-space-size%3D8192%20with%20cross-platform%20dev.js%20that%20reads%20env%20(fallback%208192)%2C%20restoring%20dev-time%20heap%20control.%20Try%20%40coderabbitai%20%F0%9F%9A%80&url=https%3A%2F%2Fgithub.com%2Fjasonkneen%2Fcodesurf%2Fpull%2F5%23discussion_r3098187823)?

Thank you for using CodeRabbit!

<!-- end of auto-generated comment: tweet message by coderabbit.ai -->



<!-- This is an auto-generated reply by CodeRabbit -->

---

## scripts/dev.js:18 (id=3101562521)

_⚠️ Potential issue_ | _🟡 Minor_

**Validate env input and exit cleanly instead of throwing on child failure.**

Two concerns with the `execSync` invocation:

1. `CODESURF_MAX_OLD_SPACE_SIZE_MB` is interpolated directly into a shell command string inside double quotes. If a developer ever sets it to something unexpected (e.g. `8192" --other-flag "`), the quoting breaks and arbitrary flags/commands can be injected into the shell. Since this is a numeric knob, validate it before use.
2. `execSync` throws on any non-zero child exit (including the normal Ctrl‑C path when stopping `electron-vite dev`), which surfaces a noisy Node stack trace to the developer instead of a clean exit. Prefer `spawnSync` and forward the child's exit code.

<details>
<summary>♻️ Suggested refactor</summary>

```diff
-const { execSync } = require('child_process')
-
-const maxOldSpace = process.env.CODESURF_MAX_OLD_SPACE_SIZE_MB || '8192'
-const jsFlags = `--expose-gc --max-old-space-size=${maxOldSpace}`
-
-execSync(`electron-vite dev -- --js-flags="${jsFlags}"`, {
-  stdio: 'inherit',
-  env: process.env,
-})
+const { spawnSync } = require('child_process')
+
+const raw = process.env.CODESURF_MAX_OLD_SPACE_SIZE_MB
+const maxOldSpace = raw && /^\d+$/.test(raw) ? raw : '8192'
+if (raw && raw !== maxOldSpace) {
+  console.warn(
+    `[dev] Ignoring non-numeric CODESURF_MAX_OLD_SPACE_SIZE_MB=${JSON.stringify(raw)}; using 8192.`,
+  )
+}
+const jsFlags = `--expose-gc --max-old-space-size=${maxOldSpace}`
+
+const result = spawnSync(
+  'electron-vite',
+  ['dev', '--', `--js-flags=${jsFlags}`],
+  { stdio: 'inherit', env: process.env, shell: true },
+)
+if (result.error) {
+  console.error(result.error)
+  process.exit(1)
+}
+process.exit(result.status ?? 0)
```

</details>

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against the current code and only fix it if needed.

In `@scripts/dev.js` around lines 12 - 18, Validate and sanitize the
CODESURF_MAX_OLD_SPACE_SIZE_MB env before building jsFlags and avoid passing a
shell-interpolated command to execSync:
parseInt(process.env.CODESURF_MAX_OLD_SPACE_SIZE_MB, 10) (falling back to 8192)
and ensure it's a finite positive integer within a sensible range; if invalid,
log a clear error and exit non-zero. Replace the execSync call with
spawnSync('electron-vite', ['dev', '--', `--js-flags=--expose-gc
--max-old-space-size=${validatedValue}`], { stdio: 'inherit', env: process.env
}) and then inspect spawnResult.status (or spawnResult.signal) and call
process.exit(status || 0) so child failures (including Ctrl-C) produce a clean
exit instead of throwing; reference maxOldSpace, jsFlags, execSync and switch to
spawnSync.
```

</details>

<!-- fingerprinting:phantom:medusa:nectarine:8ce5b6b5-93bb-4178-a270-b61137754557 -->

<!-- This is an auto-generated comment by CodeRabbit -->

---

## package.json:36 (id=3105631966)

_⚠️ Potential issue_ | _🟡 Minor_

**Run the Windows `node-pty` patch from `rebuild` too.**

`postinstall` patches before rebuilding, but `npm run rebuild` skips the patch and can still fail on Windows when rebuilding `node-pty` manually.



<details>
<summary>🔧 Proposed script cleanup</summary>

```diff
-    "rebuild": "electron-rebuild -f -o better-sqlite3 && electron-rebuild -f -o node-pty",
-    "postinstall": "node scripts/patch-node-pty-win.js && electron-rebuild -f -o better-sqlite3 && electron-rebuild -f -o node-pty"
+    "rebuild": "node scripts/patch-node-pty-win.js && electron-rebuild -f -o better-sqlite3 && electron-rebuild -f -o node-pty",
+    "postinstall": "npm run rebuild"
```

</details>

<!-- suggestion_start -->

<details>
<summary>📝 Committable suggestion</summary>

> ‼️ **IMPORTANT**
> Carefully review the code before committing. Ensure that it accurately replaces the highlighted code, contains no missing lines, and has no issues with indentation. Thoroughly test & benchmark the code to ensure it meets the requirements.

```suggestion
    "rebuild": "node scripts/patch-node-pty-win.js && electron-rebuild -f -o better-sqlite3 && electron-rebuild -f -o node-pty",
    "postinstall": "npm run rebuild"
```

</details>

<!-- suggestion_end -->

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against the current code and only fix it if needed.

In `@package.json` around lines 35 - 36, The rebuild npm script needs to run the
Windows node-pty patch like postinstall does; update the "rebuild" script in
package.json so it invokes the patch script (scripts/patch-node-pty-win.js)
before calling electron-rebuild for better-sqlite3 and node-pty, mirroring the
ordering used in "postinstall" to avoid Windows rebuild failures when running
npm run rebuild directly.
```

</details>

<!-- fingerprinting:phantom:medusa:ibis -->

<!-- This is an auto-generated comment by CodeRabbit -->

✅ Addressed in commit 305c243

---

