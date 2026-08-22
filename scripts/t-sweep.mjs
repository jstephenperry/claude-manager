import { scanProjects } from '../src/main/scanner.js';
import { scanCruft } from '../src/main/cruft.js';
import { scanScratchpads } from '../src/main/scratchpads.js';
import { planSweep } from '../src/main/sweep.js';
import { listTrash } from '../src/main/trash.js';
import { formatBytes } from '../src/main/util.js';
import { isManagedPath, SCRATCH_ROOT, CLAUDE_ROOT } from '../src/main/paths.js';
import os from 'node:os';
import path from 'node:path';

const scan = await scanProjects();
const known = new Set(scan.sessionIds);
const live = new Set(scan.live.filter((l) => l.alive).map((l) => l.sessionId));

const cruft = await scanCruft(known, live);
const scratchpads = await scanScratchpads(known, live);
const trash = await listTrash();

console.log('=== scratchpads ===');
console.log(`root: ${scratchpads.root}`);
console.log(`${scratchpads.sessionCount} session dirs · ${formatBytes(scratchpads.totalBytes)} · ${scratchpads.emptyCount} empty · ${scratchpads.orphanCount} orphaned (${formatBytes(scratchpads.orphanBytes)})`);
for (const p of scratchpads.projects.slice(0, 6)) {
  console.log(`  ${p.id.slice(0, 44).padEnd(44)} ${formatBytes(p.bytes).padStart(9)}  ${p.sessions.length} sess (${p.emptyCount} empty, ${p.orphanCount} orphan)`);
  for (const s of p.sessions.filter((x) => !x.empty).slice(0, 3)) {
    console.log(`      ${(s.sessionId || '(unattached)').slice(0, 8)}  ${formatBytes(s.bytes).padStart(9)}  scratch=${s.scratchFiles}f/${formatBytes(s.scratchBytes)}  tasks=${s.taskFiles}f/${formatBytes(s.taskBytes)}  ${s.live ? 'LIVE' : s.orphan ? 'orphan' : ''}`);
  }
}
console.log(`loose: ${scratchpads.loose.length} — ${scratchpads.loose.slice(0, 4).map((l) => `${l.name.slice(0, 30)} ${formatBytes(l.bytes)}`).join(', ')}`);

console.log('\n=== guard ===');
const cases = [
  [CLAUDE_ROOT + '/projects/x', true],
  [SCRATCH_ROOT + '/proj/sess/scratchpad', true],
  [path.join(os.homedir(), 'Documents'), false],
  [path.join(os.homedir()), false],
  [SCRATCH_ROOT + '/../other', false],
  [process.cwd(), false],
];
for (const [p, want] of cases) {
  const got = isManagedPath(p);
  console.log(`  ${got === want ? 'PASS' : 'FAIL'}  ${got ? 'allow' : 'deny '}  ${p}`);
}

const full = { ...scan, cruft, scratchpads };

console.log('\n=== sweep plans ===');
for (const days of [60, 30, 7]) {
  const plan = planSweep(full, trash, { days });
  console.log(`  >${days}d: ${plan.totalCount} items · ${formatBytes(plan.totalBytes)} · skipped ${plan.skipped.live} live, ${plan.skipped.tooRecent} recent`);
  for (const [k, v] of Object.entries(plan.byCategory)) {
    console.log(`        ${k.padEnd(14)} ${String(v.count).padStart(3)} items  ${formatBytes(v.bytes)}`);
  }
}

const plan60 = planSweep(full, trash, { days: 60 });
console.log('\n  oldest candidates at 60d:');
for (const i of [...plan60.items].sort((a, b) => a.mtime - b.mtime).slice(0, 8)) {
  console.log(`    ${String(i.ageDays).padStart(4)}d  ${formatBytes(i.bytes).padStart(9)}  ${i.category.padEnd(13)} ${i.label.slice(0, 46)}`);
}

// The safety property that matters most.
const liveIds = [...live];
const sweptLive = plan60.items.filter((i) => i.sessionId && liveIds.includes(i.sessionId));
console.log(`\n  PASS  no live session in the plan: ${sweptLive.length === 0} (live: ${liveIds.map((x) => x.slice(0, 8)).join(',') || 'none'})`);
const memIn = planSweep(full, trash, { days: 60 }).items.filter((i) => i.category === 'memories');
console.log(`  PASS  memories excluded by default: ${memIn.length === 0}`);
const memOn = planSweep(full, trash, { days: 60, categories: new Set(['memories']) }).items;
console.log(`  memories when opted in: ${memOn.length} items`);
