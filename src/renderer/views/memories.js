// Memories view: the files, their health, and an editor.
//
// Health is the point. Memory drift (a file no index line points at, an index
// line pointing at nothing, a [[link]] that resolves nowhere) is invisible in
// a file browser and is exactly what makes a memory directory rot, so issues
// are surfaced above the files rather than hidden behind a filter.

import { el, mount, formatBytes, relativeTime, emptyState, toast, cleanError, pathRow, pathActions } from '../dom.js';
import { store, set, toggleSelected, clearSelection, activeProjects } from '../state.js';
import { reportResults } from './sessions.js';

export function renderMemories(root) {
  mount(root, sidebar(), pane());
}

function sidebar() {
  const projects = store.scan?.projects || [];
  const withMemories = projects.filter((p) => p.memory.count > 0 || p.memory.exists);

  const item = (id, name, meta, issues) =>
    el('button', {
      class: 'proj',
      'aria-current': String(store.projectId === id),
      onclick: () => {
        clearSelection();
        set({ projectId: id, openMemory: null });
      },
    },
      el('div', { class: 'proj-name' },
        el('span', { class: 'txt' }, name),
        issues ? el('span', { class: 'badge badge-warn' }, String(issues)) : null
      ),
      el('div', { class: 'proj-meta' }, meta)
    );

  return el('aside', { class: 'sidebar' },
    el('div', { class: 'sidebar-title' }, 'Memory directories'),
    item(
      null,
      'All projects',
      `${projects.reduce((n, p) => n + p.memory.count, 0)} memories`,
      projects.reduce((n, p) => n + p.memory.issues.length, 0)
    ),
    withMemories.length
      ? withMemories.map((p) =>
          item(
            p.id,
            p.realPath.split(/[\\/]/).filter(Boolean).pop() || p.id,
            `${p.memory.count} memor${p.memory.count === 1 ? 'y' : 'ies'} · ${formatBytes(p.memory.bytes)}`,
            p.memory.issues.length
          )
        )
      : el('div', { class: 'faint', style: { padding: '10px' } }, 'No memory directories yet.')
  );
}

function pane() {
  const projects = activeProjects();
  const scope = store.projectId ? projects[0] : null;

  const files = projects.flatMap((p) => p.memory.files.map((f) => ({ ...f, project: p })));
  const issues = projects.flatMap((p) => p.memory.issues.map((i) => ({ ...i, project: p })));

  const filtered = store.memoryFilter === 'issues'
    ? files.filter((f) => issues.some((i) => i.file === f.name && i.project.id === f.project.id))
    : files;

  const head = el('div', { class: 'pane-head' },
    el('div', { style: { minWidth: 0 } },
      el('h2', {}, scope ? (scope.realPath.split(/[\\/]/).filter(Boolean).pop() || scope.id) : 'All memories'),
      el('div', { class: 'sub' }, scope ? scope.memory.path : `${files.length} memory files across ${projects.length} projects`)
    ),
    el('div', { class: 'actions' },
      el('select', {
        class: 'btn btn-sm',
        onchange: (e) => set({ memoryFilter: e.target.value }),
      },
        el('option', { value: 'all', selected: store.memoryFilter === 'all' }, 'All memories'),
        el('option', { value: 'issues', selected: store.memoryFilter === 'issues' }, 'Only with issues')
      ),
      scope && scope.memory.exists
        ? el('button', {
            class: 'btn btn-sm',
            title: `Open the memory directory:
${scope.memory.path}`,
            onclick: () => window.api.openPath(scope.memory.path),
          }, 'Open memory dir')
        : null,
      scope
        ? el('button', {
            class: 'btn btn-sm',
            title: 'Copy the memory directory path',
            onclick: async () => { await window.api.copyText(scope.memory.path); toast('Path copied to clipboard.', 'ok'); },
          }, 'Copy path')
        : null
    )
  );

  const bar = store.selected.size
    ? el('div', { class: 'selbar' },
        el('span', { class: 'info' }, `${store.selected.size} selected`),
        el('span', { class: 'grow' }),
        el('button', { class: 'btn btn-sm', onclick: () => { clearSelection(); set({}); } }, 'Clear'),
        el('button', { class: 'btn btn-sm btn-danger', onclick: () => deleteSelected(files) }, 'Move to trash')
      )
    : null;

  const body = el('div', { class: 'pane-body' });

  if (issues.length) body.append(issuesCard(issues));

  if (!filtered.length) {
    body.append(files.length
      ? emptyState('✓', 'No memories match this filter', 'Every memory in scope is healthy.')
      : emptyState('◌', 'No memories here', 'Claude writes memories into ~/.claude/projects/<project>/memory/ as it learns things worth keeping.'));
  } else {
    body.append(el('div', {}, filtered.map((f) => memoryCard(f, issues))));
  }

  if (store.openMemory) body.append(editorCard());

  return el('section', { class: 'pane' }, head, bar, body);
}

