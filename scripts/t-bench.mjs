// What a scan costs, and proof that the cheap one tells the same truth as the
// expensive one. Run with:
//   node scripts/t-bench.mjs [claude-config-dir]
//
// Two halves:
//
// 1. Timing, read-only, against whatever tree you point it at (your real
//    ~/.claude by default). Nothing is written; the scan cache is left alone.
// 2. Correctness, against a synthetic tree in the OS temp directory. A scoped
//    `refresh` has to leave the index identical to what a `fullScan` would
//    have produced -- a partial invalidation that quietly drifts from the
//    truth is worse than a slow one, so this is the check that matters.
//
// The roots in paths.js are read once at import, so the second half runs in a
// child process pointed at the sandbox rather than re-pointing this one.

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ms = (t) => Number(process.hrtime.bigint() - t) / 1e6;
const now = () => process.hrtime.bigint();
const row = (label, value, unit = 'ms') => console.log(`  ${label.padEnd(24)} ${String(value).padStart(7)} ${unit}`);

let failures = 0;
const ok = (label, cond, extra = '') => {
  if (!cond) failures += 1;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
};

if (!process.argv.includes('--verify')) {
  await timings(process.argv[2] || path.join(os.homedir(), '.claude'));
  // The correctness half needs its own roots, so it gets its own process.
  const sandbox = path.join(os.tmpdir(), 'cm-bench-' + Date.now());
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--verify'], {
    stdio: 'inherit',
    env: { ...process.env, CLAUDE_CONFIG_DIR: sandbox, CLAUDE_SCRATCH_DIR: sandbox + '-scratch' },
  });
  process.exit(child.status ?? 1);
}

// ---- 1. timing ------------------------------------------------------------

async function timings(target) {
  process.env.CLAUDE_CONFIG_DIR = target;
  const { scanProjects, rescanProject } = await import('../src/main/scanner.js');
  const { scanCruft } = await import('../src/main/cruft.js');
  const { scanScratchpads } = await import('../src/main/scratchpads.js');
  const { trashSize } = await import('../src/main/trash.js');

  console.log(`tree: ${target}\n`);

  const timeFullScan = async () => {
    const t0 = now();
    const scan = await scanProjects();
    const projectsMs = ms(t0);

    const known = new Set(scan.sessionIds);
    const live = new Set(scan.live.filter((l) => l.alive).map((l) => l.sessionId));
    const t1 = now();
    await scanCruft(known, live);
    const cruftMs = ms(t1);
    const t2 = now();
    await scanScratchpads(known, live);
    const scratchMs = ms(t2);
    const t3 = now();
    await trashSize();
    const trashMs = ms(t3);

    return { scan, projectsMs, cruftMs, scratchMs, trashMs, total: projectsMs + cruftMs + scratchMs + trashMs };
  };

  const report = (title, r) => {
    console.log(title);
    row('scanProjects', r.projectsMs.toFixed(0));
    row('scanCruft', r.cruftMs.toFixed(0));
    row('scanScratchpads', r.scratchMs.toFixed(0));
    row('trashSize', r.trashMs.toFixed(0));
    row('TOTAL', r.total.toFixed(0));
  };

  const cold = await timeFullScan();
  if (!cold.scan.projects.length) {
    console.log('No projects under this tree, so there is nothing to time.');
    console.log('Point the script at a populated ~/.claude to see the numbers.\n');
    return;
  }
  report('full scan, cold (transcripts parsed):', cold);

  // Warm is the number that matters: every refresh after a change hits the
  // (size, mtime) transcript cache, so this is what a delete used to pay.
  let warm = await timeFullScan();
  for (let i = 0; i < 2; i += 1) {
    const again = await timeFullScan();
    if (again.total < warm.total) warm = again;
  }
  report('\nfull scan, warm (cache hit -- what a change used to cost):', warm);

  const known = new Set(warm.scan.sessionIds);
  const biggest = [...warm.scan.projects].sort((a, b) => b.totalBytes - a.totalBytes)[0];
  const t = now();
  await rescanProject(biggest.id, known);
  const scoped = ms(t);

  console.log('\nscoped refresh of one project (what a change costs now):');
  row('rescanProject', scoped.toFixed(1));
  row('speed-up', (warm.total / Math.max(scoped, 0.01)).toFixed(0) + '×', '');
  console.log(
    `\n  ${warm.scan.projects.length} projects / ${warm.scan.sessionIds.length} sessions; ` +
    `largest project ${(biggest.totalBytes / 1e6).toFixed(1)} MB\n`
  );
}

// ---- 2. correctness (child process; roots point at the sandbox) -----------

const sandbox = process.env.CLAUDE_CONFIG_DIR;
const scratchbox = process.env.CLAUDE_SCRATCH_DIR;

const { fullScan, refresh, scopeForPaths } = await import('../src/main/indexer.js');
const { trashItem, purgeEntry, listTrash } = await import('../src/main/trash.js');

const uuid = () => crypto.randomUUID();
const sessions = [];

