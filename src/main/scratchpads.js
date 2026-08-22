// Session scratchpads and background-task output.
//
// Claude Code gives each session a private working directory under the OS temp
// folder: <tmp>/claude/<project>/<session-id>/{scratchpad,tasks}. Nothing ever
// prunes it. In practice the tree fills with empty husks -- a directory per
// session that never wrote a file -- plus a handful of sessions holding real
// scripts, diffs, and captured command output.
//
// The layout is not perfectly uniform: some projects have a bare `tasks/`
// directory with no session id above it, and the root holds loose
// `cache-break-state-<session-id>.json` files. Both are handled as their own
// cases rather than assumed away.

import path from 'node:path';
import fs from 'node:fs/promises';
import { SCRATCH_ROOT, isSessionId } from './paths.js';
import { readDirSafe, statOrNull, measure } from './util.js';

/**
 * Top-level names under the scratchpad root that are not session data. These
 * are listed read-only and never become sweep candidates -- `bundled-skills`
 * is Claude Code's own payload, not this session's leftovers.
 */
const RESERVED_DIRS = new Set(['bundled-skills']);

const TEXT_EXT = new Set([
  '.txt', '.md', '.json', '.jsonl', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
  '.py', '.sh', '.ps1', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.csv', '.tsv',
  '.html', '.css', '.xml', '.diff', '.patch', '.log', '.output', '.sql', '.env',
]);

/** Newest mtime anywhere under a path -- the honest "last used" for a folder. */
async function newestMtime(target) {
  let newest = 0;
  const stack = [target];
  while (stack.length) {
    const dir = stack.pop();
    for (const ent of await readDirSafe(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        stack.push(full);
        const st = await statOrNull(full);
        if (st && st.mtimeMs > newest) newest = st.mtimeMs;
      } else {
        const st = await statOrNull(full);
        if (st && st.mtimeMs > newest) newest = st.mtimeMs;
      }
    }
  }
  if (!newest) {
    const st = await statOrNull(target);
    if (st) newest = st.mtimeMs;
  }
  return newest;
}

