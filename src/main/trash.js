// Restorable soft-delete.
//
// Nothing here unlinks a file. A delete moves every path belonging to an item
// into ~/.claude/.manager-trash/<entry-id>/ and records where each one came
// from, so restore is an exact reversal. Permanent removal is a separate,
// explicit purge. Every path is checked against the managed roots first
// (~/.claude and the scratchpad tree under the OS temp directory): a bug in
// path resolution should fail loudly rather than delete something elsewhere.

import path from 'node:path';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { TRASH_DIR, isInsideTrashDir, isManagedPath } from './paths.js';
import { readJsonSafe, writeJsonAtomic, statOrNull, movePath, measure, readDirSafe } from './util.js';

const MANIFEST = path.join(TRASH_DIR, 'manifest.json');

/**
 * The manifest is data on disk, not a trusted record. It sits inside ~/.claude,
 * which a Claude Code session writes to freely -- so a prompt-injected session,
 * or any process running as the user, can put whatever it likes in it. Every
 * field that becomes a filesystem path is checked before it is believed:
 *
 * - `id` must be exactly what `trashItem` generates (base-36 time, dash, eight
 *   hex digits). `../projects` is not an id, and `path.join(TRASH_DIR, id)` would
 *   otherwise resolve straight out of the trash into a recursive delete.
 * - every `to` must sit inside this entry's own directory under the trash;
 * - every `from` must sit inside a managed root, or restore becomes "move any
 *   file to any path".
 *
 * Entries that fail are kept in the file so nothing is silently discarded, but
 * they are never listed, restored, or purged.
 */
const ID_RE = /^[a-z0-9]+-[0-9a-f]{8}$/;

function entryIsSound(e) {
  if (!e || typeof e.id !== 'string' || !ID_RE.test(e.id)) return false;
  if (!Array.isArray(e.paths)) return false;
  const dir = path.join(TRASH_DIR, e.id);
  return e.paths.every(
    (p) =>
      p &&
      typeof p.from === 'string' &&
      typeof p.to === 'string' &&
      isManagedPath(p.from) &&
      isInsideTrashDir(p.to) &&
      path.relative(dir, path.resolve(p.to)) !== '' &&
      !path.relative(dir, path.resolve(p.to)).startsWith('..')
  );
}

async function readManifest() {
  const m = await readJsonSafe(MANIFEST, null);
  if (!m || !Array.isArray(m.entries)) return { version: 1, entries: [], rejected: [] };
  const entries = [];
  const rejected = [];
  for (const e of m.entries) (entryIsSound(e) ? entries : rejected).push(e);
  if (rejected.length) {
    console.warn(`[trash] ignoring ${rejected.length} manifest entr${rejected.length === 1 ? 'y' : 'ies'} with paths outside the trash`);
  }
  return { version: 1, entries, rejected };
}

async function writeManifest(m) {
  await fs.mkdir(TRASH_DIR, { recursive: true });
  // Unsound entries ride along untouched: inert, but not erased behind the
  // user's back.
  await writeJsonAtomic(MANIFEST, { version: 1, entries: [...m.entries, ...(m.rejected || [])] });
}

/** Refuse to remove anything that is not inside the trash directory itself. */
async function removeInsideTrash(dir) {
  if (!isInsideTrashDir(dir)) throw new Error(`Refusing to purge outside the trash directory: ${dir}`);
  await fs.rm(dir, { recursive: true, force: true });
}

/**
 * Move one logical item (a session and all its satellites, a memory file, a
 * cruft directory) into the trash.
 *
 * @param item.kind    'session' | 'memory' | 'cruft' | 'sidecar' | ...
 * @param item.label   human-readable name for the Trash list
 * @param item.paths   absolute paths to move; missing ones are skipped
 * @param item.context extra fields echoed back in the manifest
 */
