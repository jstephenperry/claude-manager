// Memories view: the files, their health, an editor, and MEMORY.md repair.
//
// Health is the point. Memory drift (a file no index line points at, an index
// line pointing at nothing, a [[link]] that resolves nowhere) is invisible in
// a file browser and is exactly what makes a memory directory rot, so issues
// are surfaced above the files rather than hidden behind a filter.
//
// An orphaned index link is the one kind of drift with a mechanical fix, and
// the one this app causes itself every time it trashes a memory. So it is not
// only reported: `repair.js` plans the edit, this view shows every line it
// would change before anything is written, and the write is undoable.

import { el, mount, formatBytes, relativeTime, emptyState, toast, cleanError, pathRow, pathActions } from '../dom.js';
import { store, set, toggleSelected, clearSelection, activeProjects } from '../state.js';
import { reportResults } from './sessions.js';

/** Repairs are keyed by directory as well as id: one pass can span several
 *  projects, and line numbers repeat across their MEMORY.md files. */
const repairKey = (dir, id) => `${dir} ${id}`;
const shortName = (p) => p.realPath.split(/[\\/]/).filter(Boolean).pop() || p.id;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const samePath = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();

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
        set({ projectId: id, openMemory: null, memoryRepair: null });
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
            shortName(p),
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
      el('h2', {}, scope ? shortName(scope) : 'All memories'),
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
      el('label', {
        class: 'btn btn-sm btn-ghost',
        title: 'When a memory is trashed, drop the MEMORY.md line that pointed at it. The delete dialog lists every line first.',
      },
        el('input', {
          type: 'checkbox',
          checked: store.settings?.repairIndexOnDelete !== false,
          style: { marginRight: '6px' },
          onchange: async (e) => {
            const next = await window.api.setSettings({ repairIndexOnDelete: e.target.checked });
            set({ settings: next });
          },
        }),
        'Fix index on delete'
      ),
      scope && scope.memory.hasIndex
        ? el('button', {
            class: 'btn btn-sm',
            title: `Edit the index by hand:
${scope.memory.indexPath}`,
            onclick: () => openEditor({ name: 'MEMORY.md', path: scope.memory.indexPath }),
          }, 'Edit MEMORY.md')
        : null,
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
  if (store.memoryRepair) body.append(repairCard());

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
  const orphaned = sorted.filter((i) => i.kind === 'dangling-index');

  return el('div', { class: 'card' },
    el('h3', {},
      `${issues.length} memory issue${issues.length === 1 ? '' : 's'}`,
      counts.error ? el('span', { class: 'badge badge-danger' }, `${counts.error} broken`) : null,
      counts.warn ? el('span', { class: 'badge badge-warn' }, `${counts.warn} warning`) : null,
      counts.info ? el('span', { class: 'badge badge-info' }, `${counts.info} note`) : null,
      el('span', { style: { flex: '1' } }),
      orphaned.length
        ? el('button', {
            class: 'btn btn-sm btn-accent',
            title: 'Work out what each orphaned index link should say, and show the edit before making it',
            onclick: () => openRepair([...new Map(orphaned.map((i) => [i.project.id, i.project])).values()]),
          }, `Repair ${plural(orphaned.length, 'orphaned link', 'orphaned links')}`)
        : null
    ),
    el('div', { class: 'desc' }, 'Drift between the memory files, the MEMORY.md index, and the sessions they came from.'),
    sorted.map((i) =>
      el('div', { class: `issue sev-${i.severity}` },
        el('div', { class: 'body' },
          el('div', { class: 't' }, i.title,
            !store.projectId
              ? el('span', { class: 'faint mono', style: { fontWeight: '400' } }, shortName(i.project))
              : null
          ),
          el('div', { class: 'd' }, i.detail)
        ),
        i.kind === 'dangling-index'
          ? el('button', {
              class: 'btn btn-sm',
              style: { flex: 'none' },
              title: 'Plan a fix for this one line',
              onclick: () => openRepair([i.project], i),
            }, 'Fix')
          : null,
        i.paths?.length ? pathActions(i.paths[0], { always: true }) : null
      )
    )
  );
}

// ---- MEMORY.md repair -------------------------------------------------------

/**
 * Build a repair plan for every memory directory in scope. `focus` narrows the
 * initial selection to one issue, for the per-issue Fix button; otherwise the
 * high-confidence repairs start selected and the guesses do not.
 */
