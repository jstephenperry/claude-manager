// Repairing MEMORY.md when its links are orphaned.
//
// `dangling-index` -- an index line pointing at a file that is not there -- is
// the one memory issue with a mechanical fix, and it is the issue this app
// creates every time it trashes a memory. So it is fixed here rather than left
// as a note for the user to act on by hand.
//
// Three rules keep an automatic edit honest:
//
// 1. Nothing is proposed for a link that resolves. `memories.js` checks each
//    target on disk first, so `./notes.md` and `../CLAUDE.md` are working
//    links, not damage to repair.
// 2. Confidence is explicit. A link whose file is plainly still here (an extra
//    `memory/` prefix, a missing `.md`, a renamed file that still declares the
//    same `name:`) is repointed and marked high confidence. A guess is offered
//    at low confidence and never pre-selected.
// 3. An edit is the smallest one that fixes the link: a repoint rewrites the
//    characters inside the parentheses and nothing else, and a line is only
//    deleted when the whole line is that one link's list item or table row.
//    Anything else is reported as needing a human, not edited.
//
// Nothing here writes on its own -- `planIndexRepairs` returns a plan and
// `applyIndexRepairs` applies exactly the actions it is handed.

import path from 'node:path';
import { readMemoryDir, splitLines, joinLines } from './memories.js';
import { writeTextAtomic } from './util.js';

const stem = (name) => name.replace(/\.md$/i, '');
const withExt = (name) => (/\.md$/i.test(name) ? name : name + '.md');
/** Paths are compared case-insensitively: this app's home platform is Windows. */
const key = (p) => path.resolve(p).toLowerCase();

const slugify = (s) =>
  String(s || '')
    .replace(/\.md$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/** Levenshtein distance, abandoned once it passes `max`. */
function distance(a, b, max = 2) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
      best = Math.min(best, row[j]);
    }
    if (best > max) return max + 1;
    prev = row;
  }
  return prev[b.length];
}

/** A destination with spaces or parentheses needs angle brackets to survive. */
function formatTarget(target) {
  return /[\s()]/.test(target) ? `<${target}>` : target;
}

/**
 * A line may only be deleted outright when the orphaned link is the whole
 * point of it: one link, in a list item, a table row, or alone on the line.
 * A link mentioned mid-sentence is somebody's prose.
 */
function lineIsDeletable(text, entry) {
  if (entry.linkCount !== 1) return false;
  if (/^\s*(?:[-*+]|\d+[.)])\s/.test(text)) return true;
  if (/^\s*\|/.test(text)) return true;
  const rest = (text.slice(0, entry.start) + text.slice(entry.end)).replace(/[[\]()\-*+.,;:|\s]/g, '');
  return rest === '';
}

/**
 * Find the memory file a broken link was probably meant to name.
 *
 * @returns {{file, via, confidence, alternatives}|null}
 */
function findCandidate(entry, files, indexed) {
  const byName = new Map(files.map((f) => [f.name.toLowerCase(), f]));
  const target = withExt(entry.baseName || '');

  // The file is right here and the link merely spells it wrong -- a stray
  // `memory/` prefix, a missing extension, the wrong case, an escaped space.
  const direct = byName.get(target.toLowerCase());
  if (direct) return { file: direct, via: 'path', confidence: 'high', alternatives: [] };

  const targetSlug = slugify(target);
  const titleSlug = slugify(entry.title);
  const free = files.filter((f) => !indexed.has(f.name.toLowerCase()));

  // A rename: the file still declares the name the index knows it by.
  const strong = (pool) =>
    pool.filter((f) => {
      const nameSlug = slugify(f.slug);
      const fileSlug = slugify(f.name);
      return (
        (targetSlug && (nameSlug === targetSlug || fileSlug === targetSlug)) ||
        (titleSlug && (nameSlug === titleSlug || fileSlug === titleSlug))
      );
    });

  const freeStrong = strong(free);
  if (freeStrong.length === 1) {
    return { file: freeStrong[0], via: 'rename', confidence: 'high', alternatives: [] };
  }
  if (freeStrong.length > 1) {
    return {
      file: freeStrong[0],
      via: 'rename',
      confidence: 'low',
      alternatives: freeStrong.slice(1).map((f) => f.name),
    };
  }

  // A file that already has its own index line is a weak candidate: repointing
  // at it produces two lines for one memory, so the user decides.
  const takenStrong = strong(files.filter((f) => indexed.has(f.name.toLowerCase())));
  if (takenStrong.length === 1) {
    return { file: takenStrong[0], via: 'duplicate', confidence: 'low', alternatives: [] };
  }

  // Last resort: a near-miss filename, always offered as a guess.
  if (targetSlug.length >= 4) {
    const scored = free
      .map((f) => ({ f, d: Math.min(distance(targetSlug, slugify(f.name)), distance(targetSlug, slugify(f.slug))) }))
      .filter((x) => x.d <= 2)
      .sort((a, b) => a.d - b.d);
    if (scored.length && (scored.length === 1 || scored[0].d < scored[1].d)) {
      return {
        file: scored[0].f,
        via: 'similar',
        confidence: 'low',
        alternatives: scored.slice(1).map((x) => x.f.name),
      };
    }
  }

  return null;
}