for (let p = 0; p < 3; p += 1) {
  const dir = path.join(sandbox, 'projects', `D--Development-p${p}`);
  const mem = path.join(dir, 'memory');
  await fs.mkdir(mem, { recursive: true });

  const index = ['# Project memory', ''];
  for (let m = 0; m < 3; m += 1) {
    await fs.writeFile(path.join(mem, `note-${m}.md`),
      `---\nname: note-${m}\ndescription: d\nmetadata:\n  type: project\n  originSessionId: ${uuid()}\n---\n\nBody.\n`, 'utf8');
    index.push(`- [Note ${m}](note-${m}.md)`);
  }
  index.push('- [Gone](gone.md)');
  await fs.writeFile(path.join(mem, 'MEMORY.md'), index.join('\n') + '\n', 'utf8');

  for (let s = 0; s < 3; s += 1) {
    const id = uuid();
    sessions.push({ id, dir, project: `D--Development-p${p}` });
    await fs.writeFile(path.join(dir, `${id}.jsonl`),
      JSON.stringify({ type: 'user', sessionId: id, cwd: `/dev/p${p}`, timestamp: new Date().toISOString(), message: { role: 'user', content: 'hi' } }) + '\n', 'utf8');
    for (const sat of ['file-history', 'session-env']) {
      await fs.mkdir(path.join(sandbox, sat, id), { recursive: true });
      await fs.writeFile(path.join(sandbox, sat, id, 'entry'), 'x'.repeat(200), 'utf8');
    }
  }
}

// A memory in p1 whose origin session lives in p0: deleting that session has to
// change this memory's issues, even when the refresh is scoped to p0.
const crossOrigin = sessions[0];
await fs.writeFile(path.join(sandbox, 'projects', 'D--Development-p1', 'memory', 'note-0.md'),
  `---\nname: note-0\ndescription: d\nmetadata:\n  type: project\n  originSessionId: ${crossOrigin.id}\n---\n\nBody.\n`, 'utf8');

await fs.mkdir(path.join(scratchbox, 'p0', uuid(), 'scratchpad'), { recursive: true });

/** Everything the UI reads, minus the timestamp that differs by definition. */
const shape = (index) => JSON.stringify({
  totals: index.totals,
  sessionIds: [...index.sessionIds].sort(),
  cruft: { bytes: index.cruft.totalBytes, reclaimable: index.cruft.reclaimableBytes },
  scratch: { bytes: index.scratchpads.totalBytes, sessions: index.scratchpads.sessionCount },
  projects: [...index.projects]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((p) => ({
      id: p.id, bytes: p.totalBytes, sessions: p.sessions.map((s) => s.id).sort(),
      memory: {
        count: p.memory.count, bytes: p.memory.bytes,
        issues: p.memory.issues.map((i) => `${i.kind}:${i.file || i.indexFile || ''}`).sort(),
      },
    })),
}, null, 1);

const staleIn = (index, id) =>
  index.projects.find((p) => p.id === id)?.memory.issues.filter((i) => i.kind === 'stale-origin').length ?? -1;

/**
 * Run a mutation, refresh only the scope it declares, and demand the index a
 * full scan would have produced. Returns the scoped index for further checks.
 */
async function sameAsFullScan(label, mutate, scope) {
  await fullScan();
  const extra = await mutate();
  const index = await refresh(typeof scope === 'function' ? scope(extra) : scope);
  const scoped = shape(index);
  const full = shape(await fullScan());
  if (scoped === full) {
    ok(label, true);
  } else {
    const a = scoped.split('\n');
    const b = full.split('\n');
    const at = a.findIndex((line, i) => line !== b[i]);
    ok(label, false, `first difference at line ${at}:\n    scoped: ${a[at]}\n    full:   ${b[at]}`);
  }
  return index;
}

console.log('scoped refresh vs full scan, after each kind of change:');

await sameAsFullScan('deleting a memory', async () => {
  const file = path.join(sandbox, 'projects', 'D--Development-p0', 'memory', 'note-1.md');
  await trashItem({ kind: 'memory', label: 'note-1.md', paths: [file] });
  return [file];
}, (paths) => scopeForPaths(paths));

await sameAsFullScan('repairing MEMORY.md', async () => {
  const dir = path.join(sandbox, 'projects', 'D--Development-p0', 'memory');
  const file = path.join(dir, 'MEMORY.md');
  const text = await fs.readFile(file, 'utf8');
  await fs.writeFile(file, text.replace('- [Gone](gone.md)\n', ''), 'utf8');
  return [dir];
}, (paths) => scopeForPaths(paths));

// The cross-project case: the refresh is scoped to p0, but the memory whose
// issues change lives in p1.
const staleBefore = staleIn(await fullScan(), 'D--Development-p1');
const afterSessionDelete = await sameAsFullScan('deleting a session and its satellites', async () => {
  const paths = [
    path.join(crossOrigin.dir, `${crossOrigin.id}.jsonl`),
    path.join(sandbox, 'file-history', crossOrigin.id),
    path.join(sandbox, 'session-env', crossOrigin.id),
  ];
  await trashItem({ kind: 'session', label: 'a session', paths });
  return paths;
}, (paths) => ({ ...scopeForPaths(paths), sessions: true }));

ok('  stale-origin re-derived in the project that was not rescanned',
  staleIn(afterSessionDelete, 'D--Development-p1') === staleBefore + 1,
  `${staleBefore} -> ${staleIn(afterSessionDelete, 'D--Development-p1')}`);

await sameAsFullScan('deleting a whole project', async () => {
  const dir = path.join(sandbox, 'projects', 'D--Development-p2');
  await trashItem({ kind: 'project', label: 'p2', paths: [dir] });
  return 'D--Development-p2';
}, (id) => ({ dropped: [id], sessions: true, cruft: true }));

await sameAsFullScan('purging a trash entry', async () => {
  const entries = await listTrash();
  await purgeEntry(entries[0].id);
}, {});

await fs.rm(sandbox, { recursive: true, force: true });
await fs.rm(scratchbox, { recursive: true, force: true });

console.log(`\n${failures ? `${failures} FAILURE(S)` : 'all checks passed'}`);
process.exit(failures ? 1 : 0);