async function openRepair(projects, focus) {
  const targets = projects.filter((p) => p.memory?.exists && p.memory.hasIndex);
  if (!targets.length) return;

  set({ memoryRepair: { loading: true, plans: [], chosen: new Set(), results: null } });
  const plans = [];
  for (const p of targets) {
    try {
      const plan = await window.api.memoryRepairPlan(p.memory.path);
      if (plan.actions.length || plan.manual.length) plans.push({ ...plan, projectId: p.id, projectName: shortName(p) });
    } catch (err) {
      toast(cleanError(err), 'err');
    }
  }

  const chosen = new Set();
  for (const plan of plans) {
    for (const a of plan.actions) {
      const wanted = focus
        ? samePath(plan.dir, focus.project.memory.path) && a.lineNo === focus.line && a.file === focus.indexFile
        : a.auto;
      if (wanted) chosen.add(repairKey(plan.dir, a.id));
    }
  }
  set({ memoryRepair: { loading: false, plans, chosen, results: null } });
}

function repairCard() {
  const r = store.memoryRepair;
  const close = el('button', { class: 'btn btn-sm', onclick: () => set({ memoryRepair: null }) }, 'Close');

  if (r.loading) {
    return el('div', { class: 'card' }, el('h3', {}, el('span', { class: 'spinning' }, '⟳'), 'Reading MEMORY.md…'));
  }
  if (r.results) return repairResultCard(r.results);

  const actions = r.plans.flatMap((p) => p.actions.map((a) => ({ plan: p, a })));
  const manual = r.plans.flatMap((p) => p.manual.map((m) => ({ plan: p, m })));

  if (!actions.length && !manual.length) {
    return el('div', { class: 'card' },
      el('h3', {}, 'Nothing to repair'),
      el('div', { class: 'desc' }, 'Every link in MEMORY.md resolves to a file that is there.'),
      close);
  }

  const chosen = actions.filter(({ plan, a }) => r.chosen.has(repairKey(plan.dir, a.id)));
  const removing = chosen.filter(({ a }) => a.kind === 'remove').length;

  const select = (pick) => set({
    memoryRepair: {
      ...r,
      chosen: new Set(actions.filter(({ a }) => pick(a)).map(({ plan, a }) => repairKey(plan.dir, a.id))),
    },
  });

  return el('div', { class: 'card', style: { borderColor: 'var(--accent-line)' } },
    el('h3', {}, 'Repair MEMORY.md',
      el('span', { class: 'badge badge-mute' }, plural(actions.length, 'orphaned link', 'orphaned links')),
      manual.length ? el('span', { class: 'badge badge-warn' }, `${manual.length} by hand`) : null),
    el('div', { class: 'desc' },
      'Every line below is rewritten exactly as shown, or dropped. The ones marked "safe" name a file that is ' +
      'plainly still here, or one this app trashed itself, and start selected; the rest are guesses and do not. ' +
      'Nothing is written until you apply, and the write can be undone straight afterwards.'),

    el('div', { style: { display: 'flex', gap: '7px', alignItems: 'center', margin: '10px 0', flexWrap: 'wrap' } },
      el('button', { class: 'btn btn-sm', onclick: () => select((a) => a.auto) }, 'Select safe'),
      el('button', { class: 'btn btn-sm', onclick: () => select(() => true) }, 'Select all'),
      el('button', { class: 'btn btn-sm', onclick: () => select(() => false) }, 'Select none'),
      el('span', { style: { flex: '1' } }),
      el('span', { class: 'faint mono' },
        `${chosen.length} selected${removing ? ` · ${plural(removing, 'line dropped', 'lines dropped')}` : ''}`),
      el('button', {
        class: 'btn btn-sm btn-accent',
        disabled: !chosen.length,
        onclick: () => applyRepairs(),
      }, `Apply ${plural(chosen.length, 'repair', 'repairs')}`),
      close
    ),

    r.plans.map((plan) =>
      el('div', {},
        r.plans.length > 1
          ? el('div', { class: 'row-facts', style: { margin: '12px 0 4px' } },
              el('span', {}, el('b', {}, plan.projectName), ' ', plan.indexPath))
          : null,
        plan.actions.map((a) => repairRow(plan, a)),
        plan.manual.map((m) => manualRow(plan, m))
      )
    )
  );
}

