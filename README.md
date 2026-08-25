# Claude Manager

An Electron desktop app for browsing and cleaning up Claude Code's local data:
session transcripts, project memories, scratchpads, and the ancillary storage
that accumulates under `~/.claude`.

Nothing it deletes is unlinked — everything moves to a restorable trash, and a
session attached to a running Claude Code process can never be touched.

## Install (Windows)

Grab the latest build from the [Releases page](https://github.com/jstephenperry/claude-manager/releases):

| File | Use |
| --- | --- |
| `Claude Manager-*-Setup.exe` | Installer, with shortcuts and an uninstaller |
| `Claude Manager-*-portable.exe` | Single executable, nothing installed |
| `Claude Manager-*-x64.zip` | Unpacked build |

**These builds are not code-signed.** A code-signing certificate costs real
money per year and this is a free tool, so Windows SmartScreen will show
*"Windows protected your PC"* the first time you run it. Choose **More info** →
**Run anyway**. If you would rather not trust a binary from a stranger, build it
yourself — it takes one command, below.

macOS and Linux are not built yet. The code has no Windows-specific logic
beyond path handling, so both should work; they are simply untested.

## Run from source

```
npm install
npm start          # npm run dev opens DevTools
```

Requires Node 20+.

## What it does

**Sessions** — every project under `~/.claude/projects`, with its transcripts
listed by AI-generated title, message and tool counts, token usage, model, git
branch, duration, and true on-disk footprint. Click any session to read the
whole conversation.

**Memories** — the `memory/*.md` files per project, with their frontmatter,
`[[wikilinks]]`, and origin sessions. Editable in place. The view leads with a
health report, because memory directories drift in ways a file browser cannot
show you:

| Issue | Meaning |
| --- | --- |
| `dangling-index` | `MEMORY.md` links to a file that is not there |
| `unindexed` | A memory exists that no index line points at, so it never loads |
| `broken-link` | A `[[link]]` names a memory that does not exist |
| `stale-origin` | `originSessionId` points at a transcript that is gone |
| `duplicate-name` | Two files declare the same `name:` |
| `no-frontmatter` / `missing-name` / `empty` | Malformed or content-free |

Orphaned index links are the one kind of drift with a mechanical fix, so they
are not only reported — **Repair MEMORY.md** works out what each broken link
should say and shows the edit line by line before writing anything:

- A file that is plainly still there is **repointed** — a stray `memory/`
  prefix, a missing `.md`, the wrong case, an escaped space, or a renamed file
  that still declares the `name:` the index knows it by. Anchors and link
  titles survive the rewrite.
- A link into this app's own trash is **dropped**, because the file it named
  went through a delete here and restoring it from the Trash tab brings the
  line back.
- A guess — a name a couple of characters off, or a candidate that already has
  its own index line — is offered but never pre-selected.
- A link mid-sentence, or one of several on a line, is left alone and reported
  as needing a manual edit, since deleting the line would take somebody's prose
  with it.

Edits are minimal: a repoint rewrites the characters inside the parentheses and
nothing else, a removal drops one list item or table row, and line endings are
preserved. Nothing is written until you apply, and **Undo** restores the file
byte for byte. Links that already resolve — `./notes.md`, `../CLAUDE.md`,
`notes%20.md` — are not touched, and are no longer reported as broken either.

Deleting a memory orphans its index line, so a delete offers to take the line
with it: the confirmation dialog lists every line it would drop, and the edit
happens only for the files that actually reached the trash. Turn it off with
*Fix index on delete* in the Memories tab.

**Scratchpads** — the working directories Claude Code gives each session under
the OS temp folder (`<tmp>/claude/<project>/<session-id>/{scratchpad,tasks}`),
which nothing ever prunes. Browse the files in place with a lazy directory tree
and a text preview; entries whose session transcript is gone are flagged as
orphans, and the empty husks (a directory per session that never wrote a file —
usually the large majority) collapse behind one line.

**Cleanup** — `file-history/`, `session-env/`, `shell-snapshots/`, `backups/`,
`cache/`, and stale process-registry files. Entries whose session no longer
exists are flagged as orphans and are the only things preselected; groups with
nothing to reclaim start collapsed.

**Sweep** — age-based cleanup: everything untouched for longer than N days
(default 60, with 30/60/90/180 presets). It always builds a plan first and
shows every candidate with its age and size, individually deselectable, before
anything moves. *Preview on launch* builds the plan at startup; it still asks
before deleting.

Two categories are off by default, deliberately:

- **Memories** — a memory's worth has no relationship to its age. A six-month-old
  note about a build quirk is often the most valuable thing in the tree.
- **Items already in the trash** — sweeping these *erases them permanently*,
  since there is nowhere further to move them.

**Trash** — everything this app deletes, with the original location of every
path, restorable exactly where it came from.

## Deletion model

Nothing is ever unlinked directly. A delete moves every path belonging to an
item into `~/.claude/.manager-trash/<entry-id>/` and records its origin in a
manifest, so restore is an exact reversal. Permanent removal is a separate,
explicit purge.

The app may modify exactly two trees — `~/.claude` and the scratchpad root —
declared as `MANAGED_ROOTS` in `paths.js`. Adding a third is a deliberate,
visible edit rather than something a path bug can cause.

Three safeguards:

- **Live sessions are hard-blocked.** `~/.claude/sessions/*.json` is a registry
  of running Claude Code processes; the app checks the pid is alive and refuses
  to delete that session or its project. Deleting a transcript out from under a
  running session corrupts it.
- **Every path is checked against the managed roots** before it is touched. A
  bug in path resolution fails loudly instead of deleting something elsewhere.
  The sweep re-checks liveness at execution time too, because a plan is a
  snapshot and a session may have started since it was built.
- **A session is not one file.** Deleting one takes its transcript, its
  `tool-results/` and `subagents/` sidecar directory, and its `file-history/`
  and `session-env/` entries — all listed in the confirmation dialog.

## Finding things on disk

Every session, memory, project, and cleanup item has **Open** (containing
folder in Explorer), **Reveal** (the item selected inside its folder), and
**Copy** (absolute path to the clipboard). The transcript drawer has a
*Locations on disk* panel listing all of a session's paths at once — transcript,
sidecar, file history, session env, project data directory, and the working
directory the session ran in. Clicking the root path in the title bar opens
`~/.claude`.

## How Claude Code stores this data

Notes gathered while building this, since none of it is documented:

- **Project directories** encode the working directory by replacing `:` and
  path separators with `-`, so `D:\Development\source\claude-manager` becomes
  `D--Development-source-claude-manager`. That mapping is lossy — a real hyphen
  is indistinguishable from a separator. The app prefers the authentic `cwd`
  recorded inside transcripts, and falls back to probing candidate splits
  against the filesystem.
- **Transcripts** are `<session-uuid>.jsonl`, one JSON object per line. Useful
  record types: `user`, `assistant`, `ai-title` (the session's display title),
  `last-prompt`, `attachment`, and `queue-operation`. Assistant records carry
  `message.usage` with token counts and `message.model`.
- **Sidecars** live in `<session-uuid>/` next to the transcript: `tool-results/`
  for offloaded large outputs and `subagents/agent-*.jsonl` (plus
  `.meta.json`) for spawned agents.
- **`sessions/<pid>.json`** is the live-process registry — `sessionId`, `pid`,
  `cwd`, `status`, `updatedAt`. This is how liveness is determined.
- **Thinking blocks are not readable.** Records contain
  `{type:"thinking", thinking:"", signature:"…"}` — the signature is persisted
  but the reasoning text is not. The transcript view reports the count and says
  so rather than offering a toggle that reveals nothing.

### This data can disappear from outside the app

`~/.claude/.last-cleanup` suggests Claude Code runs some retention sweep of its
own, and `cleanupPeriodDays` in `~/.claude.json` appears to be the knob for it —
neither behaviour was verified while building this, so treat both as leads
rather than documented fact.

What matters for the app either way: project directories can vanish between
scans, deleted by Claude Code or by hand. Nothing that happens outside this app
goes through its trash, so the Trash tab is not a safety net for those. Back up
anything under `~/.claude/projects/*/memory/` you would not want to lose.

## Layout

```
src/main/        Electron main process — all filesystem access
  paths.js       ~/.claude layout, project-name encoding, the delete guard
  scanner.js     builds the project/session index (cached by size+mtime)
  memories.js    frontmatter parsing and memory health diagnosis
  repair.js      MEMORY.md orphaned-link repair (plans; applies only what it is given)
  transcript.js  .jsonl -> renderable entries, with block clipping
  cruft.js       ancillary storage and orphan detection
  scratchpads.js the temp-folder scratchpad tree, browsing and previews
  sweep.js       age-based cleanup planning (plans only; never deletes)
  settings.js    preferences, stored in userData not ~/.claude
  trash.js       soft delete, restore, purge
  ipc.js         the renderer's entire capability surface
src/preload/     contextBridge — the renderer gets these functions and no Node
src/renderer/    plain ES modules, no bundler
scripts/         smoke tests (see below)
```

The renderer has no Node access and builds all DOM through `el()`, which takes
children as text nodes — session titles, memory text, and tool output are
arbitrary content read off disk and are never parsed as HTML.

## Building

```
npm install
npm run icon       # regenerates build/icon.ico from scripts/make-icon.mjs
npm run dist       # installer, portable exe and zip into dist/
npm run pack       # unpacked build only, for a quick check
```

The icon is generated rather than committed as a binary: `scripts/make-icon.mjs`
writes the PNG and ICO bytes directly, with no image library.

### Cutting a release

Pushing a `v*` tag runs `.github/workflows/release.yml`, which builds on a
Windows runner and attaches the artifacts to a GitHub Release:

```
npm version patch      # or minor / major — commits and tags
git push --follow-tags
```

## Tests

```
node scripts/t-trash.mjs    # delete/restore/purge/conflict/guard, in a temp sandbox
node scripts/t-mem.mjs      # frontmatter, index, and issue detection on real data
node scripts/t-memfix.mjs   # orphaned-link diagnosis and MEMORY.md repair, in a temp sandbox
node scripts/t-scan.mjs     # full scan summary
node scripts/t-read.mjs     # transcript parsing + cruft scan
node scripts/t-sweep.mjs    # scratchpad scan, managed-root guard, sweep plans
node scripts/t-e2e.mjs      # end-to-end through the running app (see below)
```

`t-e2e.mjs` and `shoot.mjs` drive the running app over the DevTools protocol;
start it with `npx electron . --remote-debugging-port=9222` first. `t-e2e.mjs`
plants a synthetic orphan in the real `~/.claude`, deletes and restores it
through the app's own IPC, then removes it — real data is never involved.
