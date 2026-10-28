// Link containment and delete-time liveness, in a temp sandbox.
//
// The managed-root guards compare path strings; this checks that a directory
// link planted inside a managed root cannot carry a move, write, restore or
// purge outside it, and that a session attached to a process after the last
// scan is still refused. The IPC handlers are driven directly, with `electron`
// replaced by a stub, so the checks run on a plain Node runner.
//
// Run with:  node scripts/t-guard.mjs
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { register } from 'node:module';
import { execFileSync } from 'node:child_process';

const base = await fs.mkdtemp(path.join(os.tmpdir(), 'cm-guard-'));
const root = path.join(base, 'claude');
const scratch = path.join(base, 'scratch');
const outside = path.join(base, 'outside');
process.env.CLAUDE_CONFIG_DIR = root;
process.env.CLAUDE_SCRATCH_DIR = scratch;

// Stand-in for the electron module: ipc.js only registers handlers at import.
globalThis.__handlers = {};
const stub = `
  export const ipcMain = { handle: (ch, fn) => { globalThis.__handlers[ch] = fn; } };
  export const shell = { showItemInFolder() {}, openPath: async () => '' };
  export const dialog = { showMessageBox: async () => ({ response: 1 }) };
  export const clipboard = { writeText() {} };
`;
register('data:text/javascript,' + encodeURIComponent(`
  export async function resolve(spec, ctx, next) {
    if (spec === 'electron') return { url: 'data:text/javascript,' + ${JSON.stringify(encodeURIComponent(stub))}, shortCircuit: true };
    return next(spec, ctx);
  }
`));

const trash = await import('../src/main/trash.js');
const { TRASH_DIR } = await import('../src/main/paths.js');
const { writeMemory } = await import('../src/main/memories.js');
const { registerIpc } = await import('../src/main/ipc.js');
registerIpc();
const ipc = (ch, payload) => globalThis.__handlers[ch]({}, payload);

let failures = 0;
const ok = (label, cond) => {
  if (!cond) failures += 1;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
};
const there = (p) => fs.lstat(p).then(() => true, () => false);
const throws = async (fn, re) => {
  try {
    await fn();
    return false;
  } catch (err) {
    return re.test(err.message);
  }
};
// Directory links: a junction on Windows (no privilege needed), a symlink elsewhere.
const linkDir = (target, at) => fs.symlink(target, at, 'junction');

async function resetOutside() {
  await fs.rm(outside, { recursive: true, force: true });
  await fs.mkdir(path.join(outside, 'Documents'), { recursive: true });
  await fs.writeFile(path.join(outside, 'Documents', 'keep.txt'), 'irreplaceable');
  await fs.writeFile(path.join(outside, 'profile'), 'original');
}

await fs.mkdir(root, { recursive: true });
await fs.mkdir(scratch, { recursive: true });
console.log('sandbox:', base, '\n');

// ---- the trash directory itself is a link ----------------------------------
await resetOutside();
await linkDir(outside, TRASH_DIR);
await fs.mkdir(path.join(root, 'debug'), { recursive: true });
await fs.writeFile(path.join(root, 'debug', 'old.log'), 'x');
ok('a delete refuses a trash directory that is a link',
  await throws(() => trash.trashItem({ kind: 'cruft', label: 'x', paths: [path.join(root, 'debug', 'old.log')] }), /not a plain directory/));
ok('  and moved nothing', await there(path.join(root, 'debug', 'old.log')));
ok('Empty trash refuses it too', await throws(() => trash.purgeAll(), /not a plain directory/));
ok('  and the link target is untouched', await there(path.join(outside, 'Documents', 'keep.txt')));
ok('the trash lists nothing read through the link', (await trash.listTrash()).length === 0);
await fs.rm(TRASH_DIR, { force: true });

// ---- a planted entry restores through a linked directory -------------------
await resetOutside();
await fs.rm(path.join(outside, 'profile'));
const id = 'mabc123-0123abcd';
const to = path.join(TRASH_DIR, id, '0', 'profile');
await fs.mkdir(path.dirname(to), { recursive: true });
await fs.writeFile(to, 'planted');
await fs.mkdir(path.join(root, 'projects'), { recursive: true });
await linkDir(outside, path.join(root, 'projects', 'linked'));
await fs.writeFile(path.join(TRASH_DIR, 'manifest.json'), JSON.stringify({ version: 1, entries: [{
  id, kind: 'memory', label: 'notes.md', deletedAt: new Date().toISOString(), bytes: 7,
  paths: [{ from: path.join(root, 'projects', 'linked', 'profile'), to, isDir: false, bytes: 7 }],
}] }));
ok('the planted entry is listed (its strings pass)', (await trash.listTrash()).some((e) => e.id === id));
ok('restore refuses a destination reached through a link', await throws(() => trash.restoreEntry(id), /link that leads outside/));
ok('  and wrote nothing outside', !(await there(path.join(outside, 'profile'))));
ok('  and the entry is still recoverable', await there(to));
await fs.rm(TRASH_DIR, { recursive: true, force: true });

