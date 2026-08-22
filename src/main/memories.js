// Reading and health-checking a project's memory directory.
//
// A memory is one markdown file with YAML frontmatter (`name`, `description`,
// `metadata.type`, and often `metadata.originSessionId`), and `MEMORY.md` is a
// hand-maintained index of one line per memory. Because both sides are written
// by hand they drift: files get added without an index line, index lines
// outlive the files they point at, `[[wikilinks]]` name memories that were
// never written, and `originSessionId` outlives the session it came from.
// Detecting that drift is most of what makes cleanup here worth doing.

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

/** Extract `- [Title](file.md)` entries from MEMORY.md. */
export function parseIndex(text) {
  const entries = [];
  for (const m of text.matchAll(/\[([^\]]*)\]\(([^)]+)\)/g)) {
    const target = m[2].trim();
    if (/^[a-z]+:\/\//i.test(target)) continue; // external URL, not a memory
    entries.push({ title: m[1].trim(), file: target.split('#')[0] });
  }
  return entries;
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

  const issues = diagnose(files, indexEntry, knownSessionIds, memoryDir);
  const { bytes } = await measure(memoryDir);

  return { exists: true, path: memoryDir, files, index: indexEntry, issues, bytes };
}

function diagnose(files, index, knownSessionIds, memoryDir) {
  const issues = [];
  const byFileName = new Map(files.map((f) => [f.name.toLowerCase(), f]));
  const slugs = new Map();

  const indexedFiles = new Set((index?.entries || []).map((e) => e.file.toLowerCase()));

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

    if (
      f.originSessionId &&
      knownSessionIds.size > 0 &&
      !knownSessionIds.has(f.originSessionId)
    ) {
      issues.push({
        kind: 'stale-origin',
        severity: 'info',
        title: 'Origin session is gone',
        detail: `${f.name} records originSessionId ${f.originSessionId.slice(0, 8)}…, but that transcript no longer exists.`,
        paths: [],
        file: f.name,
      });
    }
  }

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
    if (!byFileName.has(e.file.toLowerCase())) {
      issues.push({
        kind: 'dangling-index',
        severity: 'error',
        title: 'Index points at a missing file',
        detail: `MEMORY.md lists "${e.title}" -> ${e.file}, but that file is not in ${path.basename(memoryDir)}/.`,
        paths: [],
        indexFile: e.file,
      });
    }
  }

  return issues;
}

/** Rewrite a memory file's contents in place. */
export async function writeMemory(filePath, text) {
  await fs.writeFile(filePath, text, 'utf8');
}
