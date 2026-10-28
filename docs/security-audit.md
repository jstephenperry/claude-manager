# Security audit, October 2026

Audited commit: `5062a92` (main). Fixes for the findings marked Fixed are on branch `claude/project-thread-vvmv0r`. Line numbers below refer to `5062a92`.

## Threat model

The app runs with the user's full privileges and acts on two trees it does not own the contents of: `~/.claude`, which every Claude Code session writes to, and the scratchpad root under the OS temp directory, which a session uses as its working space. Commit `619457f` already adopted the model this audit uses: anything that can write inside those trees, such as a prompt-injected session or a session whose own writes are sandboxed to its scratchpad, must not be able to turn the app into a deputy that reads, writes or deletes outside them. On Linux the temp directory is shared by every account on the machine, which widens "anything that can write" to other local users.

The renderer is treated as trusted only as far as it runs the app's own code. Everything read off disk reaches the DOM as text nodes (`src/renderer/dom.js:8-30`), the only `innerHTML` sink is the `html` prop and nothing passes it, and the CSP allows scripts from the app's own files only (`src/renderer/index.html:5`). No HTML injection path was found.

## Lens coverage

| Lens | Status before this audit | Result |
| --- | --- | --- |
| Trash manifest as untrusted input | Covered by `619457f` | String checks were sound; bypassed through links (findings 1 and 2) |
| Memory and MEMORY.md link parsing | Covered by `5d4f1d1` | No new issue; no catastrophic-backtracking regex in `memories.js` or `repair.js` |
| Path containment through links and junctions | Not covered | Findings 1 to 5 |
| Liveness at delete time | Not covered | Finding 6 |
| Renderer, navigation and IPC surface | Not covered | Finding 7; no HTML injection |
| Shell integration (`openPath`, `showItemInFolder`) | Not covered | No issue reachable without a compromised renderer |
| Dependencies | Not covered | Finding 8 |
| Release pipeline | Not covered | Finding 9 |

## Findings

### 1. Critical, fixed: "Empty trash" recursively deletes the target of a linked trash directory

`removeInsideTrash` (`src/main/trash.js:72-75`) checks only that a path string is inside `~/.claude/.manager-trash`, and `purgeAll` (`src/main/trash.js:205-208`) removes every name `readdir` returns for that directory. If `.manager-trash` is replaced by a junction or symlink to the home directory, `readdir` lists the home directory, every name passes the string check, and each is removed with `fs.rm(..., { recursive: true })`.

Scenario: a session runs `mklink /J %USERPROFILE%\.claude\.manager-trash %USERPROFILE%`. The Trash tab shows nothing, so the user notices nothing. The next delete of anything in the app writes its manifest and entry into the home directory through the link, the Trash tab now offers "Empty trash", and pressing it erases every file and folder in the home directory except `manifest.json`. Creating a junction needs no privilege on Windows. Reproduced in a sandbox against `5062a92`.

Fix: every trash operation refuses a trash directory that is not a plain directory, and the manifest is not read through one.

### 2. High, fixed: restore writes attacker-chosen bytes anywhere through a linked directory

`entryIsSound` (`src/main/trash.js:36-50`) checks that `from` is inside a managed root as a string. A directory inside `~/.claude` can be a link to anywhere, so an entry whose `from` is `~/.claude/projects/p/authorized_keys`, with `projects/p` linked to `~/.ssh`, passes, and `restoreEntry` (`src/main/trash.js:165`) moves the planted file there. This is the "move any file to any path" case `619457f` set out to close, reached by a different route.

Scenario: a session plants a trash entry labelled like an ordinary memory, with its file holding an SSH key or a shell profile line, and the link. Pressing Restore on it writes the file outside `~/.claude`. Reproduced in a sandbox against `5062a92`.

Fix: before anything moves, every `to` must resolve inside the trash and every `from` must resolve inside a managed root, with links followed.

### 3. Medium, fixed: Cleanup and Sweep move files out of a linked ancillary directory

`scanCruft` (`src/main/cruft.js:286-292`) lists the children of `cache/`, `backups/`, `debug/` and the rest by following the directory, and `trashItem` checks the resulting paths as strings. With `~/.claude/cache` linked to Documents, the Cleanup tab lists each folder in Documents as a cache entry, and the default age sweep includes anything older than 60 days. Deleting moves the real files into the trash, where emptying the trash or a later sweep with the trash category erases them. Reproduced in a sandbox against `5062a92`.