// ---- deletes through a linked ancillary or scratchpad directory ------------
await resetOutside();
await linkDir(outside, path.join(root, 'cache'));
ok('a delete through a linked ~/.claude directory is refused',
  await throws(() => trash.trashItem({ kind: 'cruft', label: 'x', paths: [path.join(root, 'cache', 'Documents')] }), /link that leads outside/));
await linkDir(outside, path.join(scratch, 'proj'));
ok('a delete through a linked scratchpad directory is refused',
  await throws(() => trash.trashItem({ kind: 'cruft', label: 'x', paths: [path.join(scratch, 'proj', 'Documents')] }), /link that leads outside/));
ok('  and the link target is untouched', await there(path.join(outside, 'Documents', 'keep.txt')));

// Negative control: a link that stays inside the root, and a link as the item
// itself, are ordinary and still go to the trash.
await fs.mkdir(path.join(root, 'backups', 'real'), { recursive: true });
await fs.writeFile(path.join(root, 'backups', 'real', 'b.txt'), 'b');
await linkDir(path.join(root, 'backups'), path.join(root, 'backups-alias'));
const inner = await trash.trashItem({ kind: 'cruft', label: 'x', paths: [path.join(root, 'backups-alias', 'real')] });
ok('a link that stays inside the root is still allowed', Boolean(inner));
const self = await trash.trashItem({ kind: 'cruft', label: 'x', paths: [path.join(root, 'cache')] });
ok('a link as the item itself moves (the link, not its target)', Boolean(self) && (await there(path.join(outside, 'Documents', 'keep.txt'))));
const restoredSelf = await trash.restoreEntry(self.id);
ok('  and restores as a link', restoredSelf.restored.length === 1 && (await fs.lstat(path.join(root, 'cache'))).isSymbolicLink());
await fs.rm(path.join(root, 'cache'), { force: true });
await fs.rm(path.join(scratch, 'proj'), { force: true });

// ---- a scratchpad root that is a link -------------------------------------
const realScratch = scratch + '-real';
await fs.rename(scratch, realScratch);
await linkDir(realScratch, scratch);
await fs.mkdir(path.join(realScratch, 'p', 'aaaaaaaa-0000-0000-0000-000000000000'), { recursive: true });
ok('a scratchpad root that is a link is refused',
  await throws(() => trash.trashItem({ kind: 'cruft', label: 'x', paths: [path.join(scratch, 'p', 'aaaaaaaa-0000-0000-0000-000000000000')] }), /is a link/));
await fs.rm(scratch, { force: true });
await fs.rename(realScratch, scratch);

// ---- memory writes --------------------------------------------------------
await resetOutside();
const memDir = path.join(root, 'projects', 'X--mem', 'memory');
await fs.mkdir(memDir, { recursive: true });
await fs.writeFile(path.join(memDir, 'plain.md'), 'a');
await writeMemory(path.join(memDir, 'plain.md'), 'b');
ok('an ordinary memory still saves', (await fs.readFile(path.join(memDir, 'plain.md'), 'utf8')) === 'b');
ok('the editor will not write outside a memory directory',
  await throws(() => writeMemory(path.join(root, 'settings.json'), '{}'), /not a memory/));
ok('  nor a non-markdown file inside one',
  await throws(() => writeMemory(path.join(memDir, 'x.json'), '{}'), /not a memory/));
let fileLinks = true;
try {
  await fs.symlink(path.join(outside, 'profile'), path.join(memDir, 'linked.md'), 'file');
} catch (err) {
  fileLinks = false; // Windows without symlink privilege: junctions only
  console.log(`SKIP  memory file that is a link (${err.code})`);
}
if (fileLinks) {
  ok('a memory file that is a link is not written through', await throws(() => writeMemory(path.join(memDir, 'linked.md'), 'x'), /through a link/));
  ok('  and its target is untouched', (await fs.readFile(path.join(outside, 'profile'), 'utf8')) === 'original');
}

// ---- liveness is read when the delete happens -----------------------------
const sid = 'bbbbbbbb-1111-2222-3333-444444444444';
const projDir = path.join(root, 'projects', 'X--live');
await fs.mkdir(projDir, { recursive: true });
const old = new Date(Date.now() - 400 * 86_400_000).toISOString();
await fs.writeFile(path.join(projDir, sid + '.jsonl'),
  JSON.stringify({ type: 'user', sessionId: sid, cwd: base, timestamp: old, message: { role: 'user', content: 'hi' } }) + '\n');
await fs.mkdir(path.join(root, 'file-history', sid), { recursive: true });
await fs.writeFile(path.join(root, 'file-history', sid, 'f@v1'), 'v1');
const oldDate = new Date(old);
await fs.utimes(path.join(root, 'file-history', sid), oldDate, oldDate);

