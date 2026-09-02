// MEMORY.md orphaned-link diagnosis and repair, against a synthetic
// CLAUDE_CONFIG_DIR so the real ~/.claude is never touched. Run with:
//   node scripts/t-memfix.mjs
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const sandbox = path.join(os.tmpdir(), 'cm-memfix-' + Date.now());
process.env.CLAUDE_CONFIG_DIR = sandbox;

const { readMemoryDir, parseIndex, splitLines, joinLines } = await import('../src/main/memories.js');
const { planIndexRepairs, applyIndexRepairs } = await import('../src/main/repair.js');

let failures = 0;
const ok = (label, cond) => {
  if (!cond) failures += 1;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
};

const dir = path.join(sandbox, 'projects', 'X--test', 'memory');
await fs.mkdir(dir, { recursive: true });

const memory = (name, slug, body = 'Some content.\n') =>
  fs.writeFile(path.join(dir, name), `---\nname: ${slug}\ndescription: ${slug} notes\nmetadata:\n  type: project\n---\n\n${body}`, 'utf8');

await memory('api-notes.md', 'api-notes');
await memory('deploy.md', 'deploy');
await memory('styles.md', 'styles');
await memory('release checklist.md', 'release-checklist');
await memory('build-quirks-v2.md', 'build-quirks');
await memory('session-log.md', 'session-log');
await memory('api-note.md', 'api-note'); // near-miss neighbour for the fuzzy case

// Every line below is deliberate: the file mixes links that work, links that
// are broken in a repairable way, and links no tool should touch. CRLF
// throughout, because that is what MEMORY.md looks like on Windows.
const INDEX_LINES = [
  '# Project memory',
  '',
  '## Working links',
  '',
  '- [API notes](./api-notes.md) — resolves through a ./ prefix',
  '- [Release](<release checklist.md>) — resolves through angle brackets',
  '- [Release again](release%20checklist.md) — resolves through an escape',
  '- [Styles](styles.md#tokens) — resolves with an anchor',
  '- [Session log](session-log.md) — healthy',
  '- [Docs](https://example.com/docs) — external, not a memory',
  '',
  '## Repairable',
  '',
  '- [Deploy](memory/deploy.md) — stray directory prefix',
  '- [Deploy runbook](deploy "the runbook") — missing extension, keeps its title',
  '- [Build quirks](build-quirks.md#gotchas) — renamed file, keeps its anchor',
  '- [API notez](api-notez.md) — a typo away from a real file',
  '',
  '## Beyond repair',
  '',
  '- [Old thing](old-thing.md) — nothing like it here',
  '- [Trashed note](trashed-note.md) — deleted through this app',
  '| [Table note](gone-table.md) | in a table row |',
  'See [the notes](gone-notes.md) for the details of the thing.',
  '- [A](gone-a.md) and [B](gone-b.md) on one line',
  '',
  '## Not an index line',
  '',
  '```markdown',
  '- [Example](never-written.md)',
  '```',
  '',
];
const indexPath = path.join(dir, 'MEMORY.md');
await fs.writeFile(indexPath, INDEX_LINES.join('\r\n'), 'utf8');

// --- diagnosis -------------------------------------------------------------

const read = await readMemoryDir(dir);
const dangling = read.issues.filter((i) => i.kind === 'dangling-index');
const unindexed = read.issues.filter((i) => i.kind === 'unindexed').map((i) => i.file);

ok('index parsed', Boolean(read.index) && read.index.entries.length === 15);
ok('external URL is not an index entry', !read.index.entries.some((e) => e.file.includes('example.com')));
ok('fenced example is not an index entry', !read.index.entries.some((e) => e.file === 'never-written.md'));
ok('./ prefix is not reported broken', !dangling.some((i) => i.indexFile.includes('api-notes')));
ok('angle-bracket target is not reported broken', !dangling.some((i) => i.indexFile.includes('release')));
ok('percent-escaped target is not reported broken', !dangling.some((i) => i.indexFile.includes('%20')));
ok('anchor-only difference is not reported broken', !dangling.some((i) => i.indexFile === 'styles.md'));
ok('files reached through ./ count as indexed', !unindexed.includes('api-notes.md') && !unindexed.includes('styles.md'));
ok('escaped-name file counts as indexed', !unindexed.includes('release checklist.md'));
ok('10 orphaned links found', dangling.length === 10);
ok('dangling issue carries its line number', dangling.every((i) => i.line > 0));
ok('dangling issue points at MEMORY.md', dangling.every((i) => i.paths[0] === indexPath));

// A URL is not a memory, but a drive letter is not a URL, and splitting text
// into lines has to be lossless or every repair would rewrite the whole file.
const probe = parseIndex('- [Web](https://x.dev/a.md)\n- [Mail](mailto:a@b.c)\n- [Drive](C:/notes.md)\n');
ok('scheme links skipped, drive letters kept', probe.length === 1 && probe[0].file === 'C:/notes.md');
for (const sample of ['a\r\nb\n', '', 'no trailing newline', '\n\n', 'mixed\nline\r\nendings\n']) {
  ok(`line split round-trips ${JSON.stringify(sample)}`, joinLines(splitLines(sample)) === sample);
}

