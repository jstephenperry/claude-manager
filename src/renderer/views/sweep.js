// The age sweep: "clean everything older than N days".
//
// It always shows the plan before it does anything. A number and a button that
// silently deletes an unknown quantity of data is not a feature you can trust,
// so the flow is threshold -> preview -> confirm, with every candidate listed
// and individually deselectable.

import { el, mount, formatBytes, relativeTime, formatDateTime, emptyState, toast, cleanError, pathActions } from '../dom.js';
import { store, set } from '../state.js';

const CATEGORY_NOTE = {
  memories: 'Off by default. A memory\'s worth has nothing to do with its age — old notes about build quirks are often the most valuable thing here.',
  trash: 'Off by default. Turning this on permanently erases trashed items older than the threshold; they cannot be restored afterwards.',
};

export function renderSweep(root) {
  const plan = store.sweepPlan;
  const s = store.settings || {};
  const days = store.sweepDays ?? s.sweepDays ?? 60;
  const cats = store.sweepCats || new Set(s.sweepCategories || []);

  const head = el('div', { class: 'pane-head' },
    el('div', {},
      el('h2', {}, 'Age sweep'),
      el('div', { class: 'sub' }, 'Move everything untouched for longer than the threshold to the trash')
    ),
    el('div', { class: 'actions' },
      el('label', { class: 'btn btn-sm btn-ghost', title: 'Build the plan automatically each time the app starts' },
        el('input', {
          type: 'checkbox',
          checked: Boolean(s.sweepOnLaunch),
          style: { marginRight: '6px' },
          onchange: async (e) => {
            const next = await window.api.setSettings({ sweepOnLaunch: e.target.checked });
            set({ settings: next });
            toast(e.target.checked
              ? 'The sweep will be previewed on launch. It still asks before deleting.'
              : 'Launch preview disabled.', 'ok');
          },
        }),
        'Preview on launch'
      )
    )
  );

  const body = el('div', { class: 'pane-body' });

  // --- controls ---
  const daysInput = el('input', {
    type: 'number',
    min: '1',
    max: '3650',
    value: String(days),
    class: 'btn btn-sm',
    style: { width: '84px', textAlign: 'right' },
    onchange: (e) => {
      const v = Math.max(1, Math.min(3650, Number(e.target.value) || 60));
      set({ sweepDays: v, sweepPlan: null });
    },
  });

  body.append(el('div', { class: 'card' },
    el('h3', {}, 'Threshold'),
    el('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', margin: '8px 0 4px' } },
      el('span', {}, 'Anything not touched in'),
      daysInput,
      el('span', {}, 'days'),
      ...[30, 60, 90, 180].map((d) =>
        el('button', {
          class: `btn btn-sm${d === days ? ' btn-accent' : ''}`,
          onclick: () => { daysInput.value = String(d); set({ sweepDays: d, sweepPlan: null }); },
        }, `${d}d`)
      ),
      el('span', { class: 'grow', style: { flex: 1 } }),
      el('button', {
        class: 'btn btn-sm btn-accent',
        onclick: () => buildPlan(days, cats),
      }, 'Preview sweep')
    ),
    el('div', { class: 'desc', style: { margin: '6px 0 0' } },
      `Cutoff: anything last touched before ${formatDateTime(Date.now() - days * 86400000)}.`)
  ));

  // --- categories ---
  body.append(el('div', { class: 'card' },
    el('h3', {}, 'What to include'),
    (store.sweepCategoryDefs || []).map((c) =>
      el('div', { style: { display: 'flex', gap: '10px', alignItems: 'flex-start', padding: '5px 0' } },
        el('input', {
          type: 'checkbox',
          style: { marginTop: '3px' },
          checked: cats.has(c.key),
          onchange: async (e) => {
            const next = new Set(cats);
            if (e.target.checked) next.add(c.key); else next.delete(c.key);
            const saved = await window.api.setSettings({ sweepCategories: [...next] });
            set({ sweepCats: next, settings: saved, sweepPlan: null });
          },
        }),
        el('div', { style: { flex: 1, minWidth: 0 } },
          el('div', { style: { fontWeight: '550', fontSize: '12.5px' } },
            c.label,
            CATEGORY_NOTE[c.key] ? el('span', { class: 'badge badge-warn', style: { marginLeft: '7px' } }, 'careful') : null),
          CATEGORY_NOTE[c.key] ? el('div', { class: 'row-sub', style: { whiteSpace: 'normal' } }, CATEGORY_NOTE[c.key]) : null
        )
      )
    )
  ));

  // --- plan ---
  if (store.sweepLoading) {
    body.append(el('div', { class: 'empty' }, el('div', { class: 'big spinning' }, '⟳'), el('h3', {}, 'Building plan…')));
  } else if (plan) {
    body.append(planCard(plan));
  } else {
    body.append(emptyState('◷', 'No plan yet',
      'Set a threshold and choose what to include, then press Preview sweep. Nothing is deleted until you confirm the plan.'));
  }

  mount(root, el('section', { class: 'pane' }, head, body));
}

