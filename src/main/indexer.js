// Keeping the scanned index up to date -- in whole, or in the part a change
// actually invalidated.
//
// A full scan re-derives every project, the ancillary directories and the
// scratchpad tree. On a well-used machine that is over a second of walking to
// learn that one memory file is gone, and until this module existed a single
// delete paid it three times over: once in the delete handler, once in the
// index repair that followed, and once more when the renderer asked for a
// refresh. So mutations now declare what they touched and `refresh` rebuilds
// exactly that much in place, leaving the index correct for the next reader.
//
// The invariant that matters: after any `refresh`, the index must equal what a
// `fullScan` would have produced. `scripts/t-bench.mjs` checks that against a
// real tree, because a scoped invalidation that quietly drifts from the truth
// is worse than a slow one.

import path from 'node:path';
import { CLAUDE_ROOT, PROJECTS_DIR, TRASH_DIR, SCRATCH_ROOT, isInsideClaudeRoot, isInsideScratchRoot } from './paths.js';
import { scanProjects, readLiveSessions, rescanProject, sortProjects } from './scanner.js';
import { scanCruft } from './cruft.js';
import { scanScratchpads } from './scratchpads.js';
import { trashSize } from './trash.js';
import { staleOriginIssues } from './memories.js';

/**
 * The index the whole UI renders from, kept between calls so delete handlers
 * can re-check liveness cheaply -- and so a mutation can hand the renderer the
 * scan it has already refreshed instead of provoking a second one.
 */
let lastScan = null;

export function computeTotals(scan, cruft, scratchpads, trash) {
  const liveSessions = scan.live.filter((l) => l.alive).length;
  return {
    projects: scan.projects.length,
    sessions: scan.sessionIds.length,
    liveSessions,
    memories: scan.projects.reduce((n, p) => n + p.memory.count, 0),
    memoryIssues: scan.projects.reduce((n, p) => n + p.memory.issues.length, 0),
    projectBytes: scan.projects.reduce((n, p) => n + p.totalBytes, 0),
    cruftBytes: cruft.totalBytes,
    reclaimableBytes: cruft.reclaimableBytes,
    trashBytes: trash.bytes,
    trashCount: trash.count,
    scratchBytes: scratchpads.totalBytes,
    scratchSessions: scratchpads.sessionCount || 0,
    scratchEmpty: scratchpads.emptyCount || 0,
    scratchOrphanBytes: scratchpads.orphanBytes || 0,
  };
}

export async function fullScan() {
  const scan = await scanProjects();
  const knownIds = new Set(scan.sessionIds);
  const liveIds = new Set(scan.live.filter((l) => l.alive).map((l) => l.sessionId));
  const cruft = await scanCruft(knownIds, liveIds);
  const scratchpads = await scanScratchpads(knownIds, liveIds);
  const trash = await trashSize();

  lastScan = {
    ...scan,
    cruft,
    scratchpads,
    totals: computeTotals(scan, cruft, scratchpads, trash),
    root: CLAUDE_ROOT, trashDir: TRASH_DIR, scratchRoot: SCRATCH_ROOT,
  };
  return lastScan;
}

/**
 * Refresh only what a mutation actually invalidated.
 *
 * A full scan re-derives every project, the ancillary directories and the
 * scratchpad tree -- over a thousand milliseconds on a well-used machine, to
 * learn that one memory file is gone. Deleting a memory changes one project
 * directory; purging trash changes nothing but the manifest. So each handler
 * declares its scope and this rebuilds that much of `lastScan` in place.
 *
 * @param scope.projects  project ids to re-read from disk
 * @param scope.dropped   project ids that no longer exist at all
 * @param scope.sessions  the surviving session-id set changed, so `stale-origin`
 *        has to be re-derived for every project -- it compares against ids from
 *        the whole tree. That is pure computation over memories already in
 *        hand, so it stays cheap even though it is global.
 * @param scope.cruft / scope.scratch  those trees changed and must be re-walked
 */
export async function refresh(scope = {}) {
  if (!lastScan) return fullScan();

  const projects = [...lastScan.projects];
  const dropped = new Set(scope.dropped || []);
  let sessionsChanged = Boolean(scope.sessions) || dropped.size > 0;

  for (const id of dropped) {
    const at = projects.findIndex((p) => p.id === id);
    if (at !== -1) projects.splice(at, 1);
  }

  // Re-read the named projects against the session ids we believe in now. The
  // set is corrected below once every re-read has reported what it found.
  let known = new Set(lastScan.sessionIds);
  let live = lastScan.live;
  for (const id of scope.projects || []) {
    if (dropped.has(id)) continue;
    const at = projects.findIndex((p) => p.id === id);
    const result = await rescanProject(id, known);
    if (!result) {
      if (at !== -1) projects.splice(at, 1);
      sessionsChanged = true;
      continue;
    }
    const before = at === -1 ? [] : projects[at].sessions.map((x) => x.id);
    if (at === -1) projects.push(result.project);
    else projects[at] = result.project;
    if (before.length !== result.sessionIds.length || before.some((x) => !result.sessionIds.includes(x))) {
      sessionsChanged = true;
    }
    live = result.live;
  }

  sortProjects(projects);
  const sessionIds = projects.flatMap((p) => p.sessions.map((s) => s.id));
  known = new Set(sessionIds);

  // `stale-origin` is the one diagnosis that spans projects, so a change to the
  // session set has to be reflected everywhere -- but only that one kind, and
  // only from data already loaded.
  if (sessionsChanged) {
    for (const p of projects) {
      p.memory = {
        ...p.memory,
        issues: p.memory.issues
          .filter((i) => i.kind !== 'stale-origin')
          .concat(staleOriginIssues(p.memory.files, known)),
      };
    }
  }

  const liveIds = new Set((live || []).filter((l) => l.alive).map((l) => l.sessionId));
  const cruft = scope.cruft ? await scanCruft(known, liveIds) : lastScan.cruft;
  const scratchpads = scope.scratch ? await scanScratchpads(known, liveIds) : lastScan.scratchpads;
  const trash = await trashSize(); // manifest arithmetic, not a walk

  const scan = { ...lastScan, generatedAt: new Date().toISOString(), projects, sessionIds, live };
  lastScan = {
    ...scan,
    cruft,
    scratchpads,
    totals: computeTotals(scan, cruft, scratchpads, trash),
  };
  return lastScan;
}

/** Which parts of the index a set of touched paths invalidates. */
export function scopeForPaths(paths) {
  const scope = { projects: new Set(), cruft: false, scratch: false };
  for (const p of paths.filter(Boolean)) {
    const full = path.resolve(p);
    if (isInsideScratchRoot(full)) {
      scope.scratch = true;
      continue;
    }
    const rel = path.relative(PROJECTS_DIR, full);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      scope.projects.add(rel.split(path.sep)[0]);
      continue;
    }
    if (isInsideClaudeRoot(full)) scope.cruft = true;
  }
  return { projects: [...scope.projects], cruft: scope.cruft, scratch: scope.scratch };
}


/** The index as it stands, or null before the first scan. */
export function getIndex() {
  return lastScan;
}

/** The index, scanning first if this is the first call. */
export async function ensureIndex() {
  return lastScan || fullScan();
}