function repairRow(plan, a) {
  const key = repairKey(plan.dir, a.id);

  return el('div', { class: `issue sev-${a.kind === 'remove' ? 'error' : 'info'}` },
    el('input', {
      type: 'checkbox',
      style: { marginTop: '3px', flex: 'none' },
      checked: store.memoryRepair.chosen.has(key),
      onchange: (e) => {
        const next = new Set(store.memoryRepair.chosen);
        if (e.target.checked) next.add(key); else next.delete(key);
        set({ memoryRepair: { ...store.memoryRepair, chosen: next } });
      },
    }),
    el('div', { class: 'body' },
      el('div', { class: 't' },
        a.kind === 'remove' ? 'Drop the line' : `Point at ${a.target}`,
        el('span', { class: `badge ${a.confidence === 'high' ? 'badge-info' : 'badge-warn'}` },
          a.confidence === 'high' ? 'safe' : 'review'),
        el('span', { class: 'faint mono', style: { fontWeight: '400' } }, `line ${a.lineNo}`)
      ),
      el('div', { class: 'd' }, a.reason),
      el('div', { class: 'diff' },
        el('div', { class: 'del' }, `- ${a.before}`),
        a.after === null ? null : el('div', { class: 'add' }, `+ ${a.after}`)
      )
    )
  );
}

function manualRow(plan, m) {
  return el('div', { class: 'issue sev-warn' },
    el('div', { class: 'body' },
      el('div', { class: 't' }, `${m.file} needs a manual edit`,
        el('span', { class: 'faint mono', style: { fontWeight: '400' } }, `line ${m.lineNo}`)),
      el('div', { class: 'd' }, m.reason),
      el('div', { class: 'diff' }, el('div', { class: 'ctx' }, `  ${m.before}`))
    ),
    el('button', {
      class: 'btn btn-sm',
      style: { flex: 'none' },
      onclick: () => openEditor({ name: 'MEMORY.md', path: plan.indexPath }),
    }, 'Edit')
  );
}

function repairResultCard(results) {
  const changed = results.filter((r) => r.changed);
  const skipped = results.flatMap((r) => r.skipped || []);
  const failed = results.filter((r) => r.error);

  return el('div', { class: 'card', style: { borderColor: 'var(--accent-line)' } },
    el('h3', {}, changed.length ? 'MEMORY.md updated' : 'Nothing changed'),
    el('div', { class: 'desc' },
      changed.length
        ? `${plural(changed.reduce((n, r) => n + r.repointed, 0), 'link repointed', 'links repointed')}, ` +
          `${plural(changed.reduce((n, r) => n + r.removed, 0), 'line dropped', 'lines dropped')}. ` +
          'Undo puts the file back exactly as it was.'
        : 'No index line was rewritten.'),

    changed.map((r) =>
      el('div', {},
        pathRow(r.projectName, r.path, { note: `${plural(r.applied.length, 'repair', 'repairs')} applied` }),
        el('div', { class: 'diff' },
          r.applied.map((a) => [
            el('div', { class: 'del' }, `- ${a.before}`),
            a.after === null ? null : el('div', { class: 'add' }, `+ ${a.after}`),
          ])
        )
      )
    ),

    skipped.map((s) => el('div', { class: 'issue sev-warn' }, el('div', { class: 'body' }, el('div', { class: 'd' }, s.reason)))),
    failed.map((f) => el('div', { class: 'issue sev-error' }, el('div', { class: 'body' }, el('div', { class: 'd' }, `${f.projectName}: ${f.error}`)))),

    el('div', { style: { display: 'flex', gap: '7px', marginTop: '10px', flexWrap: 'wrap' } },
      changed.map((r) =>
        el('button', {
          class: 'btn btn-sm',
          title: `Restore ${r.path} to what it was before the repair`,
          onclick: () => undoRepair(r),
        }, changed.length > 1 ? `Undo ${r.projectName}` : 'Undo')
      ),
      el('button', { class: 'btn btn-sm', onclick: () => set({ memoryRepair: null }) }, 'Close')
    )
  );
}

async function applyRepairs() {
  const r = store.memoryRepair;
  const jobs = r.plans
    .map((plan) => ({
      plan,
      ids: plan.actions.filter((a) => r.chosen.has(repairKey(plan.dir, a.id))).map((a) => a.id),
    }))
    .filter((j) => j.ids.length);
  if (!jobs.length) return;

  const results = [];
  for (const j of jobs) {
    try {
      const res = await window.api.memoryRepairApply(j.plan.dir, j.ids);
      results.push({ ...res, dir: j.plan.dir, projectName: j.plan.projectName });
    } catch (err) {
      results.push({
        dir: j.plan.dir, projectName: j.plan.projectName,
        changed: false, applied: [], skipped: [], repointed: 0, removed: 0,
        error: cleanError(err),
      });
    }
  }

  const repointed = results.reduce((n, x) => n + (x.repointed || 0), 0);
  const removed = results.reduce((n, x) => n + (x.removed || 0), 0);
  if (repointed || removed) {
    toast(`MEMORY.md updated — ${plural(repointed, 'link repointed', 'links repointed')}, ${plural(removed, 'line dropped', 'lines dropped')}.`, 'ok');
  }
  for (const f of results.filter((x) => x.error)) toast(f.error, 'err');

  set({ memoryRepair: { loading: false, plans: [], chosen: new Set(), results } });
  window.dispatchEvent(new CustomEvent('cm:rescan'));
}

