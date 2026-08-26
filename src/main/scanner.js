// Builds the index the whole UI renders from: every project, its sessions,
// its memories, and the disk each one occupies.
//
// Two things make this non-trivial. First, session metadata only exists inside
// the transcripts, so learning "what is this session and is it worth keeping?"
// means streaming a .jsonl that can run to several megabytes -- so results are
// cached against (size, mtime) and re-read only when a transcript changes.
// Second, a session is not one file: it owns a sibling directory of
// tool-results and subagent transcripts, plus entries under file-history/ and
// session-env/. Cleanup has to account for all of it, which is why every
// session carries a resolved `satellites` list.

import path from 'node:path';
import fs from 'node:fs/promises';
import {
  PROJECTS_DIR,
  SESSION_KEYED_DIRS,
  SESSIONS_REGISTRY_DIR,
  decodeProjectDir,
  isSessionId,
} from './paths.js';
import { readDirSafe, statOrNull, readJsonSafe, readJsonl, measure, writeJsonAtomic } from './util.js';
import { readMemoryDir } from './memories.js';

let cachePath = null;
let cache = new Map();

export async function initCache(file) {
  cachePath = file;
  const saved = await readJsonSafe(file, null);
  if (saved && saved.version === 2 && saved.entries) {
    cache = new Map(Object.entries(saved.entries));
  }
}

async function saveCache() {
  if (!cachePath) return;
  try {
    await writeJsonAtomic(cachePath, { version: 2, entries: Object.fromEntries(cache) });
  } catch {
    /* a cache that cannot be written is not worth failing a scan over */
  }
}

/**
 * Sessions that a live Claude Code process is currently attached to. These are
 * hard-blocked from deletion -- removing a transcript out from under a running
 * session corrupts it.
 */
export async function readLiveSessions() {
  const out = new Map();
  for (const name of await readDirSafe(SESSIONS_REGISTRY_DIR)) {
    if (!name.endsWith('.json')) continue;
    const reg = await readJsonSafe(path.join(SESSIONS_REGISTRY_DIR, name));
    if (!reg || !reg.sessionId) continue;

    let alive = false;
    if (typeof reg.pid === 'number') {
      try {
        process.kill(reg.pid, 0);
        alive = true;
      } catch (err) {
        alive = err.code === 'EPERM'; // exists but owned by another user
      }
    }
    out.set(reg.sessionId, {
      sessionId: reg.sessionId,
      pid: reg.pid,
      cwd: reg.cwd,
      name: reg.name,
      status: reg.status,
      kind: reg.kind,
      entrypoint: reg.entrypoint,
      startedAt: reg.startedAt,
      updatedAt: reg.updatedAt,
      registryFile: path.join(SESSIONS_REGISTRY_DIR, name),
      alive,
    });
  }
  return out;
}

/** Stream one transcript and reduce it to the metadata the UI shows. */
async function scanTranscript(file) {
  const meta = {
    title: '',
    lastPrompt: '',
    firstPrompt: '',
    firstTs: null,
    lastTs: null,
    counts: { user: 0, assistant: 0, toolUse: 0, toolResult: 0, sidechain: 0, thinking: 0 },
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
    models: {},
    tools: {},
    cwd: '',
    gitBranch: '',
    entrypoint: '',
    versions: [],
    records: 0,
    malformed: 0,
  };
  const versions = new Set();

  const { total, bad } = await readJsonl(file, (o) => {
    if (o.timestamp) {
      if (!meta.firstTs || o.timestamp < meta.firstTs) meta.firstTs = o.timestamp;
      if (!meta.lastTs || o.timestamp > meta.lastTs) meta.lastTs = o.timestamp;
    }
    if (o.cwd && !meta.cwd) meta.cwd = o.cwd;
    if (o.gitBranch && !meta.gitBranch) meta.gitBranch = o.gitBranch;
    if (o.entrypoint && !meta.entrypoint) meta.entrypoint = o.entrypoint;
    if (o.version) versions.add(o.version);

    if (o.type === 'ai-title' && o.aiTitle) meta.title = o.aiTitle;
    if (o.type === 'last-prompt' && o.lastPrompt) meta.lastPrompt = o.lastPrompt;

    if (o.isSidechain) meta.counts.sidechain += 1;

    if (o.type === 'user') {
      meta.counts.user += 1;
      if (!meta.firstPrompt && !o.isSidechain) {
        const c = o.message?.content;
        if (typeof c === 'string') meta.firstPrompt = c.slice(0, 300);
      }
    } else if (o.type === 'assistant') {
      meta.counts.assistant += 1;
      const m = o.message;
      if (m?.model) meta.models[m.model] = (meta.models[m.model] || 0) + 1;
      const u = m?.usage;
      if (u) {
        meta.tokens.input += u.input_tokens || 0;
        meta.tokens.output += u.output_tokens || 0;
        meta.tokens.cacheRead += u.cache_read_input_tokens || 0;
        meta.tokens.cacheCreate += u.cache_creation_input_tokens || 0;
      }
      if (Array.isArray(m?.content)) {
        for (const b of m.content) {
          if (b.type === 'tool_use') {
            meta.counts.toolUse += 1;
            meta.tools[b.name] = (meta.tools[b.name] || 0) + 1;
          } else if (b.type === 'thinking') {
            meta.counts.thinking += 1;
          }
        }
      }
    }

    if (Array.isArray(o.message?.content)) {
      for (const b of o.message.content) if (b.type === 'tool_result') meta.counts.toolResult += 1;
    }
  });

  meta.records = total;
  meta.malformed = bad;
  meta.versions = [...versions].sort();
  return meta;
}