function issuesCard(issues) {
  const order = { error: 0, warn: 1, info: 2 };
  const sorted = [...issues].sort((a, b) => order[a.severity] - order[b.severity]);
  const counts = sorted.reduce((m, i) => ({ ...m, [i.severity]: (m[i.severity] || 0) + 1 }), {});

  return el('div', { class: 'card' },
    el('h3', {},
      `${issues.length} memory issue${issues.length === 1 ? '' : 's'}`,
      counts.error ? el('span', { class: 'badge badge-danger' }, `${counts.error} broken`) : null,
      counts.warn ? el('span', { class: 'badge badge-warn' }, `${counts.warn} warning`) : null,
      counts.info ? el('span', { class: 'badge badge-info' }, `${counts.info} note`) : null
    ),
    el('div', { class: 'desc' }, 'Drift between the memory files, the MEMORY.md index, and the sessions they came from.'),
    sorted.map((i) =>
      el('div', { class: `issue sev-${i.severity}` },
        el('div', { class: 'body' },
          el('div', { class: 't' }, i.title,
            !store.projectId
              ? el('span', { class: 'faint mono', style: { fontWeight: '400', marginLeft: '7px' } },
                  i.project.realPath.split(/[\\/]/).filter(Boolean).pop())
              : null
          ),
          el('div', { class: 'd' }, i.detail)
        ),
        i.paths?.length ? pathActions(i.paths[0], { always: true }) : null
      )
    )
  );
}

function memoryCard(f, allIssues) {
  const mine = allIssues.filter((i) => i.file === f.name && i.project.id === f.project.id);
  const typeBadge = {
    user: 'badge-info',
    feedback: 'badge-warn',
    project: 'badge-mute',
    reference: 'badge-mute',
  }[f.type] || 'badge-mute';

  return el('div', { class: 'card' },
    el('div', { style: { display: 'flex', gap: '11px', alignItems: 'flex-start' } },
      el('input', {
        type: 'checkbox',
        style: { marginTop: '3px' },
        checked: store.selected.has(f.path),
        onchange: (e) => toggleSelected(f.path, e.target.checked),
      }),
      el('div', { style: { flex: '1', minWidth: 0 } },
        el('h3', {},
          f.slug || f.name.replace(/\.md$/, ''),
          f.type ? el('span', { class: `badge ${typeBadge}` }, f.type) : null,
          mine.length ? el('span', { class: 'badge badge-warn' }, `${mine.length} issue${mine.length === 1 ? '' : 's'}`) : null,
          !store.projectId
            ? el('span', { class: 'faint mono', style: { fontWeight: '400', fontSize: '11px' } },
                f.project.realPath.split(/[\\/]/).filter(Boolean).pop())
            : null
        ),
        f.description ? el('div', { class: 'desc' }, f.description) : null,
        el('div', { class: 'row-facts' },
          el('span', { class: 'mono' }, f.name),
          el('span', {}, formatBytes(f.bytes)),
          el('span', {}, relativeTime(f.mtime)),
          f.links.length ? el('span', {}, el('b', {}, 'links'), ' ', f.links.join(', ')) : null,
          f.originSessionId ? el('span', {}, el('b', {}, 'from'), ' ', f.originSessionId.slice(0, 8)) : null
        ),
        f.excerpt ? el('div', { class: 'dim', style: { marginTop: '8px', fontSize: '12px', whiteSpace: 'pre-wrap' } },
          f.excerpt + (f.excerpt.length >= 400 ? '…' : '')) : null
      ),
      el('div', { style: { display: 'flex', gap: '6px', flex: 'none', alignItems: 'center' } },
        el('button', { class: 'btn btn-sm', onclick: () => openEditor(f) }, 'Edit'),
        pathActions(f.path, { always: true })
      )
    )
  );
}

async function openEditor(f) {
  try {
    const text = await window.api.readMemoryFile(f.path);
    set({ openMemory: { ...f, text } });
  } catch (err) {
    toast(cleanError(err), 'err');
  }
}

function editorCard() {
  const m = store.openMemory;
  const area = el('textarea', { class: 'editor', spellcheck: 'false' }, m.text);

  return el('div', { class: 'card', style: { borderColor: 'var(--accent-line)' } },
    el('h3', {}, `Editing ${m.name}`),
    pathRow('File', m.path),
    area,
    el('div', { style: { display: 'flex', gap: '7px', marginTop: '10px' } },
      el('button', {
        class: 'btn btn-sm btn-accent',
        onclick: async () => {
          try {
            await window.api.writeMemoryFile(m.path, area.value);
            toast('Memory saved.', 'ok');
            set({ openMemory: null });
            window.dispatchEvent(new CustomEvent('cm:rescan'));
          } catch (err) {
            toast(cleanError(err), 'err');
          }
        },
      }, 'Save'),
      el('button', { class: 'btn btn-sm', onclick: () => set({ openMemory: null }) }, 'Cancel')
    )
  );
}

async function deleteSelected(files) {
  const chosen = files.filter((f) => store.selected.has(f.path));
  if (!chosen.length) return;

  const ok = await window.api.confirm({
    title: 'Move memories to trash',
    message: `Move ${chosen.length} memor${chosen.length === 1 ? 'y' : 'ies'} to the trash?`,
    detail:
      chosen.map((f) => `• ${f.name} — ${f.description || '(no description)'}`).join('\n') +
      `\n\nMEMORY.md is not rewritten, so its index lines will report as broken until you edit them. ` +
      `Everything is restorable from the Trash tab.`,
    confirmLabel: 'Move to trash',
    danger: true,
  });
  if (!ok) return;

  const results = await window.api.deleteMemories(chosen.map((f) => f.path));
  reportResults(results, 'memory');
}