async function undoRepair(result) {
  try {
    await window.api.writeMemoryFile(result.path, result.before);
    toast('MEMORY.md restored to what it was before the repair.', 'ok');
    set({ memoryRepair: null });
    window.dispatchEvent(new CustomEvent('cm:rescan'));
  } catch (err) {
    toast(cleanError(err), 'err');
  }
}

// ---- files ------------------------------------------------------------------

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
            ? el('span', { class: 'faint mono', style: { fontWeight: '400', fontSize: '11px' } }, shortName(f.project))
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

/**
 * Delete, and take the index with it. Every MEMORY.md line the delete is about
 * to orphan is planned before the confirm dialog and listed inside it, so the
 * dialog is the preview; the edit itself happens only after the files actually
 * reach the trash, and only for the ones that got there.
 */
async function deleteSelected(files) {
  const chosen = files.filter((f) => store.selected.has(f.path));
  if (!chosen.length) return;

  const byDir = new Map();
  for (const f of chosen) {
    const dir = f.project.memory.path;
    if (!byDir.has(dir)) byDir.set(dir, { project: f.project, paths: [] });
    byDir.get(dir).paths.push(f.path);
  }

  const repairing = store.settings?.repairIndexOnDelete !== false;
  const previews = [];
  if (repairing) {
    for (const [dir, group] of byDir) {
      if (!group.project.memory.hasIndex) continue;
      try {
        const plan = await window.api.memoryRepairPlan(dir, group.paths);
        // Only the lines this delete orphans. Other drift in the same index is
        // the Repair panel's business, not a side effect of a delete.
        const actions = plan.actions.filter((a) => a.via === 'deleting');
        if (actions.length) previews.push({ dir, projectName: shortName(group.project), actions });
      } catch {
        /* a plan we could not build just means the dialog says nothing about it */
      }
    }
  }

  const lines = previews.flatMap((p) => p.actions);
  const ok = await window.api.confirm({
    title: 'Move memories to trash',
    message: `Move ${chosen.length} memor${chosen.length === 1 ? 'y' : 'ies'} to the trash?`,
    detail:
      chosen.map((f) => `• ${f.name} — ${f.description || '(no description)'}`).join('\n') +
      (lines.length
        ? `\n\nMEMORY.md loses ${plural(lines.length, 'index line', 'index lines')} that would otherwise point at nothing:\n` +
          lines.map((a) => `  line ${a.lineNo}: ${a.before.trim()}`).join('\n') +
          `\n\nThat edit is undoable from the Memories tab.`
        : repairing
          ? `\n\nNo MEMORY.md line points at ${chosen.length === 1 ? 'it' : 'them'}, so the index is left alone.`
          : `\n\nMEMORY.md is not rewritten, so its index lines will report as broken until you edit them.`) +
      `\n\nEverything is restorable from the Trash tab.`,
    confirmLabel: 'Move to trash',
    danger: true,
  });
  if (!ok) return;

  const results = await window.api.deleteMemories(chosen.map((f) => f.path));
  const trashed = results.filter((r) => r.ok).map((r) => String(r.id).toLowerCase());

  const repairs = [];
  for (const p of previews) {
    // A delete that failed leaves a file in place, and its index line with it.
    const ids = p.actions.filter((a) => trashed.some((t) => samePath(t, a.path))).map((a) => a.id);
    if (!ids.length) continue;
    try {
      const res = await window.api.memoryRepairApply(p.dir, ids);
      if (res.changed || res.skipped.length) repairs.push({ ...res, dir: p.dir, projectName: p.projectName });
    } catch (err) {
      toast(cleanError(err), 'err');
    }
  }

  const dropped = repairs.reduce((n, r) => n + (r.removed || 0), 0);
  if (dropped) {
    toast(`MEMORY.md updated — ${plural(dropped, 'orphaned index line dropped', 'orphaned index lines dropped')}.`, 'ok');
    set({ memoryRepair: { loading: false, plans: [], chosen: new Set(), results: repairs } });
  }

  reportResults(results, 'memory');
}