// --- planning --------------------------------------------------------------

const trashedAt = new Date('2026-08-01T10:00:00Z').toISOString();
const plan = planIndexRepairs(read, {
  trashed: [{ path: path.join(dir, 'trashed-note.md'), label: 'trashed-note.md', deletedAt: trashedAt }],
});
const byFile = new Map(plan.actions.map((a) => [a.file, a]));
const find = (f) => byFile.get(f);

ok('every orphaned link is planned or flagged', plan.actions.length + plan.manual.length === dangling.length);
ok('healthy links counted as resolved', plan.resolved === 5);

const prefix = find('memory/deploy.md');
ok('stray directory prefix -> repoint', prefix?.kind === 'repoint' && prefix.target === 'deploy.md');
ok('  high confidence, pre-selected', prefix?.confidence === 'high' && prefix.auto === true);
ok('  rewrites only the destination', prefix?.after === '- [Deploy](deploy.md) — stray directory prefix');

const noExt = find('deploy');
ok('missing extension -> repoint', noExt?.kind === 'repoint' && noExt.confidence === 'high');
ok('  markdown title survives', noExt?.after === '- [Deploy runbook](deploy.md "the runbook") — missing extension, keeps its title');

const renamed = find('build-quirks.md');
ok('renamed file -> repoint by frontmatter name', renamed?.kind === 'repoint' && renamed.via === 'rename');
ok('  anchor is carried over', renamed?.target === 'build-quirks-v2.md#gotchas');
ok('  high confidence', renamed?.confidence === 'high' && renamed.auto === true);

const typo = find('api-notez.md');
ok('near-miss name -> repoint at low confidence', typo?.kind === 'repoint' && typo.via === 'similar');
ok('  never pre-selected', typo?.auto === false);

const absent = find('old-thing.md');
ok('no candidate -> remove the line', absent?.kind === 'remove' && absent.after === null);
ok('  settled by evidence, so pre-selected', absent?.confidence === 'high' && absent.auto === true);
ok('  reason states what was checked', /nothing exists at/.test(absent?.reason || ''));

const trashed = find('trashed-note.md');
ok('link into our own trash -> remove', trashed?.kind === 'remove' && trashed.via === 'trashed');
ok('  high confidence, pre-selected', trashed?.confidence === 'high' && trashed.auto === true);
ok('  reason names the trash', /trash/i.test(trashed?.reason || ''));

ok('table row is deletable', find('gone-table.md')?.kind === 'remove');
ok('link inside prose is left to a human', plan.manual.some((m) => m.file === 'gone-notes.md'));
ok('two links on one line are left to a human', plan.manual.filter((m) => ['gone-a.md', 'gone-b.md'].includes(m.file)).length === 2);
ok('counts add up', plan.counts.total === plan.actions.length && plan.counts.auto === 6 && plan.counts.manual === 3);
ok('guesses stay unticked', plan.actions.filter((a) => a.via === 'similar' || a.via === 'duplicate').every((a) => !a.auto));

// A destination is not "everything up to the first )". Filenames with
// parentheses are real, and `formatTarget` writes the angle-bracket form
// itself -- so a repair must be able to read back what it just wrote.
const parenDir = path.join(sandbox, 'projects', 'X--test', 'parens');
await fs.mkdir(parenDir, { recursive: true });
await fs.writeFile(path.join(parenDir, 'notes(1).md'), '---\nname: notes-1\n---\n\nBody.\n', 'utf8');
await fs.writeFile(path.join(parenDir, 'my (file).md'), '---\nname: my-file\n---\n\nBody.\n', 'utf8');
await fs.writeFile(path.join(parenDir, 'MEMORY.md'), [
  '- [Bare](notes(1).md)',
  '- [Wrapped](<my (file).md>)',
  '- [Titled](notes(1).md "why")',
  '',
].join('\n'), 'utf8');
const parens = await readMemoryDir(parenDir);
ok('a parenthesised filename parses whole', parens.index.entries[0].file === 'notes(1).md');
ok('  so does the angle-bracket form this app writes', parens.index.entries[1].file === 'my (file).md');
ok('  and one carrying a title', parens.index.entries[2].file === 'notes(1).md');
ok('  none of them are reported broken', parens.issues.filter((i) => i.kind === 'dangling-index').length === 0);
ok('  and none are reported unindexed', parens.issues.filter((i) => i.kind === 'unindexed').length === 0);
const parenPlan = planIndexRepairs(parens, {});
ok('  so the repair pass has nothing to do', parenPlan.actions.length === 0 && parenPlan.manual.length === 0);

