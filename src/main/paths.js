// Filesystem layout of ~/.claude, and the project-directory name encoding.
//
// Claude Code encodes a project's cwd into a flat directory name by replacing
// every path separator and colon with a hyphen ("D:\Development\source\x" ->
// "D--Development-source-x"). That mapping is lossy -- a real hyphen in a
// folder name is indistinguishable from a separator -- so we never rely on
// reversing it when we can avoid it. Session transcripts record the authentic
// `cwd`, and the scanner prefers that; `decodeProjectDir` is the fallback for
// projects that only hold memories and have no transcript to read.

import os from 'node:os';
import path from 'node:path';

export const HOME = os.homedir();
export const CLAUDE_ROOT = process.env.CLAUDE_CONFIG_DIR
  ? path.resolve(process.env.CLAUDE_CONFIG_DIR)
  : path.join(HOME, '.claude');

export const PROJECTS_DIR = path.join(CLAUDE_ROOT, 'projects');
export const TRASH_DIR = path.join(CLAUDE_ROOT, '.manager-trash');

/** Ancillary directories keyed by session id -- they orphan when a session dies. */
export const SESSION_KEYED_DIRS = [
  { key: 'file-history', dir: path.join(CLAUDE_ROOT, 'file-history'), label: 'File history' },
  { key: 'session-env', dir: path.join(CLAUDE_ROOT, 'session-env'), label: 'Session env' },
];

/** Directories that accumulate loose, non-session-keyed junk. */
export const LOOSE_DIRS = [
  { key: 'shell-snapshots', dir: path.join(CLAUDE_ROOT, 'shell-snapshots'), label: 'Shell snapshots' },
  { key: 'backups', dir: path.join(CLAUDE_ROOT, 'backups'), label: 'Backups' },
  { key: 'cache', dir: path.join(CLAUDE_ROOT, 'cache'), label: 'Cache' },
  { key: 'debug', dir: path.join(CLAUDE_ROOT, 'debug'), label: 'Debug logs' },
  { key: 'downloads', dir: path.join(CLAUDE_ROOT, 'downloads'), label: 'Downloads' },
];

/** The live-session registry: one JSON file per running Claude Code process. */
export const SESSIONS_REGISTRY_DIR = path.join(CLAUDE_ROOT, 'sessions');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isSessionId = (s) => UUID_RE.test(s);

const BACKSLASH = String.fromCharCode(92);

/**
 * Best-effort reverse of the cwd -> directory-name encoding. Used only when no
 * transcript exists to supply the real cwd; the result is marked `inferred` by
 * callers so the UI can say so rather than assert a path that may be wrong.
 */
export function decodeProjectDir(name) {
  // A leading "X--" is a drive letter: "D--Development-source-x" -> "D:\..."
  const drive = name.match(/^([A-Za-z])--(.*)$/);
  if (drive) {
    return drive[1].toUpperCase() + ':' + BACKSLASH + drive[2].split('-').join(BACKSLASH);
  }
  if (name.startsWith('-')) return '/' + name.slice(1).split('-').join('/');
  return name.split('-').join(path.sep);
}

/**
 * Session scratchpads and background-task output live outside ~/.claude, under
 * the OS temp directory: <tmp>/claude/<project>/<session-id>/{scratchpad,tasks}.
 */
export const SCRATCH_ROOT = process.env.CLAUDE_SCRATCH_DIR
  ? path.resolve(process.env.CLAUDE_SCRATCH_DIR)
  : path.join(os.tmpdir(), 'claude');

/**
 * The only two trees this app may ever modify. Everything destructive is
 * checked against this list, so adding a root is a deliberate, visible act
 * rather than a side effect of a path bug.
 */
export const MANAGED_ROOTS = [CLAUDE_ROOT, SCRATCH_ROOT];

function isInside(root, target) {
  const rel = path.relative(root, path.resolve(target));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Guard every delete: refuse to touch anything outside ~/.claude. */
export function isInsideClaudeRoot(target) {
  return isInside(CLAUDE_ROOT, target);
}

export function isInsideScratchRoot(target) {
  return isInside(SCRATCH_ROOT, target);
}

/** Purges may remove only what sits inside the trash directory itself. */
export function isInsideTrashDir(target) {
  return isInside(TRASH_DIR, target);
}

/** True when the path sits inside a tree this app is allowed to touch. */
export function isManagedPath(target) {
  return MANAGED_ROOTS.some((root) => isInside(root, target));
}