function planCard(plan) {
  if (!plan.totalCount) {
    return el('div', { class: 'card' },
      el('h3', {}, `Nothing older than ${plan.days} days`),
      el('div', { class: 'desc' },
        `Nothing in the enabled categories has gone untouched that long. ` +
        `${plan.skipped.tooRecent} item${plan.skipped.tooRecent === 1 ? '' : 's'} were too recent` +
        (plan.skipped.live ? `, and ${plan.skipped.live} belong to a running session` : '') + '.')
    );
  }

  const chosen = store.sweepChosen || new Set(plan.items.map((i) => i.id));
  const selected = plan.items.filter((i) => chosen.has(i.id));
  const selBytes = selected.reduce((n, i) => n + i.bytes, 0);

  return el('div', { class: 'card', style: { borderColor: 'var(--accent-line)' } },
    el('h3', {},
      `${plan.totalCount} item${plan.totalCount === 1 ? '' : 's'} older than ${plan.days} days`,
      el('span', { class: 'badge badge-mute' }, formatBytes(plan.totalBytes))
    ),
    el('div', { class: 'desc' },
      `${plan.skipped.live} skipped as belonging to a running session · ${plan.skipped.tooRecent} too recent.` +
      (plan.byCategory.trash ? ' Trashed items in this plan are erased permanently, not re-trashed.' : '')),

    el('div', { class: 'row-facts', style: { margin: '8px 0 12px' } },
      Object.entries(plan.byCategory).map(([k, v]) =>
        el('span', {}, el('b', {}, k), ' ', `${v.count} · ${formatBytes(v.bytes)}`))
    ),

    el('div', { style: { display: 'flex', gap: '7px', alignItems: 'center', marginBottom: '10px' } },
      el('button', {
        class: 'btn btn-sm',
        onclick: () => set({ sweepChosen: new Set(plan.items.map((i) => i.id)) }),
      }, 'Select all'),
      el('button', {
        class: 'btn btn-sm',
        onclick: () => set({ sweepChosen: new Set() }),
      }, 'Select none'),
      el('span', { style: { flex: 1 } }),
      el('span', { class: 'faint mono' }, `${selected.length} selected · ${formatBytes(selBytes)}`),
      el('button', {
        class: 'btn btn-sm btn-danger',
        disabled: !selected.length,
        onclick: () => runSweep(plan, selected),
      }, 'Run sweep')
    ),

    el('div', { class: 'rows', style: { border: '1px solid var(--line)', borderRadius: 'var(--radius-sm)', overflow: 'hidden' } },
      plan.items.map((i) =>
        el('div', { class: 'row', style: { padding: '8px 12px', cursor: 'default' } },
          el('div', { class: 'row-check' },
            el('input', {
              type: 'checkbox',
              checked: chosen.has(i.id),
              onchange: (e) => {
                const next = new Set(chosen);
                if (e.target.checked) next.add(i.id); else next.delete(i.id);
                set({ sweepChosen: next });
              },
            })
          ),
          el('div', { class: 'row-main' },
            el('div', { class: 'row-title' },
              el('span', { class: 'badge badge-mute' }, i.category),
              el('span', { class: 'txt' }, i.label)
            ),
            el('div', { class: 'row-sub' }, i.detail || '')
          ),
          el('div', { class: 'row-right' },
            el('div', { class: 'row-size' }, formatBytes(i.bytes)),
            el('div', { class: 'row-when' }, `${i.ageDays}d old`)
          ),
          i.paths?.length ? pathActions(i.paths[0]) : null
        )
      )
    )
  );
}

async function buildPlan(days, cats) {
  set({ sweepLoading: true, sweepPlan: null, sweepChosen: null });
  try {
    const plan = await window.api.sweepPlan(days, [...cats]);
    set({ sweepPlan: plan, sweepLoading: false, sweepChosen: new Set(plan.items.map((i) => i.id)) });
    await window.api.setSettings({ sweepDays: days });
  } catch (err) {
    set({ sweepLoading: false });
    toast(cleanError(err), 'err');
  }
}

async function runSweep(plan, selected) {
  const purging = selected.filter((i) => i.category === 'trash');
  const ok = await window.api.confirm({
    title: 'Run age sweep',
    message: `Move ${selected.length} item${selected.length === 1 ? '' : 's'} (${formatBytes(selected.reduce((n, i) => n + i.bytes, 0))}) to the trash?`,
    detail:
      `Everything untouched for more than ${plan.days} days in the categories you enabled.\n\n` +
      selected.slice(0, 12).map((i) => `• [${i.category}] ${i.label} — ${formatBytes(i.bytes)}, ${i.ageDays}d old`).join('\n') +
      (selected.length > 12 ? `\n… and ${selected.length - 12} more` : '') +
      (purging.length
        ? `\n\nWARNING: ${purging.length} of these are already in the trash and will be erased PERMANENTLY.`
        : '') +
      `\n\nEverything else is restorable from the Trash tab. Running sessions are never touched.`,
    confirmLabel: 'Run sweep',
    danger: true,
  });
  if (!ok) return;

  try {
    const r = await window.api.sweepRun(selected.map((i) => i.id), plan.days, [...(store.sweepCats || [])]);
    if (r.moved) toast(`Swept ${r.moved} item${r.moved === 1 ? '' : 's'} — ${formatBytes(r.bytes)} reclaimed.`, 'ok');
    if (r.failed) {
      for (const f of r.results.filter((x) => !x.ok)) toast(cleanError(f.error), 'err');
    }
    set({ sweepPlan: null, sweepChosen: null });
    window.dispatchEvent(new CustomEvent('cm:rescan'));
  } catch (err) {
    toast(cleanError(err), 'err');
  }
}
