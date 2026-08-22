// Sessions view: project sidebar on the left, session rows on the right.
//
// A row's job is to answer "is this worth keeping?" without opening it, so it
// leads with the AI-generated title and carries message counts, tool volume,
// model, branch, and the full on-disk footprint including satellites.

import { el, mount, formatBytes, formatNumber, relativeTime, formatDuration, shortModel, emptyState, toast, cleanError, pathActions } from '../dom.js';
import { store, set, toggleSelected, clearSelection, activeProjects, allSessions } from '../state.js';
import { openTranscript } from './transcript.js';

export function renderSessions(root) {
  mount(root, sidebar(), pane());
}

function sidebar() {
  const projects = store.scan?.projects || [];
  const totalSessions = projects.reduce((n, p) => n + p.sessionCount, 0);

  const item = (id, name, meta, opts = {}) =>
    el('button', {
      class: 'proj',
      'aria-current': String(store.projectId === id),
      onclick: () => {
        clearSelection();
        set({ projectId: id });
      },
    },
      el('div', { class: 'proj-name' },
        opts.live ? el('span', { class: 'dot dot-live', title: `${opts.live} running` }) : null,
        el('span', { class: 'txt' }, name),
        opts.missing ? el('span', { class: 'badge badge-warn', title: 'The working directory no longer exists' }, 'gone') : null
      ),
      el('div', { class: 'proj-meta' }, meta)
    );

  return el('aside', { class: 'sidebar' },
    el('div', { class: 'sidebar-title' }, 'Projects'),
    item(null, 'All projects', `${totalSessions} sessions · ${formatBytes(projects.reduce((n, p) => n + p.totalBytes, 0))}`),
    projects.map((p) =>
      item(
        p.id,
        p.realPath.split(/[\\/]/).filter(Boolean).pop() || p.id,
        `${p.sessionCount} sess · ${formatBytes(p.totalBytes)}`,
        { live: p.liveCount, missing: !p.cwdExists }
      )
    )
  );
}

function sortSessions(list) {
  const copy = [...list];
  switch (store.sessionSort) {
    case 'largest': return copy.sort((a, b) => b.totalBytes - a.totalBytes);
    case 'longest': return copy.sort((a, b) => (b.counts.user + b.counts.assistant) - (a.counts.user + a.counts.assistant));
    case 'oldest': return copy.sort((a, b) => (a.lastTs || '').localeCompare(b.lastTs || ''));
    default: return copy.sort((a, b) => (b.lastTs || '').localeCompare(a.lastTs || ''));
  }
}

function pane() {
  const projects = activeProjects();
  const sessions = sortSessions(allSessions());
  const scope = store.projectId ? projects[0] : null;

  const selectable = sessions.filter((s) => !s.live);
  const allChecked = selectable.length > 0 && selectable.every((s) => store.selected.has(s.id));

  const head = el('div', { class: 'pane-head' },
    el('div', { style: { minWidth: 0 } },
      el('h2', {}, scope ? (scope.realPath.split(/[\\/]/).filter(Boolean).pop() || scope.id) : 'All projects'),
      el('div', { class: 'sub' }, scope ? scope.realPath : `${projects.length} projects in ~/.claude/projects`)
    ),
    el('div', { class: 'actions' },
      el('select', {
        class: 'btn btn-sm',
        onchange: (e) => set({ sessionSort: e.target.value }),
      },
        ...[['recent', 'Most recent'], ['oldest', 'Oldest first'], ['largest', 'Largest'], ['longest', 'Most messages']]
          .map(([v, label]) => el('option', { value: v, selected: store.sessionSort === v }, label))
      ),
      scope ? el('button', {
        class: 'btn btn-sm',
        title: `Open the Claude data directory for this project:
${scope.dir}`,
        onclick: () => window.api.openPath(scope.dir),
      }, 'Open data dir') : null,
      scope ? el('button', {
        class: 'btn btn-sm',
        disabled: !scope.cwdExists,
        title: scope.cwdExists
          ? `Open the working directory this project tracks:
${scope.realPath}`
          : `${scope.realPath} no longer exists`,
        onclick: () => window.api.openPath(scope.realPath),
      }, 'Open working dir') : null,
      scope ? el('button', {
        class: 'btn btn-sm btn-danger',
        title: 'Move this entire project directory to the trash',
        onclick: () => deleteProject(scope),
      }, 'Delete project') : null
    )
  );

  const bar = store.selected.size
    ? el('div', { class: 'selbar' },
        el('span', { class: 'info' }, `${store.selected.size} selected`),
        el('span', { class: 'faint mono' }, formatBytes(
          sessions.filter((s) => store.selected.has(s.id)).reduce((n, s) => n + s.totalBytes, 0)
        ) + ' on disk'),
        el('span', { class: 'grow' }),
        el('button', { class: 'btn btn-sm', onclick: () => { clearSelection(); set({}); } }, 'Clear'),
        el('button', { class: 'btn btn-sm btn-danger', onclick: () => deleteSelected(sessions) }, 'Move to trash')
      )
    : null;

  const body = el('div', { class: 'pane-body flush' });

  if (!sessions.length) {
    body.append(emptyState('◌', 'No sessions here',
      scope ? 'This project directory holds memories but no transcripts.' : 'No transcripts found under ~/.claude/projects.'));
  } else {
    body.append(
      el('div', { class: 'row', style: { background: 'var(--panel-2)', cursor: 'default', padding: '7px 20px' } },
        el('div', { class: 'row-check' },
          el('input', {
            type: 'checkbox',
            checked: allChecked,
            title: 'Select all (running sessions are excluded)',
            onchange: (e) => {
              for (const s of selectable) {
                if (e.target.checked) store.selected.add(s.id);
                else store.selected.delete(s.id);
              }
              set({});
            },
          })
        ),
        el('div', { class: 'row-main faint', style: { fontSize: '11px' } },
          `${sessions.length} session${sessions.length === 1 ? '' : 's'}` +
          (sessions.length - selectable.length ? ` · ${sessions.length - selectable.length} running and protected` : ''))
      ),
      el('div', { class: 'rows' }, sessions.map(sessionRow))
    );
  }

  return el('section', { class: 'pane' }, head, bar, body);
}