await ipc('scan', { force: true });
// The session is resumed after the window scanned.
const reg = path.join(root, 'sessions', `${process.pid}.json`);
await fs.mkdir(path.dirname(reg), { recursive: true });
await fs.writeFile(reg, JSON.stringify({ sessionId: sid, pid: process.pid }));
const index = await ipc('scan', {});
ok('the cached index still believes the session is idle',
  index.projects.flatMap((p) => p.sessions).some((s) => s.id === sid && !s.live));

const del = await ipc('delete:sessions', { ids: [sid] });
ok('deleting it is refused anyway', del[0] && !del[0].ok && /running Claude Code process/.test(del[0].error));
const swept = await ipc('sweep:run', { days: 30, categories: ['sessions', 'cruft'] });
ok('a sweep refuses both it and its file history', swept.moved === 0 && swept.failed === 2);
const byPath = await ipc('delete:paths', { items: [{ id: 'fh', paths: [path.join(root, 'file-history', sid)] }] });
ok('a cleanup delete of its file history is refused', byPath[0] && !byPath[0].ok);
const proj = (await ipc('scan', {})).projects.find((p) => p.sessions.some((s) => s.id === sid));
ok('deleting its project is refused', await throws(() => ipc('delete:project', { projectId: proj.id }), /still running/));
ok('  and the transcript is where it was', await there(path.join(projDir, sid + '.jsonl')));

// Negative control: once the process is gone the same delete goes through.
await fs.rm(reg);
const after = await ipc('delete:sessions', { ids: [sid] });
ok('with the process gone the delete goes through', after[0]?.ok === true && !(await there(path.join(projDir, sid + '.jsonl'))));

// ---- the scratchpad root is the one Claude Code writes ---------------------
// Claude Code builds it as <base>/<name>: <base> is CLAUDE_CODE_TMPDIR when set,
// else /tmp on macOS and the OS temp directory elsewhere; <name> is claude on
// Windows and claude-<uid> on Linux and macOS. Each platform is read as a fresh
// process sees it, with process.platform set before paths.js loads, so the
// Windows and macOS rules are checked on every runner. The host's own temp
// directory is pointed at a sandbox folder, so a check that passes cannot be
// passing because the default and the expected value happen to coincide.
const pathsUrl = new URL('../src/main/paths.js', import.meta.url).href;
const rootWith = (env, platform = process.platform) => execFileSync(process.execPath, ['--input-type=module', '-e',
  `Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)} });
   import(${JSON.stringify(pathsUrl)}).then((m) => process.stdout.write(m.SCRATCH_ROOT))`],
  { env: { ...process.env, CLAUDE_SCRATCH_DIR: '', CLAUDE_CODE_TMPDIR: '', ...env }, encoding: 'utf8' });
const tmpBase = path.join(base, 'tmp');
const ccBase = path.join(base, 'cc');
await fs.mkdir(tmpBase, { recursive: true });
// os.tmpdir() reads TEMP and TMP or TMPDIR by the platform it believes it is on.
const tmpEnv = { TEMP: tmpBase, TMP: tmpBase, TMPDIR: tmpBase };
const ccEnv = { ...tmpEnv, CLAUDE_CODE_TMPDIR: ccBase };
const uidName = `claude-${process.getuid?.() ?? 0}`;

ok(`on Linux the scratchpad root is ${uidName} in the temp directory`, rootWith(tmpEnv, 'linux') === path.join(tmpBase, uidName));
ok('  and follows CLAUDE_CODE_TMPDIR', rootWith(ccEnv, 'linux') === path.join(ccBase, uidName));
ok(`on macOS it is ${uidName} in /tmp, not in the per-user temp directory`,
  rootWith(tmpEnv, 'darwin') === path.join('/tmp', uidName));
ok('  and follows CLAUDE_CODE_TMPDIR', rootWith(ccEnv, 'darwin') === path.join(ccBase, uidName));
ok('on Windows it is claude in the temp directory', rootWith(tmpEnv, 'win32') === path.join(tmpBase, 'claude'));
ok('  and follows CLAUDE_CODE_TMPDIR', rootWith(ccEnv, 'win32') === path.join(ccBase, 'claude'));
ok('  and is never named after a uid, claude-0 included', !/claude-\d+$/.test(rootWith(tmpEnv, 'win32')));
ok('CLAUDE_SCRATCH_DIR still overrides it', rootWith({ ...ccEnv, CLAUDE_SCRATCH_DIR: scratch }) === path.resolve(scratch));

await fs.rm(base, { recursive: true, force: true });
console.log(failures ? `\n${failures} check${failures === 1 ? '' : 's'} failed` : '\nsandbox cleaned up, all checks passed');
process.exit(failures ? 1 : 0);
