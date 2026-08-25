// Memory parsing and health diagnosis, run against whatever memory
// directories exist on this machine. Pass a directory to target a specific one:
//   node scripts/t-mem.mjs [memory-dir]

import path from 'node:path';
import fs from 'node:fs/promises';
import { readMemoryDir } from '../src/main/memories.js';
import { planIndexRepairs } from '../src/main/repair.js';
import { PROJECTS_DIR } from '../src/main/paths.js';

async function discoverMemoryDirs() {
  const out = [];
  let entries = [];
  try {
    entries = await fs.readdir(PROJECTS_DIR, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(PROJECTS_DIR, e.name, 'memory');
    try {
      await fs.stat(dir);
      out.push(dir);
    } catch {
      /* project has no memory directory */
    }
  }
  return out;
}

const targets = process.argv[2] ? [process.argv[2]] : await discoverMemoryDirs();

if (!targets.length) {
  console.log(`No memory directories found under ${PROJECTS_DIR}.`);
  console.log('Claude Code creates them as it records things worth keeping.');
}

for (const dir of targets) {
  const r = await readMemoryDir(dir, new Set());
  console.log(`\n${dir}`);
  console.log(`  exists=${r.exists} bytes=${r.bytes} files=${r.files.length}`);
  for (const f of r.files) {
    console.log(`  - ${f.name} | slug=${f.slug} | type=${f.type} | links=${f.links.join(',') || '-'}`);
    if (f.description) console.log(`      ${f.description}`);
  }
  if (r.index) console.log(`  index: ${r.index.entries.map((e) => e.file).join(', ') || '(no entries)'}`);
  console.log(`  issues: ${r.issues.length ? r.issues.map((i) => `${i.kind}(${i.file || ''})`).join(', ') : '(none)'}`);

  // What the repair pass would propose for the orphaned links. Planning only:
  // nothing here writes to MEMORY.md.
  const plan = planIndexRepairs(r);
  if (plan.actions.length || plan.manual.length) {
    console.log(`  repairs: ${plan.counts.auto} safe, ${plan.counts.total - plan.counts.auto} to review, ${plan.counts.manual} by hand`);
    for (const a of plan.actions) {
      console.log(`    [${a.confidence}] ${a.kind} line ${a.lineNo}: ${a.file}${a.target ? ` -> ${a.target}` : ''}`);
    }
    for (const m of plan.manual) console.log(`    [manual] line ${m.lineNo}: ${m.file}`);
  }
}