function sessionRow(s) {
  const title = s.title || s.firstPrompt?.trim() || s.lastPrompt?.trim() || '(untitled session)';
  const messages = s.counts.user + s.counts.assistant;
  const models = Object.keys(s.models).filter((m) => m && m !== '<synthetic>').map(shortModel);
  const duration = s.firstTs && s.lastTs ? Date.parse(s.lastTs) - Date.parse(s.firstTs) : 0;

  const fact = (label, value) => el('span', {}, el('b', {}, label), ' ', value);

  return el('div', {
    class: `row${store.selected.has(s.id) ? ' selected' : ''}${store.openSession === s.id ? ' active' : ''}`,
    onclick: (e) => {
      if (e.target.closest('input,button')) return;
      openTranscript(s);
    },
  },
    el('div', { class: 'row-check' },
      el('input', {
        type: 'checkbox',
        checked: store.selected.has(s.id),
        disabled: s.live,
        title: s.live ? 'Running sessions cannot be deleted' : 'Select',
        onchange: (e) => toggleSelected(s.id, e.target.checked),
      })
    ),
    el('div', { class: 'row-main' },
      el('div', { class: 'row-title' },
        s.live ? el('span', { class: 'badge badge-live' }, 'RUNNING') : null,
        el('span', { class: 'txt' }, title),
        s.malformed ? el('span', { class: 'badge badge-warn', title: `${s.malformed} unparseable lines` }, 'partial') : null
      ),
      el('div', { class: 'row-sub' }, s.lastPrompt || s.firstPrompt || ''),
      el('div', { class: 'row-facts' },
        fact('msgs', formatNumber(messages)),
        s.counts.toolUse ? fact('tools', formatNumber(s.counts.toolUse)) : null,
        s.subagentCount ? fact('agents', s.subagentCount) : null,
        s.tokens.output ? fact('out', formatNumber(s.tokens.output) + ' tok') : null,
        duration ? fact('span', formatDuration(duration)) : null,
        models.length ? fact('model', models.join(', ')) : null,
        s.gitBranch ? fact('branch', s.gitBranch) : null,
        el('span', { class: 'faint' }, s.id.slice(0, 8))
      )
    ),
    el('div', { class: 'row-right' },
      el('div', { class: 'row-size' }, formatBytes(s.totalBytes)),
      el('div', { class: 'row-when' }, relativeTime(s.lastTs || s.mtime)),
      pathActions(s.jsonlPath),
      s.satellites.length > 1
        ? el('div', { class: 'row-when faint', title: s.satellites.map((x) => `${x.label}: ${formatBytes(x.bytes)}`).join('\n') },
            `+${s.satellites.length} extras`)
        : null
    )
  );
}

async function deleteSelected(sessions) {
  const chosen = sessions.filter((s) => store.selected.has(s.id));
  if (!chosen.length) return;

  const bytes = chosen.reduce((n, s) => n + s.totalBytes, 0);
  const satellites = chosen.reduce((n, s) => n + s.satellites.length, 0);
  const ok = await window.api.confirm({
    title: 'Move sessions to trash',
    message: `Move ${chosen.length} session${chosen.length === 1 ? '' : 's'} to the trash?`,
    detail:
      `${formatBytes(bytes)} across ${chosen.length} transcript${chosen.length === 1 ? '' : 's'} and ${satellites} satellite folder${satellites === 1 ? '' : 's'} ` +
      `(tool results, subagent transcripts, file history, session env).\n\n` +
      `Nothing is erased — everything moves to ~/.claude/.manager-trash and can be restored from the Trash tab.`,
    confirmLabel: 'Move to trash',
    danger: true,
  });
  if (!ok) return;

  const results = await window.api.deleteSessions(chosen.map((s) => s.id));
  reportResults(results, 'session');
}

async function deleteProject(project) {
  const ok = await window.api.confirm({
    title: 'Delete project',
    message: `Move the entire "${project.realPath}" project directory to the trash?`,
    detail:
      `${project.sessionCount} session${project.sessionCount === 1 ? '' : 's'} and ${project.memory.count} memor${project.memory.count === 1 ? 'y' : 'ies'}, ` +
      `${formatBytes(project.totalBytes)} in total.\n\n` +
      `This removes Claude's history and memories for that directory. Your actual code at ${project.realPath} is untouched. ` +
      `Everything is restorable from the Trash tab.`,
    confirmLabel: 'Move to trash',
    danger: true,
  });
  if (!ok) return;
  try {
    await window.api.deleteProject(project.id);
    toast('Project moved to trash.', 'ok');
    set({ projectId: null });
    window.dispatchEvent(new CustomEvent('cm:rescan'));
  } catch (err) {
    toast(cleanError(err), 'err');
  }
}

export function reportResults(results, noun) {
  const ok = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  if (ok) toast(`${ok} ${noun}${ok === 1 ? '' : 's'} moved to trash.`, 'ok');
  for (const f of failed) toast(cleanError(f.error), 'err');
  clearSelection();
  window.dispatchEvent(new CustomEvent('cm:rescan'));
}