function reasonFor(via, entry, file, alternatives) {
  const also = alternatives.length ? ` Other candidates: ${alternatives.join(', ')}.` : '';
  switch (via) {
    case 'path':
      return `${file.name} is right here — the link just spells the path differently.`;
    case 'rename':
      return `${file.name} declares \`name: ${file.slug || stem(file.name)}\`, which is what this line calls it, so the file was probably renamed.${also}`;
    case 'duplicate':
      return `${file.name} looks like the memory this line means, but it already has its own index line — repointing would list it twice.${also}`;
    default:
      return `${file.name} is the closest name to ${entry.file} still in the directory. Check it before applying.${also}`;
  }
}

/**
 * Build the repair plan for one memory directory.
 *
 * @param memory   the result of `readMemoryDir`
 * @param opts.trashed  flat list of `{path, label, deletedAt}` for everything
 *        currently in this app's trash; a link into it was orphaned by a
 *        delete we made, which makes dropping the line the obvious fix
 * @param opts.removedFiles absolute paths that are about to be deleted, so a
 *        delete can show what it will do to MEMORY.md before it does it
 */
export function planIndexRepairs(memory, opts = {}) {
  const dir = memory.path;
  const base = {
    dir,
    exists: Boolean(memory.exists),
    hasIndex: Boolean(memory.index),
    indexPath: memory.index?.path || (memory.exists ? path.join(dir, 'MEMORY.md') : ''),
    actions: [],
    manual: [],
    resolved: 0,
  };
  if (!memory.exists || !memory.index) return { ...base, counts: counts(base) };

  const removed = new Set((opts.removedFiles || []).filter(Boolean).map(key));
  const trashed = new Map((opts.trashed || []).filter((t) => t?.path).map((t) => [key(t.path), t]));

  const lines = splitLines(memory.index.text);
  const files = memory.files.filter((f) => !removed.has(key(f.path)));
  const entries = memory.index.entries;

  // What the index still points at correctly, so a repoint never lands on a
  // file that already has a line of its own without saying so.
  const indexed = new Set(
    entries.filter((e) => e.match && !removed.has(key(path.join(dir, e.match)))).map((e) => e.match.toLowerCase())
  );

  const actions = [];
  const manual = [];
  let resolved = 0;

  for (const entry of entries) {
    const stillThere =
      (entry.match && !removed.has(key(path.join(dir, entry.match)))) ||
      (entry.resolvedExists && !removed.has(key(entry.resolvedPath)));
    if (stillThere) {
      resolved += 1;
      continue;
    }

    const line = lines[entry.line]?.text ?? '';
    const shared = {
      line: entry.line,
      lineNo: entry.line + 1,
      before: line,
      title: entry.title,
      file: entry.file,
      path: entry.resolvedPath, // what the link points at, for callers matching a delete
    };

    const candidate = findCandidate(entry, files, indexed);
    if (candidate) {
      const target = candidate.file.name + (entry.anchor ? `#${entry.anchor}` : '');
      actions.push({
        ...shared,
        id: `repoint:${entry.line}:${entry.start}`,
        kind: 'repoint',
        confidence: candidate.confidence,
        auto: candidate.confidence === 'high',
        after: line.slice(0, entry.start) + formatTarget(target) + line.slice(entry.end),
        start: entry.start,
        end: entry.end,
        replacement: formatTarget(target),
        target,
        via: candidate.via,
        match: {
          name: candidate.file.name,
          slug: candidate.file.slug,
          description: candidate.file.description,
        },
        reason: reasonFor(candidate.via, entry, candidate.file, candidate.alternatives),
      });
      continue;
    }

    if (!lineIsDeletable(line, entry)) {
      manual.push({
        ...shared,
        reason:
          entry.linkCount > 1
            ? 'The line carries other links, so deleting it would take them with it.'
            : 'The link sits inside a line with other content, so it needs an edit rather than a deletion.',
      });
      continue;
    }

    const gone = trashed.get(key(entry.resolvedPath)) || (removed.has(key(entry.resolvedPath)) ? { pending: true } : null);
    actions.push({
      ...shared,
      id: `remove:${entry.line}:${entry.start}`,
      kind: 'remove',
      confidence: gone ? 'high' : 'low',
      auto: Boolean(gone),
      after: null,
      target: '',
      via: gone ? (gone.pending ? 'deleting' : 'trashed') : 'absent',
      match: null,
      reason: gone
        ? gone.pending
          ? `${entry.file} is being moved to the trash, so this line is about to point at nothing.`
          : `${entry.file} is in this app's trash (${new Date(gone.deletedAt).toLocaleDateString()}). Restore it from the Trash tab to bring the memory back; this line goes with it.`
        : `Nothing in this directory looks like ${entry.file}. Deleting the line drops a pointer to a file that is not here — check it is not simply somewhere else first.`,
    });
  }

  const plan = { ...base, actions, manual, resolved };
  return { ...plan, counts: counts(plan) };
}

