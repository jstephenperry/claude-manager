// Trash round-trip against a synthetic CLAUDE_CONFIG_DIR, so the real
// ~/.claude is never touched. Run with:  node scripts/t-trash.mjs
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const sandbox = path.join(os.tmpdir(), 'cm-test-' + Date.now());
process.env.CLAUDE_CONFIG_DIR = sandbox;

const { trashItem, listTrash, restoreEntry, purgeEntry, purgeAll, trashSize } = await import('../src/main/trash.js');
const { isInsideClaudeRoot, CLAUDE_ROOT } = await import('../src/main/paths.js');

const ok = (label, cond) => console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);

console.log('sandbox:', CLAUDE_ROOT, '\n');

// Build a fake session: transcript + sidecar dir + file-history entry.
const proj = path.join(sandbox, 'projects', 'X--test');
const sid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
await fs.mkdir(path.join(proj, sid, 'tool-results'), { recursive: true });
await fs.mkdir(path.join(sandbox, 'file-history', sid), { recursive: true });
await fs.writeFile(path.join(proj, sid + '.jsonl'), '{"type":"user"}\n');
await fs.writeFile(path.join(proj, sid, 'tool-results', 'a.txt'), 'x'.repeat(500));
await fs.writeFile(path.join(sandbox, 'file-history', sid, 'f@v1'), 'y'.repeat(300));

const paths = [
  path.join(proj, sid + '.jsonl'),
  path.join(proj, sid),
  path.join(sandbox, 'file-history', sid),
];

// --- delete ---
const entry = await trashItem({ kind: 'session', label: 'test session', paths, context: { sessionId: sid } });
ok('entry created', Boolean(entry));
ok('all three paths moved', entry.paths.length === 3);
ok('bytes accounted', entry.bytes >= 800);
for (const p of paths) {
  ok(`  original gone: ${path.basename(p)}`, !(await stat(p)));
}

const listed = await listTrash();
ok('appears in trash listing', listed.length === 1 && listed[0].id === entry.id);
ok('no restore conflicts', listed[0].conflicts.length === 0);

// --- restore ---
const r = await restoreEntry(entry.id);
ok('restore reported 3 paths', r.restored.length === 3 && r.skipped.length === 0);
for (const p of paths) {
  ok(`  restored: ${path.basename(p)}`, Boolean(await stat(p)));
}
ok('file content intact', (await fs.readFile(path.join(proj, sid, 'tool-results', 'a.txt'), 'utf8')).length === 500);
ok('trash now empty', (await listTrash()).length === 0);

// --- conflict handling: recreate a path, then restore ---
await trashItem({ kind: 'session', label: 'again', paths, context: {} });
await fs.writeFile(path.join(proj, sid + '.jsonl'), 'NEW CONTENT\n');
const listed2 = await listTrash();
ok('conflict detected before restore', listed2[0].conflicts.length === 1);
const r2 = await restoreEntry(listed2[0].id);
ok('conflicting path skipped, others restored', r2.skipped.length === 1 && r2.restored.length === 2);
ok('newer file not clobbered', (await fs.readFile(path.join(proj, sid + '.jsonl'), 'utf8')).startsWith('NEW'));
ok('entry survives for the un-restored remainder', (await listTrash()).length === 1);

// --- purge ---
const remaining = await listTrash();
await purgeEntry(remaining[0].id);
ok('purged entry gone', (await listTrash()).length === 0);

// --- safety guard ---
let threw = false;
try {
  await trashItem({ kind: 'x', label: 'outside', paths: [path.join(os.homedir(), 'Documents')] });
} catch {
  threw = true;
}
ok('refuses paths outside the Claude root', threw);
ok('guard rejects an outside path', !isInsideClaudeRoot(path.join(os.homedir(), 'Documents')));
ok('guard accepts an inside path', isInsideClaudeRoot(path.join(sandbox, 'projects')));

await purgeAll();
const size = await trashSize();
ok('purgeAll leaves nothing', size.count === 0);

await fs.rm(sandbox, { recursive: true, force: true });
console.log('\nsandbox cleaned up');

async function stat(p) {
  try { return await fs.stat(p); } catch { return null; }
}
