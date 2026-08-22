// Scratchpads view: the working directories Claude Code gives each session,
// under the OS temp folder rather than ~/.claude.
//
// Most entries are empty husks -- a directory created for a session that never
// wrote a file. Those are collapsed behind a single line so the handful of
// scratchpads holding real scripts, diffs, and captured output stay visible.

import { el, mount, formatBytes, relativeTime, emptyState, toast, cleanError, pathActions, pathRow } from '../dom.js';
import { store, set, toggleSelected, clearSelection } from '../state.js';
import { reportResults } from './sessions.js';

export function renderScratchpads(root) {
  const sp = store.scan?.scratchpads;
  if (!sp?.exists) {
    mount(root, el('section', { class: 'pane' },
      el('div', { class: 'pane-head' }, el('div', {}, el('h2', {}, 'Scratchpads'))),
      el('div', { class: 'pane-body' },
        emptyState('◌', 'No scratchpad directory',
          `Nothing found at ${sp?.root || 'the scratchpad root'}. Claude Code creates it the first time a session writes a temporary file.`))
    ));
    return;
  }
  mount(root, sidebar(sp), pane(sp));
}

function sidebar(sp) {
  const item = (id, name, meta, badge) =>
    el('button', {
      class: 'proj',
      'aria-current': String(store.scratchProject === id),
      onclick: () => {
        clearSelection();
        set({ scratchProject: id, openScratch: null });
      },
    },
      el('div', { class: 'proj-name' },
        el('span', { class: 'txt' }, name),
        badge ? el('span', { class: 'badge badge-warn' }, String(badge)) : null
      ),
      el('div', { class: 'proj-meta' }, meta)
    );

  return el('aside', { class: 'sidebar' },
    el('div', { class: 'sidebar-title' }, 'Scratchpad projects'),
    item(null, 'All projects', `${sp.sessionCount} session dirs · ${formatBytes(sp.totalBytes)}`, sp.orphanCount),
    sp.projects.map((p) =>
      item(
        p.id,
        p.id.replace(/^[A-Za-z]--/, '').split('-').slice(-2).join('-') || p.id,
        `${p.sessions.length} sess · ${formatBytes(p.bytes)}`,
        p.orphanCount
      )
    )
  );
}

function pane(sp) {
  const projects = store.scratchProject ? sp.projects.filter((p) => p.id === store.scratchProject) : sp.projects;
  const sessions = projects.flatMap((p) => p.sessions.map((s) => ({ ...s, project: p })));
  const withFiles = sessions.filter((s) => !s.empty);
  const empties = sessions.filter((s) => s.empty);

  const head = el('div', { class: 'pane-head' },
    el('div', { style: { minWidth: 0 } },
      el('h2', {}, store.scratchProject || 'All scratchpads'),
      el('div', { class: 'sub mono' }, sp.root)
    ),
    el('div', { class: 'actions' },
      el('button', {
        class: 'btn btn-sm',
        title: `Open ${sp.root}`,
        onclick: () => window.api.openPath(sp.root),
      }, 'Open root'),
      empties.length
        ? el('button', {
            class: 'btn btn-sm',
            title: 'Select every empty scratchpad directory that is not in use',
            onclick: () => {
              for (const s of empties) if (!s.live) store.selected.add(s.id);
              set({});
            },
          }, `Select ${empties.filter((s) => !s.live).length} empty`)
        : null
    )
  );

  const bar = store.selected.size
    ? el('div', { class: 'selbar' },
        el('span', { class: 'info' }, `${store.selected.size} selected`),
        el('span', { class: 'faint mono' },
          formatBytes(sessions.filter((s) => store.selected.has(s.id)).reduce((n, s) => n + s.bytes, 0))),
        el('span', { class: 'grow' }),
        el('button', { class: 'btn btn-sm', onclick: () => { clearSelection(); set({}); } }, 'Clear'),
        el('button', { class: 'btn btn-sm btn-danger', onclick: () => deleteSelected(sessions) }, 'Move to trash')
      )
    : null;

  const body = el('div', { class: 'pane-body' });

  body.append(el('div', { class: 'card', style: { background: 'var(--panel-2)' } },
    el('div', { class: 'row-facts', style: { fontSize: '11.5px' } },
      el('span', {}, el('b', {}, 'total'), ' ', formatBytes(sp.totalBytes)),
      el('span', {}, el('b', {}, 'session dirs'), ' ', sp.sessionCount),
      el('span', {}, el('b', {}, 'empty'), ' ', sp.emptyCount),
      el('span', {}, el('b', {}, 'orphaned'), ' ', `${sp.orphanCount} (${formatBytes(sp.orphanBytes)})`)
    ),
    el('div', { class: 'desc', style: { margin: '7px 0 0' } },
      'Orphaned means the session transcript is gone, so nothing will ever read these files again. Scratchpads live outside ~/.claude and nothing prunes them.')
  ));

  if (!sessions.length) {
    body.append(emptyState('◌', 'No scratchpads here', 'This project has no session working directories.'));
  } else {
    if (withFiles.length) {
      for (const s of withFiles) body.append(sessionCard(s));
    }
    if (empties.length) body.append(emptiesCard(empties));
  }

  if (sp.loose.length && !store.scratchProject) body.append(looseCard(sp.loose));

  return el('section', { class: 'pane' }, head, bar, body);
}

