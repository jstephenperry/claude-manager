# Changelog

## 0.1.2

A security release. In 0.1.1, anything that can write inside `~/.claude`, such as a Claude Code session following injected instructions, could plant links or trash entries that turned an ordinary action in the app into deleting or overwriting files outside it. The full audit, with each finding's scenario and fix, is in [docs/security-audit.md](docs/security-audit.md).

### Security

- Critical: "Empty trash" no longer follows a `.manager-trash` folder that is a junction or symlink. Before, a linked trash folder made it erase whatever the link pointed at, such as the home folder.
- High: Restore refuses an entry whose destination passes through a linked folder, so a planted trash entry cannot write a file outside `~/.claude`.
- The trash manifest is treated as untrusted input. A crafted entry id or path could make "Delete forever", "Empty trash" or Restore remove transcripts and memories, or move `.credentials.json`, before this release.
- Medium: Cleanup, Sweep and the Scratchpads tab refuse to move anything through a linked folder inside `~/.claude` or the scratchpad root, and the scratchpad root must not itself be a link or, on Linux and macOS, belong to another user.
- Medium: deletes and sweeps check which sessions are running when they execute, not when the window last scanned, so a session resumed after the last scan is not deleted while it runs.
- Low: the memory editor writes only memory files that are not links, and MEMORY.md repair refuses a linked index or memory folder.
- Low: the window refuses navigation and new windows, and the renderer runs with Chromium's sandbox enabled.
- Low: Electron 33.4.11, which is out of support, is replaced by 45.1.0, and electron-builder 25.1.8 by 26.18.0. `npm audit` reports no vulnerabilities.
- Low: the release workflow's actions are pinned to commit SHAs, and it runs every sandboxed test suite before it builds.

### Fixed

- Scratchpads are looked for where Claude Code puts them on every platform: `claude` in `CLAUDE_CODE_TMPDIR` or the temp folder on Windows, `claude-<uid>` in `CLAUDE_CODE_TMPDIR` or the temp directory on Linux, and `claude-<uid>` in `CLAUDE_CODE_TMPDIR` or `/tmp` on macOS.
- MEMORY.md links are read as CommonMark link destinations, so a file name with parentheses, bare or wrapped in angle brackets, is no longer reported as broken, and the repair no longer rewrites such a link into one it then reports.

### Changed

- After a delete, restore or edit, the app refreshes only what the change touched instead of rescanning everything. Measured on a 25-project tree, deleting a memory went from 4297 ms to 102 ms and deleting a session from about 1700 ms to 313 ms.

## 0.1.1

- Repair MEMORY.md when its index links are orphaned, from a panel reachable on memory directories of real size.
- Publish SHA-256 checksums with release artifacts.

## 0.1.0

- First release.
