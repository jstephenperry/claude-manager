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
import fs from 'node:fs/promises';

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
 * Claude Code's temp root: <root>/<project>/<session-id>/{scratchpad,tasks}.
 * This follows Claude Code's own builds (2.1.100 source, 2.1.312 Windows,
 * macOS and Linux binaries): the root is <base>/<name>, where <base> is
 * CLAUDE_CODE_TMPDIR when it is set, otherwise /tmp on macOS (not the per-user
 * $TMPDIR that os.tmpdir() returns there) and the OS temp directory elsewhere,
 * and <name> is claude on Windows and claude-<uid> on Linux and macOS, so that
 * one account's sessions never share a tree with another's.
 */
function scratchRoot() {
  const env = process.env;
  if (env.CLAUDE_SCRATCH_DIR) return path.resolve(env.CLAUDE_SCRATCH_DIR);
  const base = env.CLAUDE_CODE_TMPDIR ? path.resolve(env.CLAUDE_CODE_TMPDIR)
    : process.platform === 'darwin' ? '/tmp' : os.tmpdir();
  if (process.platform === 'win32') return path.join(base, 'claude');
  return path.join(base, `claude-${process.getuid?.() ?? 0}`);
}

export const SCRATCH_ROOT = scratchRoot();

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

/**
 * The checks above are lexical: they compare path strings, and a path string
 * says nothing about where the filesystem will take it. A directory inside a
 * managed root can be a symlink or junction to anywhere, and creating one
 * needs no privilege: `mklink /J` on Windows, `ln -s` elsewhere. So
 * `~/.claude/cache` linked to the user's Documents passes every lexical guard
 * while every move, write or purge through it lands outside the root.
 *
 * `assertResolvesInside` closes that: the target's parent, resolved through
 * every link, must still be inside the root, itself resolved. A root may be a
 * link (a dotfile manager may own ~/.claude); what sits below it may not lead
 * out. The final component is a separate question, because moving a link moves
 * the link and not what it points at, while writing to one writes the target.
 *
 * What remains is a race: a path can be swapped for a link between this check
 * and the operation. Node has no openat-style API to close that, so these
 * checks shut the planted-link case, not a concurrent one.
 */

async function realOrNull(p) {
  try {
    return await fs.realpath(p);
  } catch {
    return null;
  }
}

/**
 * `p` resolved through links as far as it exists: the nearest existing
 * ancestor's real path, with the not-yet-created remainder appended. A restore
 * recreates missing parents, so what matters is where the existing part leads.
 */
async function resolveReal(p) {
  let cur = path.resolve(p);
  const rest = [];
  for (;;) {
    const real = await realOrNull(cur);
    if (real) return path.join(real, ...rest.reverse());
    // A link whose target does not exist yet still decides where a mkdir goes.
    if (await fs.lstat(cur).then(() => true, () => false)) return null;
    const up = path.dirname(cur);
    if (up === cur) return null;
    rest.push(path.basename(cur));
    cur = up;
  }
}

function isInsideOrAt(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * The scratchpad root sits in the OS temp directory, which on Linux is shared
 * by every user on the machine. It is never legitimately a link, and on POSIX
 * it must belong to us: otherwise another account decides what it contains.
 * Claude Code refuses a claude-<uid> it does not own for the same reason.
 */
async function assertRootSound(root) {
  if (root !== SCRATCH_ROOT) return;
  const st = await fs.lstat(root).catch(() => null);
  if (!st) return;
  if (st.isSymbolicLink()) throw new Error(`Refusing to work in ${root}: it is a link to somewhere else.`);
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
    throw new Error(`Refusing to work in ${root}: it belongs to another user.`);
  }
}

/**
 * @param target path to check
 * @param root   the tree it must stay inside
 * @param opts.finalLink 'allow' when the operation acts on a link itself (a
 *        move or a delete), 'refuse' when it would follow one (a write)
 */
export async function assertResolvesInside(target, root, { finalLink = 'refuse' } = {}) {
  const full = path.resolve(target);
  if (!isInside(root, full)) throw new Error(`Refusing to touch a path outside ${root}: ${target}`);
  await assertRootSound(root);
  const realRoot = await resolveReal(root);
  const realParent = await resolveReal(path.dirname(full));
  if (!realRoot || !realParent || !isInsideOrAt(realRoot, realParent)) {
    throw new Error(`Refusing to touch ${target}: a directory on the way to it is a link that leads outside ${root}.`);
  }
  if (finalLink === 'refuse') {
    const st = await fs.lstat(full).catch(() => null);
    if (st?.isSymbolicLink()) throw new Error(`Refusing to write through a link: ${target}`);
  }
}

/** `assertResolvesInside` against whichever managed root lexically holds the path. */
export async function assertManagedResolves(target, opts) {
  const root = MANAGED_ROOTS.find((r) => isInside(r, target));
  if (!root) throw new Error(`Refusing to touch a path outside the managed directories: ${target}`);
  await assertResolvesInside(target, root, opts);
}

/**
 * The trash directory is where purges recurse, so it has to be a real
 * directory: if `.manager-trash` were a link to the home directory, emptying
 * the trash would empty that instead. Missing is fine; it is created on use.
 */
export async function trashDirIsSound() {
  const st = await fs.lstat(TRASH_DIR).catch(() => null);
  if (!st) return true;
  return st.isDirectory() && !st.isSymbolicLink();
}

/** A memory file the editor may write: `projects/<project>/memory/<name>.md`. */
export function isMemoryFilePath(target) {
  const rel = path.relative(PROJECTS_DIR, path.resolve(target));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  const parts = rel.split(path.sep);
  return parts.length === 3 && parts[1] === 'memory' && parts[2].toLowerCase().endsWith('.md');
}

const UUID_ANY_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Every session id named anywhere in a set of paths, lower-cased. */
export function sessionIdsIn(paths) {
  const out = new Set();
  for (const p of paths || []) {
    for (const m of String(p).matchAll(UUID_ANY_RE)) out.add(m[0].toLowerCase());
  }
  return out;
}
