import { scanProjects } from '../src/main/scanner.js';
import { formatBytes } from '../src/main/util.js';

const t0 = Date.now();
const r = await scanProjects();
console.log(`scanned in ${Date.now() - t0}ms — ${r.projects.length} projects`);
console.log('live sessions:', r.live.filter((l) => l.alive).map((l) => `${l.sessionId.slice(0, 8)} pid=${l.pid} ${l.status}`));
console.log('');

for (const p of r.projects) {
  console.log(`${p.id}`);
  console.log(`   path: ${p.realPath}${p.pathInferred ? '  (INFERRED)' : ''}  exists=${p.cwdExists}`);
  console.log(`   ${p.sessionCount} sessions · ${formatBytes(p.totalBytes)} · memories=${p.memory.count} issues=${p.memory.issues.length} · orphanSidecars=${p.orphanSidecars.length}`);
  for (const s of p.sessions.slice(0, 3)) {
    const models = Object.keys(s.models).join(',');
    console.log(`     - ${s.id.slice(0, 8)} ${s.live ? '[LIVE] ' : ''}"${(s.title || s.firstPrompt || '(untitled)').slice(0, 55)}"`);
    console.log(`         ${s.counts.user}u/${s.counts.assistant}a · ${s.counts.toolUse} tools · ${formatBytes(s.totalBytes)} · ${models} · sat=${s.satellites.length} · subagents=${s.subagentCount}`);
    console.log(`         tokens in=${s.tokens.input} out=${s.tokens.output} cacheR=${s.tokens.cacheRead}`);
  }
  if (p.memory.issues.length) {
    console.log(`   memory issues: ${p.memory.issues.map((i) => i.kind).join(', ')}`);
  }
  console.log('');
}