function counts(plan) {
  const a = plan.actions || [];
  return {
    total: a.length,
    auto: a.filter((x) => x.auto).length,
    repoint: a.filter((x) => x.kind === 'repoint').length,
    remove: a.filter((x) => x.kind === 'remove').length,
    manual: (plan.manual || []).length,
  };
}

/**
 * Apply chosen edits to a set of lines. A removal drops its line; a repoint
 * replaces just the span the destination occupies, applied right to left so
 * two repairs on one line cannot shift each other's columns.
 */
function rewrite(lines, actions) {
  const drop = new Set();
  const edits = new Map();
  for (const a of actions) {
    if (a.kind === 'remove') {
      drop.add(a.line);
    } else {
      if (!edits.has(a.line)) edits.set(a.line, []);
      edits.get(a.line).push(a);
    }
  }

  const out = [];
  for (const [i, l] of lines.entries()) {
    if (drop.has(i)) continue;
    const mine = edits.get(i);
    if (!mine) {
      out.push(l);
      continue;
    }
    let text = l.text;
    for (const a of [...mine].sort((x, y) => y.start - x.start)) {
      text = text.slice(0, a.start) + a.replacement + text.slice(a.end);
    }
    out.push({ text, eol: l.eol });
  }
  return out;
}

/**
 * Re-plan against what is on disk right now, apply the chosen actions, and
 * write MEMORY.md back atomically.
 *
 * The plan is rebuilt here rather than trusted from the caller for the same
 * reason the sweep re-plans before it runs: a plan is a snapshot, and the
 * directory may have moved on. Every action is matched by id and then checked
 * against the line it claims to edit, so a MEMORY.md that changed underneath
 * the preview is skipped rather than mangled.
 *
 * @returns {{changed, path, before, after, applied, skipped, removed, repointed}}
 */
export async function applyIndexRepairs(memoryDir, opts = {}) {
  const memory = await readMemoryDir(memoryDir);
  if (!memory.exists) throw new Error(`No memory directory at ${memoryDir}.`);
  if (!memory.index) throw new Error('This memory directory has no MEMORY.md to repair.');

  const plan = planIndexRepairs(memory, { trashed: opts.trashed });
  const wanted = Array.isArray(opts.ids) ? new Set(opts.ids) : null;
  const chosen = plan.actions.filter((a) => (wanted ? wanted.has(a.id) : a.auto));

  const lines = splitLines(memory.index.text);
  const applied = [];
  const skipped = [];

  if (wanted) {
    const found = new Set(chosen.map((a) => a.id));
    for (const id of wanted) {
      if (!found.has(id)) skipped.push({ id, reason: 'MEMORY.md has changed since the preview; this repair no longer applies.' });
    }
  }

  for (const a of chosen) {
    if (lines[a.line]?.text !== a.before) {
      skipped.push({ id: a.id, reason: `Line ${a.lineNo} of MEMORY.md is not what the preview showed.` });
      continue;
    }
    applied.push(a);
  }

  const before = memory.index.text;
  const after = applied.length ? joinLines(rewrite(lines, applied)) : before;

  const result = {
    changed: after !== before,
    path: memory.index.path,
    before,
    after,
    applied: applied.map((a) => ({ id: a.id, kind: a.kind, lineNo: a.lineNo, file: a.file, target: a.target, before: a.before, after: a.after })),
    skipped,
    removed: applied.filter((a) => a.kind === 'remove').length,
    repointed: applied.filter((a) => a.kind === 'repoint').length,
  };

  if (result.changed) await writeTextAtomic(memory.index.path, after);
  return result;
}
