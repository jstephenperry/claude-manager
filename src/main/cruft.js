// The ancillary storage under ~/.claude that nothing else surfaces.
//
// Two categories. Session-keyed directories (file-history/, session-env/) hold
// one entry per session id; once the transcript is gone the entry is dead
// weight that nothing will ever read again, and those are the safe wins. Loose
// directories (shell-snapshots/, cache/, backups/, debug/, downloads/) just
// accumulate, so they are reported by age and size and left to the user's
// judgement rather than being labelled orphans.

import path from 'node:path';
import { LOOSE_DIRS, SESSION_KEYED_DIRS, SESSIONS_REGISTRY_DIR } from './paths.js';
import { readDirSafe, statOrNull, measure, readJsonSafe } from './util.js';

/**
 * @param knownSessionIds ids that still have a transcript
 * @param liveSessionIds  ids currently attached to a running process
 */
export async function scanCruft(knownSessionIds, liveSessionIds = new Set()) {
  const groups = [];

  for (const { key, dir, label } of SESSION_KEYED_DIRS) {
    const items = [];
    for (const name of await readDirSafe(dir)) {
      const full = path.join(dir, name);
      const st = await statOrNull(full);
      if (!st) continue;
      const { bytes, files } = await measure(full);
      const orphan = !knownSessionIds.has(name);
      items.push({
        id: `${key}:${name}`,
        name,
        path: full,
        bytes,
        files,
        mtime: st.mtimeMs,
        orphan,
        live: liveSessionIds.has(name),
        note: orphan ? 'Session transcript no longer exists' : 'Belongs to an existing session',
      });
    }
    items.sort((a, b) => Number(b.orphan) - Number(a.orphan) || b.bytes - a.bytes);
    groups.push({
      key,
      label,
      dir,
      sessionKeyed: true,
      items,
      bytes: items.reduce((n, i) => n + i.bytes, 0),
      orphanCount: items.filter((i) => i.orphan).length,
      orphanBytes: items.filter((i) => i.orphan).reduce((n, i) => n + i.bytes, 0),
    });
  }

  for (const { key, dir, label } of LOOSE_DIRS) {
    const items = [];
    for (const name of await readDirSafe(dir)) {
      const full = path.join(dir, name);
      const st = await statOrNull(full);
      if (!st) continue;
      const { bytes, files } = await measure(full);
      items.push({
        id: `${key}:${name}`,
        name,
        path: full,
        bytes,
        files,
        mtime: st.mtimeMs,
        orphan: false,
        live: false,
        note: '',
      });
    }
    items.sort((a, b) => b.mtime - a.mtime);
    groups.push({
      key,
      label,
      dir,
      sessionKeyed: false,
      items,
      bytes: items.reduce((n, i) => n + i.bytes, 0),
      orphanCount: 0,
      orphanBytes: 0,
    });
  }

  // Registry files describing processes that are no longer running.
  const staleRegistry = [];
  for (const name of await readDirSafe(SESSIONS_REGISTRY_DIR)) {
    const full = path.join(SESSIONS_REGISTRY_DIR, name);
    const st = await statOrNull(full);
    if (!st || !st.isFile()) continue;

    // Both "<pid>.json" and "<pid>.<hash>.key" are named for the owning
    // process, so liveness for either is just "is that pid still running".
    let sessionId = '';
    let pid = Number.parseInt(name.split('.')[0], 10);
    if (name.endsWith('.json')) {
      const reg = await readJsonSafe(full);
      sessionId = reg?.sessionId || '';
      if (typeof reg?.pid === 'number') pid = reg.pid;
    }

    let alive = false;
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        alive = true;
      } catch (err) {
        alive = err.code === 'EPERM';
      }
    }
    if (!alive) {
      staleRegistry.push({
        id: `registry:${name}`,
        name,
        path: full,
        bytes: st.size,
        files: 1,
        mtime: st.mtimeMs,
        orphan: true,
        live: false,
        note: sessionId ? `Process for session ${sessionId.slice(0, 8)}… has exited` : 'Process has exited',
      });
    }
  }
  if (staleRegistry.length) {
    groups.push({
      key: 'sessions-registry',
      label: 'Stale process registry',
      dir: SESSIONS_REGISTRY_DIR,
      sessionKeyed: false,
      items: staleRegistry,
      bytes: staleRegistry.reduce((n, i) => n + i.bytes, 0),
      orphanCount: staleRegistry.length,
      orphanBytes: staleRegistry.reduce((n, i) => n + i.bytes, 0),
    });
  }

  return {
    groups,
    totalBytes: groups.reduce((n, g) => n + g.bytes, 0),
    reclaimableBytes: groups.reduce((n, g) => n + g.orphanBytes, 0),
  };
}
