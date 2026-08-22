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
import { TRASH_DIR, isInsideClaudeRoot, isManagedPath } from './paths.js';
import { readJsonSafe, writeJsonAtomic, statOrNull, movePath, measure, readDirSafe } from './util.js';

const MANIFEST = path.join(TRASH_DIR, 'manifest.json');

async function readManifest() {
  const m = await readJsonSafe(MANIFEST, null);
  if (m && Array.isArray(m.entries)) return m;
  return { version: 1, entries: [] };
}

async function writeManifest(m) {
  await fs.mkdir(TRASH_DIR, { recursive: true });
  await writeJsonAtomic(MANIFEST, m);
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
    await fs.rm(entryDir, { recursive: true, force: true });
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
    await fs.rm(path.join(TRASH_DIR, entry.id), { recursive: true, force: true });
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
  const dir = path.join(TRASH_DIR, entry.id);
  if (!isInsideClaudeRoot(dir)) throw new Error('Refusing to purge outside the Claude data directory.');
  await fs.rm(dir, { recursive: true, force: true });
  manifest.entries.splice(idx, 1);
  await writeManifest(manifest);
  return { purged: 1, bytes: entry.bytes };
}

export async function purgeAll() {
  const manifest = await readManifest();
  let bytes = 0;
  for (const e of manifest.entries) {
    const dir = path.join(TRASH_DIR, e.id);
    if (!isInsideClaudeRoot(dir)) continue;
    await fs.rm(dir, { recursive: true, force: true });
    bytes += e.bytes;
  }
  const count = manifest.entries.length;
  manifest.entries = [];
  await writeManifest(manifest);

  // Sweep any orphaned entry directories a crash may have left behind.
  for (const name of await readDirSafe(TRASH_DIR)) {
    if (name === 'manifest.json') continue;
    await fs.rm(path.join(TRASH_DIR, name), { recursive: true, force: true });
  }
  return { purged: count, bytes };
}

export async function trashSize() {
  const { bytes } = await measure(TRASH_DIR);
  const manifest = await readManifest();
  return { bytes, count: manifest.entries.length };
}
