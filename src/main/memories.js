// Reading and health-checking a project's memory directory.
//
// A memory is one markdown file with YAML frontmatter (`name`, `description`,
// `metadata.type`, and often `metadata.originSessionId`), and `MEMORY.md` is a
// hand-maintained index of one line per memory. Because both sides are written
// by hand they drift: files get added without an index line, index lines
// outlive the files they point at, `[[wikilinks]]` name memories that were
// never written, and `originSessionId` outlives the session it came from.
// Detecting that drift is most of what makes cleanup here worth doing.
//
// The index is parsed with positions -- which line each link sits on and which
// columns its target occupies -- because `repair.js` rewrites MEMORY.md in
// place and must touch nothing but the link it is fixing.

import fs from 'node:fs/promises';
import path from 'node:path';
import { readDirSafe, statOrNull, measure } from './util.js';

const INDEX_FILE = 'MEMORY.md';

/**
 * Parse the leading `---` frontmatter block. This is a deliberately small YAML
 * subset -- scalars plus one level of nesting -- because that is all Claude
 * Code writes, and a real YAML dependency would buy nothing here.
 */
export function parseFrontmatter(text) {
  if (!text.startsWith('---')) return { data: {}, body: text, hasFrontmatter: false };
  const end = text.indexOf('\n---', 3);
  if (end === -1) return { data: {}, body: text, hasFrontmatter: false };

  const raw = text.slice(text.indexOf('\n') + 1, end);
  const body = text.slice(text.indexOf('\n', end + 1) + 1);
  const data = {};
  let currentKey = null;

  for (const line of raw.split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const m = line.match(/^(\s*)([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const [, indent, key, rawValue] = m;
    const value = unquote(rawValue.trim());

    if (indent.length === 0) {
      if (value === '') {
        data[key] = {};
        currentKey = key;
      } else {
        data[key] = value;
        currentKey = null;
      }
    } else if (currentKey && typeof data[currentKey] === 'object') {
      data[currentKey][key] = value;
    }
  }
  return { data, body, hasFrontmatter: true };
}

function unquote(v) {
  if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) {
    const inner = v.slice(1, -1);
    return v[0] === '"' ? inner.replace(/\\"/g, '"').replace(/\\n/g, '\n') : inner;
  }
  return v;
}

/** Extract `[[wikilink]]` targets from a memory body. */
export function extractLinks(body) {
  const out = new Set();
  for (const m of body.matchAll(/\[\[([^\]]+)\]\]/g)) out.add(m[1].trim());
  return [...out];
}

/**
 * Split text into lines, remembering each line's own terminator so an edited
 * file keeps the endings it arrived with. MEMORY.md is usually CRLF on Windows
 * and LF everywhere else, and a repair that flips every line ending would show
 * up as a whole-file change in git.
 *
 * `joinLines(splitLines(t)) === t` for any input.
 */
export function splitLines(text) {
  const out = [];
  let i = 0;
  for (;;) {
    const nl = text.indexOf('\n', i);
    if (nl === -1) {
      out.push({ text: text.slice(i), eol: '' });
      return out;
    }
    const raw = text.slice(i, nl);
    const crlf = raw.endsWith('\r');
    out.push({ text: crlf ? raw.slice(0, -1) : raw, eol: crlf ? '\r\n' : '\n' });
    i = nl + 1;
  }
}

export function joinLines(lines) {
  return lines.map((l) => l.text + l.eol).join('');
}

/**
 * Walk a line yielding `[text](destination)` links with the exact span the
 * destination occupies.
 *
 * A regex cannot do this. `[^)]*` stops at the first `)`, so `notes(1).md`
 * parses as `notes(1` and `<my (file).md>` as `<my` -- both real filenames, and
 * the second is one this module writes itself: `formatTarget` wraps a
 * destination containing parentheses in angle brackets, so a regex-parsed
 * repair produced a link it would report as broken on the very next pass. The
 * destination is therefore scanned the way CommonMark defines it: the
 * angle-bracket form runs to its closing `>`, the bare form counts parentheses.
 */
function* scanLinks(line) {
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] !== '[') continue;
    const textEnd = line.indexOf(']', i + 1);
    if (textEnd === -1) break;
    if (line[textEnd + 1] !== '(') {
      i = textEnd;
      continue;
    }

    let j = textEnd + 2;
    while (j < line.length && /\s/.test(line[j])) j += 1;
    const start = j;

    if (line[j] === '<') {
      const gt = line.indexOf('>', j + 1);
      if (gt === -1) {
        i = textEnd;
        continue;
      }
      j = gt + 1;
    } else {
      let depth = 0;
      while (j < line.length) {
        const c = line[j];
        if (c === '\\') {
          j += 2;
          continue;
        }
        if (/\s/.test(c)) break;
        if (c === '(') depth += 1;
        else if (c === ')') {
          if (depth === 0) break;
          depth -= 1;
        }
        j += 1;
      }
    }
    const raw = line.slice(start, j);

    // An optional title sits between the destination and the closing paren.
    let k = j;
    while (k < line.length && /\s/.test(line[k])) k += 1;
    if (k < line.length && line[k] !== ')') {
      const open = line[k];
      if (open === '"' || open === "'" || open === '(') {
        const titleEnd = line.indexOf(open === '(' ? ')' : open, k + 1);
        if (titleEnd === -1) {
          i = textEnd;
          continue;
        }
        k = titleEnd + 1;
        while (k < line.length && /\s/.test(line[k])) k += 1;
      }
    }
    if (line[k] !== ')') {
      i = textEnd;
      continue;
    }

    yield { title: line.slice(i + 1, textEnd), raw, start, end: start + raw.length };
    i = k;
  }
}
// A scheme of two or more characters: `https:`, `mailto:`, `file:`. One letter
// is a Windows drive, and `C:/notes.md` is a path this app can still reason about.
const EXTERNAL_RE = /^[a-z][a-z0-9+.-]+:/i;