function sessionCard(s) {
  const label = s.sessionId ? s.sessionId.slice(0, 8) : s.path.split(/[\\/]/).pop();
  const known = store.scan?.sessionIds?.includes(s.sessionId);

  return el('div', { class: 'card' },
    el('div', { style: { display: 'flex', gap: '11px', alignItems: 'flex-start' } },
      el('input', {
        type: 'checkbox',
        style: { marginTop: '3px' },
        checked: store.selected.has(s.id),
        disabled: s.live,
        title: s.live ? 'This session is running' : 'Select',
        onchange: (e) => toggleSelected(s.id, e.target.checked),
      }),
      el('div', { style: { flex: '1', minWidth: 0 } },
        el('h3', {},
          s.live ? el('span', { class: 'badge badge-live' }, 'RUNNING') : null,
          s.orphan && !s.live ? el('span', { class: 'badge badge-warn' }, 'orphan') : null,
          s.unattached ? el('span', { class: 'badge badge-info' }, 'unattached') : null,
          el('span', { class: 'mono' }, label),
          el('span', { class: 'faint mono', style: { fontWeight: '400', fontSize: '11px' } }, s.project.id)
        ),
        el('div', { class: 'desc' },
          known
            ? 'The session that owns this still exists.'
            : s.unattached
              ? 'A bare directory with no session id above it.'
              : 'The session transcript is gone; nothing will read these files again.'),
        el('div', { class: 'row-facts' },
          el('span', {}, el('b', {}, 'total'), ' ', formatBytes(s.bytes)),
          el('span', {}, el('b', {}, 'scratchpad'), ' ', `${s.scratchFiles} file${s.scratchFiles === 1 ? '' : 's'} · ${formatBytes(s.scratchBytes)}`),
          el('span', {}, el('b', {}, 'tasks'), ' ', `${s.taskFiles} output${s.taskFiles === 1 ? '' : 's'} · ${formatBytes(s.taskBytes)}`),
          el('span', {}, relativeTime(s.mtime))
        ),
        browser(s)
      ),
      el('div', { style: { flex: 'none' } }, pathActions(s.path, { always: true }))
    )
  );
}

/** Lazy directory browser: contents load when the disclosure is opened. */
function browser(s) {
  const dirs = [
    s.scratchDir ? { label: 'scratchpad/', path: s.scratchDir, files: s.scratchFiles } : null,
    s.tasksDir ? { label: 'tasks/', path: s.tasksDir, files: s.taskFiles } : null,
  ].filter(Boolean);

  return el('div', { style: { marginTop: '9px' } },
    dirs.map((d) => {
      const listing = el('div', { class: 'faint', style: { padding: '9px 12px', fontSize: '12px' } }, 'Loading…');
      const det = el('details', { class: 'tool' },
        el('summary', {},
          el('span', { class: 'tname' }, d.label),
          el('span', { class: 'targ' }, `${d.files} file${d.files === 1 ? '' : 's'}`)
        ),
        listing
      );
      det.addEventListener('toggle', async () => {
        if (!det.open || det.dataset.loaded) return;
        det.dataset.loaded = '1';
        try {
          const entries = await window.api.scratchList(d.path);
          mount(listing, entries.length
            ? entries.map((e) => fileRow(e))
            : el('div', { class: 'faint', style: { fontSize: '12px' } }, '(empty)'));
        } catch (err) {
          mount(listing, el('div', { class: 'badge badge-danger' }, cleanError(err)));
        }
      });
      return det;
    })
  );
}