export async function trashItem(item) {
  const paths = (item.paths || []).filter(Boolean);
  for (const p of paths) {
    // Deletes may touch ~/.claude or the scratchpad root, and nothing else.
    // Purging (below) stays scoped to the trash directory itself.
    if (!isManagedPath(p)) {
      throw new Error(`Refusing to delete a path outside the managed directories: ${p}`);
    }
  }

  const entryId = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const entryDir = path.join(TRASH_DIR, entryId);
  const moved = [];
  let bytes = 0;

  for (const [i, from] of paths.entries()) {
    const st = await statOrNull(from);
    if (!st) continue;
    const { bytes: b } = await measure(from);
    // Slot per path keeps two same-named files in one item from colliding.
    const to = path.join(entryDir, String(i), path.basename(from));
    await movePath(from, to);
    moved.push({ from, to, isDir: st.isDirectory(), bytes: b });
    bytes += b;
  }

  if (!moved.length) {
    await removeInsideTrash(entryDir);
    return null;
  }

  const entry = {
    id: entryId,
    kind: item.kind,
    label: item.label,
    context: item.context || {},
    deletedAt: new Date().toISOString(),
    bytes,
    paths: moved,
  };

  const manifest = await readManifest();
  manifest.entries.unshift(entry);
  await writeManifest(manifest);
  return entry;
}

export async function listTrash() {
  const manifest = await readManifest();
  // Report whether each entry's original location is free, so the UI can warn
  // before a restore that would collide with a recreated file.
  const entries = [];
  for (const e of manifest.entries) {
    const conflicts = [];
    for (const p of e.paths) {
      if (await statOrNull(p.from)) conflicts.push(p.from);
    }
    entries.push({ ...e, conflicts });
  }
  return entries;
}

export async function restoreEntry(id) {
  const manifest = await readManifest();
  const idx = manifest.entries.findIndex((e) => e.id === id);
  if (idx === -1) throw new Error('That trash entry no longer exists.');
  const entry = manifest.entries[idx];

  const restored = [];
  const skipped = [];
  for (const p of entry.paths) {
    if (await statOrNull(p.from)) {
      skipped.push(p.from); // something new occupies the original path
      continue;
    }
    if (!(await statOrNull(p.to))) {
      skipped.push(p.from);
      continue;
    }
    await movePath(p.to, p.from);
    restored.push(p.from);
  }

  if (!skipped.length) {
    manifest.entries.splice(idx, 1);
    await removeInsideTrash(path.join(TRASH_DIR, entry.id));
  } else {
    // Keep the entry alive so the un-restored remainder is still recoverable.
    entry.paths = entry.paths.filter((p) => skipped.includes(p.from));
  }
  await writeManifest(manifest);
  return { restored, skipped };
}

export async function purgeEntry(id) {
  const manifest = await readManifest();
  const idx = manifest.entries.findIndex((e) => e.id === id);
  if (idx === -1) return { purged: 0 };
  const entry = manifest.entries[idx];
  await removeInsideTrash(path.join(TRASH_DIR, entry.id));
  manifest.entries.splice(idx, 1);
  await writeManifest(manifest);
  return { purged: 1, bytes: entry.bytes };
}

export async function purgeAll() {
  const manifest = await readManifest();
  let bytes = 0;
  for (const e of manifest.entries) {
    await removeInsideTrash(path.join(TRASH_DIR, e.id));
    bytes += e.bytes;
  }
  const count = manifest.entries.length;
  manifest.entries = [];
  manifest.rejected = []; // emptying the trash is the one time unsound records go too
  await writeManifest(manifest);

  // Sweep any orphaned entry directories a crash may have left behind. Names
  // come from readdir, so they are single segments and cannot climb out.
  for (const name of await readDirSafe(TRASH_DIR)) {
    if (name === 'manifest.json') continue;
    await removeInsideTrash(path.join(TRASH_DIR, name));
  }
  return { purged: count, bytes };
}

/**
 * What the trash holds, from the manifest rather than a walk of the directory.
 *
 * Every entry recorded its measured size when it was moved, so the total is
 * arithmetic over a file we already read -- and it no longer costs a recursive
 * walk of everything ever deleted, on every scan, growing with the trash.
 * `measureTrash` remains for the rare caller that wants the true on-disk size.
 */
export async function trashSize() {
  const manifest = await readManifest();
  return {
    bytes: manifest.entries.reduce((n, e) => n + (e.bytes || 0), 0),
    count: manifest.entries.length,
  };
}

/** The trash's real size on disk, walk and all. */
export async function measureTrash() {
  const { bytes } = await measure(TRASH_DIR);
  return bytes;
}