Fix: a move is refused when any directory on the way to the item resolves outside the root. A link that is itself the item still moves, because moving a link moves the link.

### 4. Medium, fixed: the scratchpad tree has the same hole, and on Linux it is shared

`scanScratchpads` (`src/main/scratchpads.js:167-169, 219-240`) follows a project directory under the scratchpad root and offers every non-session subdirectory as an orphaned, unattached sweep candidate. A link at `<scratch>/proj` to the home directory makes the home directory's old folders default sweep candidates. Reproduced in a sandbox against `5062a92`.

On Linux the root is `/tmp/claude` (`src/main/paths.js:64-66`), in a directory every account can write to, so another local user can create it first and populate it with links. A separate functional issue makes this worse: Claude Code on Linux uses `/tmp/claude-<uid>`, not `/tmp/claude` (this audit's own session ran in `/tmp/claude-0`), so on Linux the app is looking at a directory Claude Code does not use. Linux builds are not published, which is why this is rated Medium rather than High.

Fix: the same link check applies to the scratchpad root, which additionally must not itself be a link and, on Linux and macOS, must belong to the current user. The root now matches how Claude Code builds it: `<base>/<name>`, where `<base>` is `CLAUDE_CODE_TMPDIR` when set, otherwise `/tmp` on macOS and the OS temp directory on Linux and Windows, and `<name>` is `claude` on Windows and `claude-<uid>` on Linux and macOS. Claude Code also refuses a `claude-<uid>` owned by another uid. With the default root, the app's scan on Linux now finds the sessions under `/tmp/claude-0` that it missed before.

Sources checked: the cross-platform `cli.js` of Claude Code 2.1.100 (`if (platform === "windows") return "claude"; return "claude-" + uid`, and a base of `CLAUDE_CODE_TMPDIR`, else `/tmp` on darwin, else `os.tmpdir()`), and the 2.1.312 native binaries for Windows x64 (name is the constant `claude`, base is `CLAUDE_CODE_TMPDIR` or `os.tmpdir()`), macOS arm64 (`claude-<uid>`, base `CLAUDE_CODE_TMPDIR` or `/tmp`) and Linux x64 (`claude-<uid>`, base `CLAUDE_CODE_TMPDIR` or `os.tmpdir()`). The Linux binary has no Windows branch because each native build carries only its own platform's constant; reading it alone suggested Windows would use `claude-0`, which none of these builds does. Two corrections followed: Windows now honours `CLAUDE_CODE_TMPDIR`, and macOS looks in `/tmp` rather than the per-user `$TMPDIR` that `os.tmpdir()` returns there. Versions before 2.1.100 were not checked file by file; 2.0.50 and 1.0.128 have no session scratchpads and no `CLAUDE_CODE_TMPDIR`. None of this was run on a Windows or macOS machine.

### 5. Low, fixed: the memory editor writes through a linked memory file, and writes any path in `~/.claude`

`writeMemory` (`src/main/memories.js:478-479`) is a plain `fs.writeFile`, which follows a link, and the `memory:writeFile` handler accepts any path inside `~/.claude`. A `notes.md` linked to a shell profile is shown with the profile's contents and saved back into it. Separately, a compromised renderer could write `~/.claude/settings.json`, whose hooks Claude Code executes. Rated Low because the editor shows the target's real contents before a save.

Fix: the editor writes only `projects/<project>/memory/*.md` files that are not links, and MEMORY.md repair refuses a linked index or memory directory.

### 6. Medium, fixed: a session resumed after the last scan can be deleted while running

The README states that live sessions are hard-blocked and that the sweep re-checks liveness at execution time. `assertNotLive` (`src/main/ipc.js:21-29`) reads `session.live` from the cached index, and `ensureIndex` (`src/main/indexer.js:180-182`) returns that cache as long as one exists, so liveness is as old as the last full scan or project rescan. Since `b29bed7`, after startup only Refresh or Ctrl-R triggers a full scan (`src/renderer/app.js:177-188`). A session resumed with `claude --resume` after the window opened is deleted or swept while its process is writing it. `delete:paths` and cruft sweep items had no liveness check at all, so a running session's `file-history/` and `session-env/` entries could also be moved.

Fix: deletes, project deletes and sweeps read the live-session registry when they execute, and refuse any item whose paths name a live session id.

### 7. Low, fixed: the bridge is reachable from any page the window navigates to

The window sets no `will-navigate` or window-open handler (`src/main/main.js:15-34`), and the preload bridge belongs to the webContents rather than to `index.html`. By Electron's default, a file dropped onto the window navigates to it; an HTML file dropped there would run with `window.api`, including `trash:purgeAll` and `shell:openPath` with an arbitrary path. Verified in Electron 45.1.0 under Xvfb: with the guard removed, setting `location.href` to `file:///etc/hostname` navigated the window there, and that page had all 31 bridge functions. With the guard, the window stayed on `index.html`.

Fixed: navigation and new windows are refused, and the renderer now runs with `sandbox: true` (`src/main/main.js:28`). The preload needed no change, since it uses only `contextBridge` and `ipcRenderer`, which a sandboxed preload keeps. Verified in Electron 45.1.0 under Xvfb as a non-root user with the setuid sandbox helper and no `--no-sandbox`: the renderer started with `--enable-sandbox`, seccomp filtering (`Seccomp: 2`) and its own pid namespace; every tab rendered, the bridge exposed its 31 functions and no `require`, `process` or `Buffer`, copy resolved, and `t-e2e.mjs` passed. The same build with `sandbox: false` started its renderer with `--no-sandbox`, no seccomp filter and the browser's pid namespace. Not changed: IPC handlers do not check `event.senderFrame`, which matters only if the renderer runs code other than the app's own.

### 8. Low, fixed: Electron 33 is out of support

The lockfile resolves `electron` 33.4.11; the current release is 45.1.0. `npm audit` reports 46 advisories against 33.4.11, the most serious being a context-isolation bypass and use-after-free bugs. The app loads only its own local files and blocks navigation, so the advisories that need hostile web content are not reachable from what was found here. `electron-builder` 25.1.8 pulls in `tar` (critical) and `extract-zip` (high) versions with path-traversal advisories; these run only at build time on archives the build downloads itself. Fixed: `electron` is now 45.1.0 and `electron-builder` 26.18.0, and `npm audit` reports no vulnerabilities. The one API change the app hit is that `clipboard.writeText` returns a Promise since Electron 44, so the copy handler now awaits it.

### 9. Low, partly fixed: the release job trusts a tag-pinned third-party action with write access

`release.yml` grants `contents: write` and ran `softprops/action-gh-release@v2`, pinned by tag. Whoever controls that tag controls what is published.

Fixed: every action in `ci.yml` and `release.yml` is pinned to the full commit SHA its major tag pointed to, read from each action's own repository, with the version as a trailing comment, and `.github/dependabot.yml` keeps the pins current. Not changed: the release job runs only `t-trash.mjs`, while CI runs every sandboxed suite.

## What remains

The link checks resolve paths and then act on them. A link swapped in between the check and the move is not caught; Node has no `openat`-style API to close that race. The checks stop a link planted in advance, which is the scenario in every finding above.

Read-only handlers (`scratch:readFile`, `memory:readFile`, `transcript:read`) still follow links. That shows the user a file they can already read and sends it nowhere, so it was left as is.

## Verification

`scripts/t-guard.mjs` plants each link above inside a sandbox and drives the real IPC handlers with `electron` stubbed out. Against `5062a92` it fails 22 of its checks; with the fixes it passes all of them, including negative controls showing that ordinary deletes, a link that stays inside the root, a link as the deleted item, and a delete after the session's process exits all still work. The existing suites (`t-trash`, `t-memfix`, `t-bench`, `t-sweep`, `t-mem`, `t-scan`, `t-read`) pass unchanged on Linux with Node 22. CI runs the new suite on `windows-latest`. After the Electron upgrade the app was also run in Electron 45.1.0 on Linux under Xvfb with a sandboxed home directory: every tab rendered, a prompt containing markup rendered as text, copying a path resolved, navigation and `window.open` were refused, no console errors appeared, and `scripts/t-e2e.mjs` passed against the running app. Nothing was run inside Electron on Windows.