function fileRow(e) {
  const row = el('div', {
    style: {
      display: 'flex', alignItems: 'center', gap: '10px',
      padding: '5px 12px', borderBottom: '1px solid var(--line-soft)',
      cursor: e.isDir ? 'default' : 'pointer',
    },
    onclick: () => { if (!e.isDir) preview(e); },
  },
    el('span', { class: 'mono', style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '12px' } },
      (e.isDir ? '▸ ' : '') + e.name),
    el('span', { class: 'row-when nowrap' }, e.isDir ? `${e.files} files` : ''),
    el('span', { class: 'row-size nowrap' }, formatBytes(e.bytes)),
    el('span', { class: 'row-when nowrap' }, relativeTime(e.mtime)),
    pathActions(e.path)
  );

  if (e.isDir) {
    // Nested directories expand in place rather than opening a new pane.
    const inner = el('div', { style: { paddingLeft: '18px' } });
    const det = el('details', {},
      el('summary', { style: { listStyle: 'none', cursor: 'pointer' } }, row),
      inner
    );
    det.addEventListener('toggle', async () => {
      if (!det.open || det.dataset.loaded) return;
      det.dataset.loaded = '1';
      const entries = await window.api.scratchList(e.path);
      mount(inner, entries.length ? entries.map(fileRow) : el('div', { class: 'faint', style: { padding: '5px 12px', fontSize: '12px' } }, '(empty)'));
    });
    return det;
  }
  return row;
}

async function preview(entry) {
  try {
    const r = await window.api.scratchReadFile(entry.path);
    set({ openScratch: { ...entry, ...r } });
  } catch (err) {
    toast(cleanError(err), 'err');
  }
}

/** The preview overlay for a single scratchpad file. */
export function renderScratchOverlay() {
  const f = store.openScratch;
  const box = document.getElementById('overlay');
  if (!f) return;

  box.hidden = false;
  const close = () => { box.hidden = true; set({ openScratch: null }); };
  box.onclick = (e) => { if (e.target === box) close(); };

  mount(box, el('div', { class: 'drawer' },
    el('div', { class: 'drawer-head' },
      el('div', { style: { minWidth: 0, flex: 1 } },
        el('h2', {}, f.name),
        el('div', { class: 'sub mono' }, f.path),
        el('div', { class: 'row-facts', style: { marginTop: '5px' } },
          el('span', {}, formatBytes(f.bytes)),
          el('span', {}, relativeTime(f.mtime)),
          f.truncated ? el('span', { class: 'badge badge-warn' }, 'truncated preview') : null,
          f.binary ? el('span', { class: 'badge badge-info' }, 'binary') : null
        )
      ),
      el('div', { style: { display: 'flex', gap: '7px', flex: 'none' } },
        el('button', { class: 'btn btn-sm', onclick: () => window.api.openFolder(f.path) }, 'Open folder'),
        el('button', {
          class: 'btn btn-sm',
          onclick: async () => { await window.api.copyText(f.path); toast('Path copied to clipboard.', 'ok'); },
        }, 'Copy path'),
        el('button', { class: 'btn btn-sm', onclick: close }, 'Close')
      )
    ),
    el('div', { class: 'drawer-body' },
      f.binary
        ? emptyState('▤', 'Binary file', 'This file is not text, so there is nothing useful to show. Open it in its own application instead.')
        : el('pre', {
            style: {
              margin: 0, padding: '14px', background: 'var(--bg-sunken)',
              border: '1px solid var(--line)', borderRadius: 'var(--radius-sm)',
              font: '12px/1.6 var(--mono)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
            },
          }, f.text || '(empty file)'),
      f.truncated
        ? el('div', { class: 'trunc', style: { marginTop: '8px', borderRadius: 'var(--radius-sm)' } },
            'Preview truncated — open the file directly to see the rest.')
        : null
    )
  ));
}

