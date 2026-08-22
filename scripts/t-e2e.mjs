// End-to-end through the RUNNING app over CDP: plant a synthetic orphan in the
// real ~/.claude, confirm the app detects it, delete it via the app's own IPC,
// confirm it lands in the trash, restore it, then clean up.
// Requires: npx electron . --remote-debugging-port=9222
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const FAKE_ID = '00000000-dead-beef-0000-000000000000';
const envDir = path.join(os.homedir(), '.claude', 'session-env', FAKE_ID);
const histDir = path.join(os.homedir(), '.claude', 'file-history', FAKE_ID);

const ok = (label, cond) => console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
const exists = async (p) => { try { await fs.stat(p); return true; } catch { return false; } };

// --- connect ---
const targets = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const page = targets.find((t) => t.type === 'page' && t.url.includes('index.html'));
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
await new Promise((r) => (ws.onopen = r));

const evaluate = async (expression) => {
  const myId = ++id;
  const p = new Promise((res) => pending.set(myId, res));
  ws.send(JSON.stringify({ id: myId, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  const r = await p;
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails));
  return r.result?.result?.value;
};

// --- plant the orphan ---
await fs.mkdir(envDir, { recursive: true });
await fs.mkdir(histDir, { recursive: true });
await fs.writeFile(path.join(histDir, 'planted@v1'), 'z'.repeat(1234));
console.log('planted synthetic orphan', FAKE_ID, '\n');

// --- app detects it ---
const found = await evaluate(`
  window.api.scan().then(s => {
    const items = s.cruft.groups.flatMap(g => g.items).filter(i => i.name === '${FAKE_ID}');
    return JSON.stringify(items.map(i => ({ id: i.id, orphan: i.orphan, bytes: i.bytes, note: i.note })));
  })
`);
const items = JSON.parse(found);
ok('app sees both planted entries', items.length === 2);
ok('both flagged as orphans', items.every((i) => i.orphan));
ok('sizes measured', items.some((i) => i.bytes === 1234));
console.log('   ', items.map((i) => `${i.id} ${i.bytes}B`).join('  |  '));

// --- delete through the app's own IPC ---
const delResult = await evaluate(`
  window.api.deletePaths([
    { id: 'env', kind: 'cruft', label: 'planted session-env', paths: [String.raw\`${envDir}\`] },
    { id: 'hist', kind: 'cruft', label: 'planted file-history', paths: [String.raw\`${histDir}\`] }
  ]).then(r => JSON.stringify(r.map(x => ({ id: x.id, ok: x.ok, err: x.error }))))
`);
const dels = JSON.parse(delResult);
ok('both deletes reported ok', dels.every((d) => d.ok));
ok('session-env gone from disk', !(await exists(envDir)));
ok('file-history gone from disk', !(await exists(histDir)));

// --- present in trash ---
const trash = JSON.parse(await evaluate(`window.api.trashList().then(t => JSON.stringify(t.map(e => ({id:e.id,label:e.label,bytes:e.bytes,from:e.paths.map(p=>p.from)}))))`));
const mine = trash.filter((e) => e.label.startsWith('planted'));
ok('both entries in trash', mine.length === 2);
ok('trash records original paths', mine.every((e) => e.from[0].includes(FAKE_ID)));

// --- app no longer lists them as live cruft ---
const afterDelete = JSON.parse(await evaluate(`
  window.api.scan().then(s => JSON.stringify(s.cruft.groups.flatMap(g => g.items).filter(i => i.name === '${FAKE_ID}').length))
`));
ok('scan no longer reports them', afterDelete === 0);

// --- restore both ---
for (const e of mine) {
  const r = JSON.parse(await evaluate(`window.api.trashRestore('${e.id}').then(x => JSON.stringify(x))`));
  ok(`restored ${e.label} (${r.restored.length} path, ${r.skipped.length} skipped)`, r.restored.length === 1 && r.skipped.length === 0);
}
ok('session-env back on disk', await exists(envDir));
ok('file-history back on disk', await exists(histDir));
ok('planted file content intact', (await fs.readFile(path.join(histDir, 'planted@v1'), 'utf8')).length === 1234);

const trashAfter = JSON.parse(await evaluate(`window.api.trashList().then(t => JSON.stringify(t.filter(e => e.label.startsWith('planted')).length))`));
ok('trash entries consumed by restore', trashAfter === 0);

// --- clean up the synthetic data ---
await fs.rm(envDir, { recursive: true, force: true });
await fs.rm(histDir, { recursive: true, force: true });
ok('synthetic orphan removed', !(await exists(envDir)) && !(await exists(histDir)));

await evaluate(`window.api.scan().then(()=>1)`);
console.log('\nreal ~/.claude left exactly as found');
ws.close();
process.exit(0);
