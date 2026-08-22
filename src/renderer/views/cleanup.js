// Cleanup view: the storage nothing else shows you.
//
// Orphans are the honest wins -- file-history and session-env entries whose
// session is gone, sidecar directories whose transcript is gone, registry
// files for processes that exited. Those are preselected. Loose directories
// (cache, backups, shell snapshots) are listed but never preselected, because
// "old" is not the same as "dead".

import { el, mount, formatBytes, relativeTime, emptyState, toast, pathActions } from '../dom.js';
import { store, set, toggleSelected, clearSelection } from '../state.js';
import { reportResults } from './sessions.js';

export function renderCleanup(root) {
  const cruft = store.scan?.cruft;
  const projects = store.scan?.projects || [];
  const orphanSidecars = projects.flatMap((p) =>
    p.orphanSidecars.map((o) => ({ ...o, project: p }))
  );

  const groups = [...(cruft?.groups || [])];
  if (orphanSidecars.length) {
    groups.unshift({
      key: 'orphan-sidecars',
      label: 'Orphaned session data',
      dir: '~/.claude/projects',
      sessionKeyed: true,
      items: orphanSidecars.map((o) => ({
        id: `sidecar:${o.id}`,
        name: o.id,
        path: o.path,
        bytes: o.bytes,
        files: o.files,
        mtime: 0,
        orphan: true,
        live: false,
        note: `Tool results and subagents for a transcript that no longer exists (${o.project.realPath.split(/[\\/]/).filter(Boolean).pop()})`,
      })),
      bytes: orphanSidecars.reduce((n, o) => n + o.bytes, 0),
      orphanCount: orphanSidecars.length,
      orphanBytes: orphanSidecars.reduce((n, o) => n + o.bytes, 0),
    });
  }

  const all = groups.flatMap((g) => g.items);
  const reclaimable = all.filter((i) => i.orphan && !i.live);

  const head = el('div', { class: 'pane-head' },
    el('div', {},
      el('h2', {}, 'Cleanup'),
      el('div', { class: 'sub' },
        `${formatBytes(groups.reduce((n, g) => n + g.bytes, 0))} in ancillary storage · ` +
        `${formatBytes(reclaimable.reduce((n, i) => n + i.bytes, 0))} orphaned`)
    ),
    el('div', { class: 'actions' },
      reclaimable.length
        ? el('button', {
            class: 'btn btn-sm',
            onclick: () => {
              for (const i of reclaimable) store.selected.add(i.id);
              set({});
            },
          }, `Select all ${reclaimable.length} orphans`)
        : null
    )
  );

  const bar = store.selected.size
    ? el('div', { class: 'selbar' },
        el('span', { class: 'info' }, `${store.selected.size} selected`),
        el('span', { class: 'faint mono' },
          formatBytes(all.filter((i) => store.selected.has(i.id)).reduce((n, i) => n + i.bytes, 0))),
        el('span', { class: 'grow' }),
        el('button', { class: 'btn btn-sm', onclick: () => { clearSelection(); set({}); } }, 'Clear'),
        el('button', { class: 'btn btn-sm btn-danger', onclick: () => deleteSelected(all) }, 'Move to trash')
      )
    : null;

  const body = el('div', { class: 'pane-body' });

  if (!groups.length || !all.length) {
    body.append(emptyState('✓', 'Nothing to clean up', 'No ancillary storage found under ~/.claude.'));
  } else {
    for (const g of groups) {
      if (!g.items.length) continue;
      body.append(groupCard(g));
    }
  }

  mount(root, el('section', { class: 'pane' }, head, bar, body));
}

function groupCard(g) {
  const share = g.bytes ? Math.round((g.orphanBytes / g.bytes) * 100) : 0;

  // A group with nothing to reclaim starts collapsed. Otherwise a directory
  // like session-env buries the page in rows that are all "keep this".
  const worthOpening = g.orphanCount > 0;

  return el('div', { class: 'card' },
    el('h3', {},
      g.label,
      el('span', { class: 'badge badge-mute' }, formatBytes(g.bytes)),
      g.orphanCount ? el('span', { class: 'badge badge-warn' }, `${g.orphanCount} orphaned`) : null
    ),
    el('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' } },
      el('div', { class: 'desc mono', style: { fontSize: '11px', margin: 0, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, g.dir),
      g.dir.startsWith('~') ? null : pathActions(g.dir, { always: true })
    ),
    g.orphanBytes
      ? el('div', { class: 'meter' }, el('i', { class: 'warn', style: { width: `${share}%` } }))
      : null,
    el('details', { class: 'tool', style: { marginTop: '10px' }, open: worthOpening || undefined },
      el('summary', {},
        el('span', { class: 'tname' }, worthOpening ? 'Items' : 'Nothing to reclaim'),
        el('span', { class: 'targ' },
          `${g.items.length} item${g.items.length === 1 ? '' : 's'}` +
          (worthOpening ? '' : ' — all belong to sessions that still exist'))
      ),
      el('div', { style: { padding: '4px 12px 10px' } },
      g.items.map((i) =>
        el('div', {
          class: 'row',
          style: { padding: '8px 0', borderBottom: '1px solid var(--line-soft)' },
        },
          el('div', { class: 'row-check' },
            el('input', {
              type: 'checkbox',
              checked: store.selected.has(i.id),
              disabled: i.live,
              title: i.live ? 'This session is running' : 'Select',
              onchange: (e) => toggleSelected(i.id, e.target.checked),
            })
          ),
          el('div', { class: 'row-main' },
            el('div', { class: 'row-title' },
              i.live ? el('span', { class: 'badge badge-live' }, 'RUNNING') : null,
              i.orphan && !i.live ? el('span', { class: 'badge badge-warn' }, 'orphan') : null,
              el('span', { class: 'txt mono', style: { fontSize: '12px' } }, i.name)
            ),
            i.note ? el('div', { class: 'row-sub' }, i.note) : null
          ),
          el('div', { class: 'row-right' },
            el('div', { class: 'row-size' }, formatBytes(i.bytes)),
            el('div', { class: 'row-when' }, i.files === 1 ? '1 file' : `${i.files} files`),
            i.mtime ? el('div', { class: 'row-when' }, relativeTime(i.mtime)) : null
          ),
          pathActions(i.path)
        )
      )
      )
    )
  );
}

async function deleteSelected(all) {
  const chosen = all.filter((i) => store.selected.has(i.id));
  if (!chosen.length) return;

  const bytes = chosen.reduce((n, i) => n + i.bytes, 0);
  const keepers = chosen.filter((i) => !i.orphan);

  const ok = await window.api.confirm({
    title: 'Move to trash',
    message: `Move ${chosen.length} item${chosen.length === 1 ? '' : 's'} (${formatBytes(bytes)}) to the trash?`,
    detail:
      (keepers.length
        ? `Warning: ${keepers.length} of these still belong to an existing session and are not orphaned.\n\n`
        : '') +
      chosen.slice(0, 14).map((i) => `• ${i.name} — ${formatBytes(i.bytes)}`).join('\n') +
      (chosen.length > 14 ? `\n… and ${chosen.length - 14} more` : '') +
      `\n\nEverything is restorable from the Trash tab.`,
    confirmLabel: 'Move to trash',
    danger: true,
  });
  if (!ok) return;

  const results = await window.api.deletePaths(
    chosen.map((i) => ({ id: i.id, kind: 'cruft', label: i.name, paths: [i.path], context: { note: i.note } }))
  );
  reportResults(results, 'item');
}