// Two edits inside a six-character name is a different memory, not a typo:
// `gone-0` must not be "repaired" into `note-0`.
const shortDir = path.join(sandbox, 'projects', 'X--test', 'short');
await fs.mkdir(shortDir, { recursive: true });
await fs.writeFile(path.join(shortDir, 'note-0.md'), '---\nname: note-0\n---\n\nUnrelated.\n', 'utf8');
await fs.writeFile(path.join(shortDir, 'build-quirk.md'), '---\nname: build-quirk\n---\n\nOne letter off.\n', 'utf8');
await fs.writeFile(path.join(shortDir, 'MEMORY.md'),
  '- [Gone 0](gone-0.md)\n- [Build quirks](build-quirks.md)\n', 'utf8');
const shortPlan = planIndexRepairs(await readMemoryDir(shortDir), {});
const shortByFile = new Map(shortPlan.actions.map((a) => [a.file, a]));
ok('two edits in a short name is not a typo', shortByFile.get('gone-0.md')?.kind === 'remove');
ok('one edit in a long name still is', shortByFile.get('build-quirks.md')?.kind === 'repoint');

// A delete can preview its own damage: pretend session-log.md is going away.
const pre = planIndexRepairs(read, { removedFiles: [path.join(dir, 'session-log.md')] });
const pending = pre.actions.find((a) => a.file === 'session-log.md');
ok('a pending delete plans its index line for removal', pending?.kind === 'remove' && pending.auto === true);
ok('  and says why', /moved to the trash/.test(pending?.reason || ''));

// --- applying --------------------------------------------------------------

const auto = plan.actions.filter((a) => a.auto).map((a) => a.id);
const r1 = await applyIndexRepairs(dir, { ids: auto, trashed: [{ path: path.join(dir, 'trashed-note.md'), deletedAt: trashedAt }] });
ok('applied every pre-selected repair', r1.changed && r1.applied.length === 6 && r1.skipped.length === 0);
ok('  3 repointed, 3 removed', r1.repointed === 3 && r1.removed === 3);

const after = await fs.readFile(indexPath, 'utf8');
const lines = after.split('\r\n');
ok('CRLF endings preserved', after.includes('\r\n') && !/[^\r]\n/.test(after));
ok('three lines shorter', lines.length === INDEX_LINES.length - 3);
ok('deploy prefix fixed', lines.includes('- [Deploy](deploy.md) — stray directory prefix'));
ok('extension added, title kept', lines.includes('- [Deploy runbook](deploy.md "the runbook") — missing extension, keeps its title'));
ok('rename repointed with its anchor', lines.includes('- [Build quirks](build-quirks-v2.md#gotchas) — renamed file, keeps its anchor'));
ok('trashed line gone', !after.includes('trashed-note.md'));
ok('dead lines gone', !after.includes('old-thing.md') && !after.includes('gone-table.md'));
ok('healthy lines untouched', lines.includes('- [Session log](session-log.md) — healthy') && lines.includes('- [Docs](https://example.com/docs) — external, not a memory'));
ok('the guess is left alone', after.includes('api-notez.md'));
ok('fenced example untouched', after.includes('- [Example](never-written.md)'));
ok('headings intact', lines.filter((l) => l.startsWith('## ')).length === 4);

const read2 = await readMemoryDir(dir);
const dangling2 = read2.issues.filter((i) => i.kind === 'dangling-index');
ok('6 fewer orphaned links', dangling2.length === dangling.length - 6);
ok('repointed files now count as indexed', !read2.issues.some((i) => i.kind === 'unindexed' && ['deploy.md', 'build-quirks-v2.md'].includes(i.file)));

// Applying again with nothing selected is a no-op, not a rewrite.
const r2 = await applyIndexRepairs(dir, { ids: [] });
ok('empty selection changes nothing', r2.changed === false && r2.applied.length === 0);
ok('  file byte-identical', (await fs.readFile(indexPath, 'utf8')) === after);

// --- guards ----------------------------------------------------------------

const stalePlan = planIndexRepairs(read2, {});
const staleId = stalePlan.actions.find((a) => a.file === 'api-notez.md').id;
await fs.writeFile(indexPath, after.replace('- [API notez](api-notez.md)', '- [API notez, edited elsewhere](api-notez.md)'), 'utf8');
const r3 = await applyIndexRepairs(dir, { ids: [staleId] });
ok('an edit that landed underneath the preview is skipped, not applied', !r3.changed && r3.skipped.length === 1);
ok('  and says so', /changed|not what the preview/i.test(r3.skipped[0].reason));

let threw = '';
try {
  await applyIndexRepairs(path.join(sandbox, 'projects', 'X--test', 'nope'));
} catch (err) {
  threw = err.message;
}
ok('a missing memory directory is an error, not a write', /No memory directory/.test(threw));

await fs.rm(path.join(dir, 'MEMORY.md'));
threw = '';
try {
  await applyIndexRepairs(dir);
} catch (err) {
  threw = err.message;
}
ok('a directory with no index is an error, not a write', /no MEMORY.md/.test(threw));

await fs.rm(sandbox, { recursive: true, force: true });
console.log(`\n${failures ? `${failures} FAILURE(S)` : 'all checks passed'}`);
process.exit(failures ? 1 : 0);
