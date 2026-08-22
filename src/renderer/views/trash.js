// Trash view: everything this tool has deleted, and the way back.

import { el, mount, formatBytes, formatDateTime, relativeTime, emptyState, toast, cleanError, pathRow } from '../dom.js';
import { store, set } from '../state.js';

export function renderTrash(root) {
  const entries = store.trash || [];
  const bytes = entries.reduce((n, e) => n + e.bytes, 0);

  const head = el('div', { class: 'pane-head' },
    el('div', {},
      el('h2', {}, 'Trash'),
      el('div', { class: 'sub' },
        entries.length
          ? `${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} · ${formatBytes(bytes)} recoverable`
          : 'Nothing deleted yet')
    ),
    el('div', { class: 'actions' },
      store.scan?.trashDir
        ? el('button', {
            class: 'btn btn-sm',
            title: `Open the trash directory:
${store.scan.trashDir}`,
            onclick: () => window.api.openPath(store.scan.trashDir),
          }, 'Open trash dir')
        : null,
      entries.length
        ? el('button', { class: 'btn btn-sm btn-danger', onclick: purgeAll }, 'Empty trash')
        : null
    )
  );

  const body = el('div', { class: 'pane-body' });

  if (!entries.length) {
    body.append(emptyState('◌', 'Trash is empty',
      'Anything you delete moves here first, with its original location recorded, so it can be put back exactly where it was.'));
  } else {
    body.append(el('div', { class: 'card', style: { background: 'var(--panel-2)' } },
      el('div', { class: 'desc', style: { margin: 0 } },
        'Deleted items live in ~/.claude/.manager-trash until you empty the trash. Restore puts every path back where it came from.')
    ));
    for (const e of entries) body.append(entryCard(e));
  }

  mount(root, el('section', { class: 'pane' }, head, body));
}

const KIND_LABEL = {
  session: 'Session',
  memory: 'Memory',
  project: 'Project',
  cruft: 'Ancillary data',
  sidecar: 'Session data',
};

function entryCard(e) {
  const blocked = e.conflicts?.length > 0;

  return el('div', { class: 'card' },
    el('div', { style: { display: 'flex', gap: '12px', alignItems: 'flex-start' } },
      el('div', { style: { flex: '1', minWidth: 0 } },
        el('h3', {},
          el('span', { class: 'badge badge-mute' }, KIND_LABEL[e.kind] || e.kind),
          el('span', { class: 'txt' }, e.label || '(unnamed)'),
          blocked ? el('span', { class: 'badge badge-warn' }, 'path in use') : null
        ),
        el('div', { class: 'row-facts' },
          el('span', {}, formatBytes(e.bytes)),
          el('span', {}, `${e.paths.length} path${e.paths.length === 1 ? '' : 's'}`),
          el('span', { title: formatDateTime(e.deletedAt) }, 'deleted ' + relativeTime(e.deletedAt)),
          e.context?.messages ? el('span', {}, el('b', {}, 'msgs'), ' ', e.context.messages) : null,
          e.context?.projectPath ? el('span', { class: 'mono faint' }, e.context.projectPath) : null
        ),
        el('details', { class: 'tool', style: { marginTop: '9px' } },
          el('summary', {},
            el('span', { class: 'tname' }, 'Original locations'),
            el('span', { class: 'targ' }, e.paths.map((p) => p.from.split(/[\\/]/).pop()).join(', '))
          ),
          el('pre', {}, e.paths.map((p) => `${p.from}${p.isDir ? '  (folder)' : ''}  —  ${formatBytes(p.bytes)}`).join('\n'))
        ),
        blocked
          ? el('div', { class: 'issue sev-warn', style: { marginTop: '9px' } },
              el('div', { class: 'body' },
                el('div', { class: 't' }, 'Something already occupies the original path'),
                el('div', { class: 'd' },
                  `Restore will skip: ${e.conflicts.join(', ')}. Move or remove those first if you want the original back.`)
              )
            )
          : null
      ),
      el('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px', flex: 'none' } },
        el('button', { class: 'btn btn-sm btn-accent', onclick: () => restore(e) }, 'Restore'),
        el('button', { class: 'btn btn-sm btn-danger', onclick: () => purge(e) }, 'Delete forever')
      )
    )
  );
}

async function restore(e) {
  try {
    const r = await window.api.trashRestore(e.id);
    if (r.restored.length) toast(`Restored ${r.restored.length} path${r.restored.length === 1 ? '' : 's'}.`, 'ok');
    if (r.skipped.length) toast(`Skipped ${r.skipped.length} path${r.skipped.length === 1 ? '' : 's'} — something already exists there.`, 'err');
    window.dispatchEvent(new CustomEvent('cm:rescan'));
  } catch (err) {
    toast(cleanError(err), 'err');
  }
}

async function purge(e) {
  const ok = await window.api.confirm({
    title: 'Delete permanently',
    message: `Permanently delete "${e.label}"?`,
    detail: `${formatBytes(e.bytes)} across ${e.paths.length} path${e.paths.length === 1 ? '' : 's'}. This cannot be undone.`,
    confirmLabel: 'Delete forever',
    danger: true,
  });
  if (!ok) return;
  await window.api.trashPurge(e.id);
  toast('Permanently deleted.', 'ok');
  window.dispatchEvent(new CustomEvent('cm:rescan'));
}

async function purgeAll() {
  const entries = store.trash || [];
  const bytes = entries.reduce((n, e) => n + e.bytes, 0);
  const ok = await window.api.confirm({
    title: 'Empty trash',
    message: `Permanently delete all ${entries.length} trashed item${entries.length === 1 ? '' : 's'}?`,
    detail: `${formatBytes(bytes)} will be erased. This cannot be undone.`,
    confirmLabel: 'Empty trash',
    danger: true,
  });
  if (!ok) return;
  const r = await window.api.trashPurgeAll();
  toast(`Emptied trash — ${formatBytes(r.bytes)} freed.`, 'ok');
  window.dispatchEvent(new CustomEvent('cm:rescan'));
}