/** Shallow listing of one directory, for the file browser. */
export async function listDir(dir) {
  const out = [];
  for (const ent of await readDirSafe(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    const st = await statOrNull(full);
    if (!st) continue;
    if (ent.isDirectory()) {
      const m = await measure(full);
      out.push({
        name: ent.name, path: full, isDir: true,
        bytes: m.bytes, files: m.files, mtime: st.mtimeMs,
      });
    } else {
      out.push({
        name: ent.name, path: full, isDir: false,
        bytes: st.size, files: 1, mtime: st.mtimeMs,
        text: TEXT_EXT.has(path.extname(ent.name).toLowerCase()) || !path.extname(ent.name),
      });
    }
  }
  return out.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
}

const MAX_PREVIEW = 400_000;

/** Read a scratchpad file for preview, refusing anything that looks binary. */
export async function readScratchFile(file) {
  const st = await statOrNull(file);
  if (!st) throw new Error('That file no longer exists.');
  if (st.size > MAX_PREVIEW) {
    const fh = await fs.open(file, 'r');
    try {
      const buf = Buffer.alloc(MAX_PREVIEW);
      await fh.read(buf, 0, MAX_PREVIEW, 0);
      return { text: buf.toString('utf8'), truncated: true, bytes: st.size };
    } finally {
      await fh.close();
    }
  }
  const buf = await fs.readFile(file);
  // A NUL byte in the first block is the usual binary tell.
  if (buf.subarray(0, 4096).includes(0)) {
    return { text: '', binary: true, bytes: st.size };
  }
  return { text: buf.toString('utf8'), truncated: false, bytes: st.size };
}

/**
 * Scan the whole scratchpad tree.
 *
 * @param knownSessionIds session ids that still have a transcript, so
 *        scratchpads for deleted sessions can be flagged as orphans
 * @param liveSessionIds  ids currently attached to a running process
 */
export async function scanScratchpads(knownSessionIds = new Set(), liveSessionIds = new Set()) {
  const root = await statOrNull(SCRATCH_ROOT);
  if (!root) {
    return { exists: false, root: SCRATCH_ROOT, projects: [], loose: [], totalBytes: 0, emptyCount: 0, orphanBytes: 0 };
  }

  const projects = [];
  const loose = [];

  for (const name of await readDirSafe(SCRATCH_ROOT)) {
    const full = path.join(SCRATCH_ROOT, name);
    const st = await statOrNull(full);
    if (!st) continue;

    // Loose files at the root, e.g. cache-break-state-<session-id>.json.
    if (!st.isDirectory()) {
      const m = name.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
      const sid = m ? m[1] : '';
      loose.push({
        id: `scratch-loose:${name}`,
        name,
        path: full,
        bytes: st.size,
        files: 1,
        mtime: st.mtimeMs,
        sessionId: sid,
        orphan: sid ? !knownSessionIds.has(sid) : false,
        live: sid ? liveSessionIds.has(sid) : false,
        note: sid
          ? knownSessionIds.has(sid)
            ? `State for session ${sid.slice(0, 8)}…`
            : `State for session ${sid.slice(0, 8)}…, whose transcript is gone`
          : 'Loose file in the scratchpad root',
      });
      continue;
    }

    if (RESERVED_DIRS.has(name)) {
      const m = await measure(full);
      loose.push({
        id: `scratch-reserved:${name}`,
        name,
        path: full,
        bytes: m.bytes,
        files: m.files,
        mtime: await newestMtime(full),
        sessionId: '',
        orphan: false,
        live: false,
        reserved: true,
        note: 'Claude Code payload, not session data — left alone',
      });
      continue;
    }

    const children = await readDirSafe(full, { withFileTypes: true });
    const sessionDirs = children.filter((c) => c.isDirectory() && isSessionId(c.name));
    const otherDirs = children.filter((c) => c.isDirectory() && !isSessionId(c.name));

    if (!sessionDirs.length && !otherDirs.length) {
      const m = await measure(full);
      loose.push({
        id: `scratch-loose:${name}`,
        name,
        path: full,
        bytes: m.bytes,
        files: m.files,
        mtime: await newestMtime(full),
        sessionId: '',
        orphan: false,
        live: false,
        note: 'Empty scratchpad project directory',
      });
      continue;
    }

    const sessions = [];
    for (const ent of sessionDirs) {
      const sdir = path.join(full, ent.name);
      const m = await measure(sdir);
      const scratchDir = path.join(sdir, 'scratchpad');
      const tasksDir = path.join(sdir, 'tasks');
      const scratchM = await measure(scratchDir);
      const tasksM = await measure(tasksDir);

      sessions.push({
        id: `scratch:${ent.name}`,
        sessionId: ent.name,
        projectId: name,
        path: sdir,
        scratchDir: scratchM.exists ? scratchDir : null,
        tasksDir: tasksM.exists ? tasksDir : null,
        bytes: m.bytes,
        files: m.files,
        scratchBytes: scratchM.bytes,
        scratchFiles: scratchM.files,
        taskBytes: tasksM.bytes,
        taskFiles: tasksM.files,
        mtime: await newestMtime(sdir),
        empty: m.files === 0,
        orphan: !knownSessionIds.has(ent.name),
        live: liveSessionIds.has(ent.name),
      });
    }

    // A bare `tasks/` (or similar) directly under the project, with no session
    // id above it. Rare, but it exists and would otherwise be invisible.
    for (const ent of otherDirs) {
      const odir = path.join(full, ent.name);
      const m = await measure(odir);
      sessions.push({
        id: `scratch-other:${name}/${ent.name}`,
        sessionId: '',
        projectId: name,
        path: odir,
        scratchDir: null,
        tasksDir: ent.name === 'tasks' ? odir : null,
        bytes: m.bytes,
        files: m.files,
        scratchBytes: 0,
        scratchFiles: 0,
        taskBytes: ent.name === 'tasks' ? m.bytes : 0,
        taskFiles: ent.name === 'tasks' ? m.files : 0,
        mtime: await newestMtime(odir),
        empty: m.files === 0,
        orphan: true,
        live: false,
        unattached: true,
      });
    }

    sessions.sort((a, b) => b.bytes - a.bytes || b.mtime - a.mtime);
    const bytes = sessions.reduce((n, s) => n + s.bytes, 0);

    projects.push({
      id: name,
      dir: full,
      sessions,
      bytes,
      files: sessions.reduce((n, s) => n + s.files, 0),
      emptyCount: sessions.filter((s) => s.empty).length,
      orphanCount: sessions.filter((s) => s.orphan && !s.live).length,
      orphanBytes: sessions.filter((s) => s.orphan && !s.live).reduce((n, s) => n + s.bytes, 0),
      mtime: sessions.reduce((n, s) => Math.max(n, s.mtime), 0),
    });
  }

  projects.sort((a, b) => b.bytes - a.bytes || b.mtime - a.mtime);
  loose.sort((a, b) => b.bytes - a.bytes);

  const all = projects.flatMap((p) => p.sessions);
  return {
    exists: true,
    root: SCRATCH_ROOT,
    projects,
    loose,
    totalBytes: projects.reduce((n, p) => n + p.bytes, 0) + loose.reduce((n, l) => n + l.bytes, 0),
    sessionCount: all.length,
    emptyCount: all.filter((s) => s.empty).length,
    orphanCount: all.filter((s) => s.orphan && !s.live).length,
    orphanBytes: all.filter((s) => s.orphan && !s.live).reduce((n, s) => n + s.bytes, 0),
  };
}