function emptiesCard(empties) {
  const deletable = empties.filter((s) => !s.live);
  return el('div', { class: 'card' },
    el('h3', {},
      `${empties.length} empty scratchpad director${empties.length === 1 ? 'y' : 'ies'}`,
      el('span', { class: 'badge badge-mute' }, '0 B')
    ),
    el('div', { class: 'desc' },
      'Created for a session that never wrote a temporary file. They cost no space, only clutter.'),
    el('details', { class: 'tool' },
      el('summary', {},
        el('span', { class: 'tname' }, 'Show'),
        el('span', { class: 'targ' }, `${deletable.length} selectable`)
      ),
      el('div', { style: { padding: '4px 12px 10px' } },
        empties.map((s) =>
          el('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', padding: '4px 0' } },
            el('input', {
              type: 'checkbox',
              checked: store.selected.has(s.id),
              disabled: s.live,
              onchange: (e) => toggleSelected(s.id, e.target.checked),
            }),
            el('span', { class: 'mono', style: { flex: 1, minWidth: 0, fontSize: '11.5px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
              `${s.project.id}/${s.sessionId || s.path.split(/[\\/]/).pop()}`),
            s.live ? el('span', { class: 'badge badge-live' }, 'RUNNING') : null,
            el('span', { class: 'row-when nowrap' }, relativeTime(s.mtime)),
            pathActions(s.path)
          )
        )
      )
    )
  );
}

function looseCard(loose) {
  return el('div', { class: 'card' },
    el('h3', {}, 'Loose files in the scratchpad root'),
    el('div', { class: 'desc' }, 'Not owned by any one session directory.'),
    loose.map((l) =>
      el('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', padding: '5px 0' } },
        el('input', {
          type: 'checkbox',
          checked: store.selected.has(l.id),
          disabled: l.reserved,
          title: l.reserved ? 'Claude Code payload — not session data' : 'Select',
          onchange: (e) => toggleSelected(l.id, e.target.checked),
        }),
        el('div', { style: { flex: 1, minWidth: 0 } },
          el('div', { class: 'mono', style: { fontSize: '12px' } },
            l.name,
            l.reserved ? el('span', { class: 'badge badge-mute', style: { marginLeft: '7px' } }, 'reserved') : null,
            l.orphan ? el('span', { class: 'badge badge-warn', style: { marginLeft: '7px' } }, 'orphan') : null),
          el('div', { class: 'row-sub' }, l.note)
        ),
        el('span', { class: 'row-size nowrap' }, formatBytes(l.bytes)),
        pathActions(l.path)
      )
    )
  );
}

async function deleteSelected(sessions) {
  const sp = store.scan?.scratchpads;
  const pool = [...sessions, ...(sp?.loose || []).map((l) => ({ ...l, project: { id: 'root' } }))];
  const chosen = pool.filter((s) => store.selected.has(s.id));
  if (!chosen.length) return;

  const bytes = chosen.reduce((n, s) => n + s.bytes, 0);
  const withContent = chosen.filter((s) => s.bytes > 0);
  const stillLinked = chosen.filter((s) => s.sessionId && store.scan?.sessionIds?.includes(s.sessionId));

  const ok = await window.api.confirm({
    title: 'Move scratchpads to trash',
    message: `Move ${chosen.length} scratchpad item${chosen.length === 1 ? '' : 's'} (${formatBytes(bytes)}) to the trash?`,
    detail:
      (stillLinked.length
        ? `Note: ${stillLinked.length} of these belong to a session whose transcript still exists.\n\n`
        : '') +
      (withContent.length
        ? `${withContent.length} contain files:\n` +
          withContent.slice(0, 10).map((s) => `• ${(s.sessionId || s.name || '').slice(0, 8)} — ${formatBytes(s.bytes)}`).join('\n') +
          (withContent.length > 10 ? `\n… and ${withContent.length - 10} more` : '') + '\n\n'
        : 'All of these are empty directories.\n\n') +
      'Everything is restorable from the Trash tab.',
    confirmLabel: 'Move to trash',
    danger: true,
  });
  if (!ok) return;

  const results = await window.api.deletePaths(
    chosen.map((s) => ({
      id: s.id,
      kind: 'cruft',
      label: `Scratchpad ${(s.sessionId || s.name || '').slice(0, 8) || s.path.split(/[\\/]/).pop()}`,
      paths: [s.path],
      context: { scratchpad: true, sessionId: s.sessionId || '', projectId: s.project?.id },
    }))
  );
  reportResults(results, 'scratchpad');
}