/** The destination a scanned link points at, with its angle brackets removed. */
function targetValue(raw) {
  return raw.startsWith('<') && raw.endsWith('>') ? raw.slice(1, -1).trim() : raw;
}

/**
 * Reduce an index target to the path it actually means: no angle brackets, no
 * `#anchor`, percent-escapes decoded, backslashes folded to `/`, and no
 * pointless `./` prefix. `[Notes](./notes.md)` and `[Notes](notes%20.md)` both
 * name a file that is right there, and neither is broken.
 */
export function normalizeIndexTarget(raw) {
  let t = String(raw || '').trim();
  if (t.startsWith('<') && t.endsWith('>')) t = t.slice(1, -1).trim();
  t = t.split('#')[0].trim();
  try {
    t = decodeURIComponent(t);
  } catch {
    /* a literal % that is not an escape stays as written */
  }
  t = t.replace(/\\/g, '/');
  while (t.startsWith('./')) t = t.slice(2);
  return t;
}

/**
 * Extract `- [Title](file.md)` entries from MEMORY.md, with the position of
 * every one. Links inside fenced code blocks are examples, not index lines,
 * and external URLs are not memories -- both are skipped.
 */
export function parseIndex(text) {
  const entries = [];
  let inFence = false;

  for (const [line, l] of splitLines(text).entries()) {
    if (/^\s*(?:```|~~~)/.test(l.text)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const found = [];
    for (const link of scanLinks(l.text)) {
      const value = targetValue(link.raw);
      if (!value || EXTERNAL_RE.test(value)) continue;
      const hash = value.indexOf('#');
      const file = hash === -1 ? value : value.slice(0, hash);
      if (!file) continue; // a bare `#anchor` points inside this same file

      found.push({
        title: link.title.trim(),
        file,
        anchor: hash === -1 ? '' : value.slice(hash + 1),
        line,
        start: link.start,
        end: link.end,
        raw: l.text,
      });
    }
    // How many memory links share the line decides whether the line can be
    // deleted wholesale when one of them is beyond repair.
    for (const e of found) {
      e.linkCount = found.length;
      entries.push(e);
    }
  }
  return entries;
}

/**
 * Work out what each index entry points at on disk. An entry is only broken
 * when it names neither a file in this directory nor anything that exists at
 * the path it spells out -- `../CLAUDE.md` and `notes/api.md` are unusual, but
 * they resolve, and a repair pass must not "fix" a link that already works.
 */
async function resolveIndexEntries(index, memoryDir, files) {
  const byName = new Map(files.map((f) => [f.name.toLowerCase(), f.name]));
  for (const e of index.entries) {
    const n = normalizeIndexTarget(e.file);
    e.normalized = n;
    e.baseName = n.split('/').pop();
    e.bare = Boolean(n) && !n.includes('/');
    e.match = (e.bare && byName.get(e.baseName.toLowerCase())) || '';
    e.resolvedPath = path.resolve(memoryDir, n || '.');
    e.resolvedExists = n ? Boolean(await statOrNull(e.resolvedPath)) : false;
  }
}

/**
 * Read every memory in a project directory and diagnose the drift between the
 * files, the index, and the sessions they came from.
 *
 * @param memoryDir absolute path to the project's `memory/` directory
 * @param knownSessionIds Set of session ids that still exist, for stale-origin
 *        detection. Pass an empty set to skip that check.
 */
export async function readMemoryDir(memoryDir, knownSessionIds = new Set()) {
  const st = await statOrNull(memoryDir);
  if (!st || !st.isDirectory()) {
    return { exists: false, path: memoryDir, files: [], index: null, issues: [], bytes: 0 };
  }

  const names = (await readDirSafe(memoryDir)).filter((n) => n.toLowerCase().endsWith('.md'));
  const files = [];
  let indexEntry = null;

  for (const name of names) {
    const full = path.join(memoryDir, name);
    const fstat = await statOrNull(full);
    if (!fstat || !fstat.isFile()) continue;

    let text = '';
    try {
      text = await fs.readFile(full, 'utf8');
    } catch {
      continue;
    }

    if (name === INDEX_FILE) {
      indexEntry = {
        name,
        path: full,
        bytes: fstat.size,
        mtime: fstat.mtimeMs,
        text,
        entries: parseIndex(text),
      };
      continue;
    }

    const { data, body, hasFrontmatter } = parseFrontmatter(text);
    const metadata = typeof data.metadata === 'object' && data.metadata ? data.metadata : {};
    files.push({
      name,
      path: full,
      bytes: fstat.size,
      mtime: fstat.mtimeMs,
      slug: data.name || '',
      description: data.description || '',
      type: metadata.type || '',
      originSessionId: metadata.originSessionId || '',
      hasFrontmatter,
      links: extractLinks(body),
      body,
      excerpt: body.trim().slice(0, 400),
      text,
    });
  }

  files.sort((a, b) => b.mtime - a.mtime);
  if (indexEntry) await resolveIndexEntries(indexEntry, memoryDir, files);

  const issues = diagnose(files, indexEntry, knownSessionIds, memoryDir);
  const { bytes } = await measure(memoryDir);

  return { exists: true, path: memoryDir, files, index: indexEntry, issues, bytes };
}

/**
 * The one memory issue that depends on something outside its own directory: a
 * memory here routinely records an origin session that lives in another
 * project, so deleting sessions anywhere can make these appear or disappear.
 * Exported so a refresh scoped to one project can re-derive it from the
 * surviving session ids alone, without re-reading a file.
 */
export function staleOriginIssues(files, knownSessionIds) {
  if (!knownSessionIds || knownSessionIds.size === 0) return [];
  return files
    .filter((f) => f.originSessionId && !knownSessionIds.has(f.originSessionId))
    .map((f) => ({
      kind: 'stale-origin',
      severity: 'info',
      title: 'Origin session is gone',
      detail: `${f.name} records originSessionId ${f.originSessionId.slice(0, 8)}…, but that transcript no longer exists.`,
      paths: [],
      file: f.name,
    }));
}

function diagnose(files, index, knownSessionIds, memoryDir) {
  const issues = [];
  const byFileName = new Map(files.map((f) => [f.name.toLowerCase(), f]));
  const slugs = new Map();

  // Only entries that actually land on a file in this directory count as
  // indexing it; a link out to another folder does not make a memory loadable.
  const indexedFiles = new Set(
    (index?.entries || []).filter((e) => e.match).map((e) => e.match.toLowerCase())
  );

  if (!index && files.length) {
    issues.push({
      kind: 'missing-index',
      severity: 'warn',
      title: 'No MEMORY.md index',
      detail: `${files.length} memor${files.length === 1 ? 'y' : 'ies'} exist with no index file. Claude loads MEMORY.md each session, so unindexed memories are effectively invisible.`,
      paths: [],
    });
  }

  for (const f of files) {
    if (!f.hasFrontmatter) {
      issues.push({
        kind: 'no-frontmatter',
        severity: 'warn',
        title: 'Missing frontmatter',
        detail: `${f.name} has no YAML frontmatter block, so it has no name, description, or type.`,
        paths: [f.path],
        file: f.name,
      });
    } else if (!f.slug) {
      issues.push({
        kind: 'missing-name',
        severity: 'warn',
        title: 'Frontmatter has no name',
        detail: `${f.name} declares no \`name:\`, so [[wikilinks]] cannot resolve to it.`,
        paths: [f.path],
        file: f.name,
      });
    }

    if (f.slug) {
      if (slugs.has(f.slug)) {
        issues.push({
          kind: 'duplicate-name',
          severity: 'warn',
          title: 'Duplicate memory name',
          detail: `${f.name} and ${slugs.get(f.slug).name} both declare \`name: ${f.slug}\`.`,
          paths: [f.path, slugs.get(f.slug).path],
          file: f.name,
        });
      } else {
        slugs.set(f.slug, f);
      }
    }

    if (!f.body.trim()) {
      issues.push({
        kind: 'empty',
        severity: 'info',
        title: 'Empty memory',
        detail: `${f.name} has frontmatter but no content.`,
        paths: [f.path],
        file: f.name,
      });
    }

    if (index && !indexedFiles.has(f.name.toLowerCase())) {
      issues.push({
        kind: 'unindexed',
        severity: 'warn',
        title: 'Not listed in MEMORY.md',
        detail: `${f.name} exists but no index line points at it, so it is never loaded into context.`,
        paths: [f.path],
        file: f.name,
      });
    }

  }

  issues.push(...staleOriginIssues(files, knownSessionIds));

  // Wikilinks that resolve to nothing. Checked after every slug is registered.
  for (const f of files) {
    for (const link of f.links) {
      if (!slugs.has(link) && !byFileName.has(link.toLowerCase() + '.md')) {
        issues.push({
          kind: 'broken-link',
          severity: 'info',
          title: 'Unresolved [[link]]',
          detail: `${f.name} links to [[${link}]], which no memory in this project declares. That may be a note to write it later, or a typo.`,
          paths: [f.path],
          file: f.name,
          link,
        });
      }
    }
  }

  for (const e of index?.entries || []) {
    if (e.match || e.resolvedExists) continue;
    issues.push({
      kind: 'dangling-index',
      severity: 'error',
      title: 'Index points at a missing file',
      detail: `MEMORY.md lists "${e.title}" -> ${e.file} on line ${e.line + 1}, but that file is not in ${path.basename(memoryDir)}/.`,
      paths: index ? [index.path] : [],
      indexFile: e.file,
      indexTitle: e.title,
      line: e.line + 1,
    });
  }

  return issues;
}

/** Rewrite a memory file's contents in place. */
export async function writeMemory(filePath, text) {
  await fs.writeFile(filePath, text, 'utf8');
}
