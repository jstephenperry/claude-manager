import { readTranscript } from '../src/main/transcript.js';
import { scanCruft } from '../src/main/cruft.js';
import { scanProjects } from '../src/main/scanner.js';
import { formatBytes } from '../src/main/util.js';

const scan = await scanProjects();
const known = new Set(scan.sessionIds);
const liveIds = new Set(scan.live.filter((l) => l.alive).map((l) => l.sessionId));

// --- transcript on the largest session ---
const biggest = scan.projects.flatMap((p) => p.sessions).sort((a, b) => b.bytes - a.bytes)[0];
console.log(`transcript: ${biggest.title} (${formatBytes(biggest.bytes)})`);
const t0 = Date.now();
const entries = await readTranscript(biggest.jsonlPath, { includeThinking: true });
console.log(`  parsed ${entries.length} entries in ${Date.now() - t0}ms`);

const roles = {};
const blockTypes = {};
let truncated = 0;
for (const e of entries) {
  roles[e.role] = (roles[e.role] || 0) + 1;
  for (const b of e.blocks) {
    blockTypes[b.type] = (blockTypes[b.type] || 0) + 1;
    if (b.truncated) truncated++;
  }
}
console.log('  roles:', roles);
console.log('  blocks:', blockTypes);
console.log('  truncated blocks:', truncated);

const payload = JSON.stringify(entries).length;
console.log(`  IPC payload: ${formatBytes(payload)} (source ${formatBytes(biggest.bytes)})`);

const sampleTool = entries.flatMap((e) => e.blocks).find((b) => b.type === 'tool_use');
console.log(`  sample tool_use: ${sampleTool?.name} -> "${(sampleTool?.summary || '').slice(0, 70)}"`);
const sampleRes = entries.flatMap((e) => e.blocks).find((b) => b.type === 'tool_result' && b.text);
console.log(`  sample tool_result: [${sampleRes?.toolName}] "${(sampleRes?.text || '').slice(0, 60).replace(/\n/g, ' ')}"`);

// --- cruft ---
console.log('\ncruft:');
const cruft = await scanCruft(known, liveIds);
for (const g of cruft.groups) {
  console.log(`  ${g.label}: ${g.items.length} items, ${formatBytes(g.bytes)}, ${g.orphanCount} orphaned (${formatBytes(g.orphanBytes)})`);
  for (const i of g.items.slice(0, 3)) {
    console.log(`      ${i.orphan ? '[ORPHAN]' : '        '} ${i.name.slice(0, 46).padEnd(46)} ${formatBytes(i.bytes).padStart(8)}  ${i.note}`);
  }
}
console.log(`  TOTAL ${formatBytes(cruft.totalBytes)} · reclaimable ${formatBytes(cruft.reclaimableBytes)}`);