/** Metadata for one session, served from cache when the transcript is unchanged. */
async function readSession(projectId, projectDir, jsonlName) {
  const id = jsonlName.replace(/\.jsonl$/i, '');
  const jsonlPath = path.join(projectDir, jsonlName);
  const st = await statOrNull(jsonlPath);
  if (!st) return null;

  const cacheKey = jsonlPath;
  const cached = cache.get(cacheKey);
  let meta;
  if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) {
    meta = cached.meta;
  } else {
    meta = await scanTranscript(jsonlPath);
    cache.set(cacheKey, { size: st.size, mtimeMs: st.mtimeMs, meta });
  }

  // The session's own satellite payload: tool-results/ and subagents/.
  const sidecarDir = path.join(projectDir, id);
  const satellites = [];
  let totalBytes = st.size;

  const sidecar = await measure(sidecarDir);
  if (sidecar.exists) {
    satellites.push({
      kind: 'sidecar',
      label: 'Tool results & subagents',
      path: sidecarDir,
      bytes: sidecar.bytes,
      files: sidecar.files,
    });
    totalBytes += sidecar.bytes;
  }

  for (const { key, dir, label } of SESSION_KEYED_DIRS) {
    const p = path.join(dir, id);
    const m = await measure(p);
    if (m.exists) {
      satellites.push({ kind: key, label, path: p, bytes: m.bytes, files: m.files });
      totalBytes += m.bytes;
    }
  }

  let subagentCount = 0;
  if (sidecar.exists) {
    const subs = await readDirSafe(path.join(sidecarDir, 'subagents'));
    subagentCount = subs.filter((n) => n.endsWith('.jsonl')).length;
  }

  return {
    id,
    projectId,
    jsonlPath,
    sidecarDir: sidecar.exists ? sidecarDir : null,
    bytes: st.size,
    totalBytes,
    mtime: st.mtimeMs,
    satellites,
    subagentCount,
    ...meta,
  };
}

/**
 * Resolve a project directory name back to a real path, verifying candidate
 * splits against the filesystem so that "claude-manager" is not mangled into
 * "claude\manager". Only used when no transcript recorded the true cwd.
 */
async function resolveProjectPath(dirName) {
  const naive = decodeProjectDir(dirName);
  if (await statOrNull(naive)) return { realPath: naive, inferred: false, missing: false };

  const drive = dirName.match(/^([A-Za-z])--(.*)$/);
  if (drive) {
    const segments = drive[2].split('-');
    let current = drive[1].toUpperCase() + ':' + path.sep;
    let ok = true;
    let i = 0;
    while (i < segments.length) {
      // Greedily prefer the longest join that exists on disk, so folder names
      // containing hyphens survive the round trip.
      let matched = false;
      for (let take = segments.length - i; take >= 1; take--) {
        const candidate = path.join(current, segments.slice(i, i + take).join('-'));
        if (await statOrNull(candidate)) {
          current = candidate;
          i += take;
          matched = true;
          break;
        }
      }
      if (!matched) {
        ok = false;
        break;
      }
    }
    if (ok) return { realPath: current, inferred: false, missing: false };
  }
  return { realPath: naive, inferred: true, missing: true };
}

/**
 * Read one project directory: its sessions, its orphan sidecars, the working
 * directory it belongs to, and its size on disk. Session ids are added to
 * `sessionIds` as they are found, because memory diagnosis needs the complete
 * set before it can run.
 *
 * Returns null when the directory is gone, which is what a deleted project
 * looks like to a caller re-reading just that one.
 */
async function readProjectDir(dirName, live, sessionIds) {
  const projectDir = path.join(PROJECTS_DIR, dirName);
  const st = await statOrNull(projectDir);
  if (!st || !st.isDirectory()) return null;

  const entries = await readDirSafe(projectDir, { withFileTypes: true });
  const jsonls = entries.filter((e) => e.isFile() && e.name.endsWith('.jsonl')).map((e) => e.name);

  const sessions = [];
  for (const name of jsonls) {
    const s = await readSession(dirName, projectDir, name);
    if (!s) continue;
    const reg = live.get(s.id);
    s.live = Boolean(reg && reg.alive);
    s.liveInfo = s.live ? reg : null;
    sessions.push(s);
    sessionIds.add(s.id);
  }
  sessions.sort((a, b) => (b.lastTs || '').localeCompare(a.lastTs || '') || b.mtime - a.mtime);

  // Sidecar directories whose transcript is already gone are pure waste.
  const orphanSidecars = [];
  for (const e of entries) {
    if (!e.isDirectory() || !isSessionId(e.name)) continue;
    if (jsonls.includes(e.name + '.jsonl')) continue;
    const p = path.join(projectDir, e.name);
    const m = await measure(p);
    orphanSidecars.push({ id: e.name, path: p, bytes: m.bytes, files: m.files });
  }

  const realFromTranscript = sessions.find((s) => s.cwd)?.cwd || '';
  const resolved = realFromTranscript
    ? { realPath: realFromTranscript, inferred: false, missing: false }
    : await resolveProjectPath(dirName);
  const cwdExists = Boolean(await statOrNull(resolved.realPath));

  const { bytes: totalBytes } = await measure(projectDir);

  return {
    id: dirName,
    dir: projectDir,
    realPath: resolved.realPath,
    pathInferred: resolved.inferred,
    cwdExists,
    sessions,
    orphanSidecars,
    totalBytes,
    sessionCount: sessions.length,
    liveCount: sessions.filter((s) => s.live).length,
    lastActivity: sessions[0]?.lastTs || null,
  };
}

/** Diagnose a project's memories. Split out because it needs the session-id
 *  set from every project, not just this one. */
async function attachMemory(partial, allSessionIds) {
  const memory = await readMemoryDir(path.join(partial.dir, 'memory'), allSessionIds);
  return {
    ...partial,
    memory: {
      exists: memory.exists,
      path: memory.path,
      bytes: memory.bytes,
      count: memory.files.length,
      issues: memory.issues,
      files: memory.files.map((f) => ({ ...f, text: undefined, body: undefined })),
      hasIndex: Boolean(memory.index),
      indexPath: memory.index?.path || '',
    },
  };
}

export const sortProjects = (projects) =>
  projects.sort((a, b) => (b.lastActivity || '').localeCompare(a.lastActivity || ''));

/** Full scan of ~/.claude/projects plus the live-session registry. */
export async function scanProjects() {
  const live = await readLiveSessions();
  const dirNames = (await readDirSafe(PROJECTS_DIR, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

  // Pass 1: read every project's sessions. Memory diagnosis is deferred to a
  // second pass because `stale-origin` compares against the complete set of
  // surviving session ids -- a memory in one project routinely records an
  // origin session that lives in another.
  const partials = [];
  const allSessionIds = new Set();
  for (const dirName of dirNames) {
    const partial = await readProjectDir(dirName, live, allSessionIds);
    if (partial) partials.push(partial);
  }

  // Pass 2: diagnose memories against the now-complete session-id set.
  const projects = [];
  for (const p of partials) projects.push(await attachMemory(p, allSessionIds));

  sortProjects(projects);
  await saveCache();

  return {
    generatedAt: new Date().toISOString(),
    projects,
    live: [...live.values()],
    sessionIds: [...allSessionIds],
  };
}

/**
 * Re-read exactly one project. Deleting a memory changes that project's
 * directory and nothing else, so re-deriving the other twenty-four is pure
 * waste -- this is the same work for one of them.
 *
 * `knownSessionIds` is the surviving set across the whole tree, needed because
 * a memory here can record an origin session that lives in another project.
 * Returns null when the project directory no longer exists.
 */
export async function rescanProject(dirName, knownSessionIds = new Set()) {
  const live = await readLiveSessions();
  const own = new Set();
  const partial = await readProjectDir(dirName, live, own);
  if (!partial) return null;

  const project = await attachMemory(partial, knownSessionIds);
  await saveCache();
  return { project, live: [...live.values()], sessionIds: [...own] };
}

/** Read a memory file's full text on demand (the index omits bodies). */
export async function readMemoryFile(filePath) {
  return fs.readFile(filePath, 'utf8');
}
