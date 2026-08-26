// App shell: tabs, the header stat strip, and the scan/render loop.

import { el, mount, formatBytes, formatNumber, toast, cleanError } from './dom.js';
import { store, set, subscribe, clearSelection } from './state.js';
import { renderSessions } from './views/sessions.js';
import { renderMemories } from './views/memories.js';
import { renderCleanup } from './views/cleanup.js';
import { renderTrash } from './views/trash.js';
import { renderScratchpads, renderScratchOverlay } from './views/scratchpads.js';
import { renderSweep } from './views/sweep.js';

const TABS = [
  { id: 'sessions', label: 'Sessions', render: renderSessions },
  { id: 'memories', label: 'Memories', render: renderMemories },
  { id: 'scratchpads', label: 'Scratchpads', render: renderScratchpads },
  { id: 'cleanup', label: 'Cleanup', render: renderCleanup },
  { id: 'sweep', label: 'Sweep', render: renderSweep },
  { id: 'trash', label: 'Trash', render: renderTrash },
];

const viewRoot = document.getElementById('view');
const tabsRoot = document.getElementById('tabs');
const statRoot = document.getElementById('stat-strip');
const refreshBtn = document.getElementById('refresh');

/**
 * Scans are coalesced and serialised. A delete followed by an index repair used
 * to fire two of these on top of the one the handlers had already run; dropping
 * the second while the first was in flight lost its result instead. Now a burst
 * collapses into one scan, and none is thrown away.
 *
 * `force` re-reads the tree from disk. Without it the main process returns the
 * index it already refreshed when it made the change, which is what every
 * post-mutation refresh wants.
 */
let scanTimer = null;
let scanChain = Promise.resolve();
let wantForce = false;

function requestScan(force = false) {
  wantForce = wantForce || force;
  if (scanTimer) return;
  scanTimer = setTimeout(() => {
    scanTimer = null;
    const forceThisRun = wantForce;
    wantForce = false;
    scanChain = scanChain.then(() => rescan(forceThisRun)).catch(() => {});
  }, 40);
}

async function rescan(force = false) {
  set({ loading: true });
  refreshBtn.querySelector('.spin-target').classList.add('spinning');
  try {
    const [scan, trash, settings, cats] = await Promise.all([
      window.api.scan(force),
      window.api.trashList(),
      window.api.getSettings(),
      window.api.sweepCategories(),
    ]);
    set({
      scan,
      trash,
      settings,
      sweepCategoryDefs: cats,
      sweepDays: store.sweepDays ?? settings.sweepDays,
      sweepCats: store.sweepCats ?? new Set(settings.sweepCategories || []),
      loading: false,
    });
    maybeLaunchSweep();
  } catch (err) {
    set({ loading: false });
    toast(`Scan failed: ${cleanError(err)}`, 'err');
  } finally {
    refreshBtn.querySelector('.spin-target').classList.remove('spinning');
  }
}

function renderTabs() {
  const t = store.scan?.totals;
  const counts = {
    sessions: t?.sessions,
    memories: t?.memories,
    scratchpads: store.scan?.scratchpads?.sessionCount,
    cleanup: store.scan?.cruft?.groups.reduce((n, g) => n + g.orphanCount, 0),
    sweep: store.sweepPlan?.totalCount,
    trash: store.trash?.length,
  };
  const alerts = {
    memories: t?.memoryIssues > 0,
    cleanup: counts.cleanup > 0,
    scratchpads: (store.scan?.scratchpads?.orphanCount || 0) > 0,
  };

  mount(tabsRoot, TABS.map((tab) =>
    el('button', {
      class: 'tab',
      role: 'tab',
      'aria-selected': String(store.tab === tab.id),
      onclick: () => {
        clearSelection();
        set({ tab: tab.id, openMemory: null, openScratch: null, memoryRepair: null });
      },
    },
      tab.label,
      counts[tab.id]
        ? el('span', { class: `count${alerts[tab.id] ? ' alert' : ''}` }, formatNumber(counts[tab.id]))
        : null
    )
  ));
}

function renderStats() {
  const t = store.scan?.totals;
  if (!t) return mount(statRoot);

  const stat = (value, label, title) =>
    el('div', { class: 'stat', title: title || '' }, el('b', {}, value), el('span', {}, label));

  mount(statRoot,
    t.liveSessions ? stat(String(t.liveSessions), 'running', 'Sessions attached to a live Claude Code process') : null,
    stat(formatNumber(t.sessions), 'sessions'),
    stat(formatNumber(t.memories), 'memories'),
    stat(formatBytes(t.projectBytes + t.cruftBytes + (t.scratchBytes || 0)), 'on disk',
      'Total size of ~/.claude project data, ancillary storage, and scratchpads'),
    t.reclaimableBytes ? stat(formatBytes(t.reclaimableBytes), 'orphaned', 'Storage belonging to sessions that no longer exist') : null
  );
}

function render() {
  const rootEl = document.getElementById('root-path');
  rootEl.textContent = store.scan?.root || '';
  rootEl.title = store.scan?.root ? `Open ${store.scan.root} in Explorer` : '';
  rootEl.onclick = () => store.scan?.root && window.api.openPath(store.scan.root);
  renderTabs();
  renderStats();

  if (!store.scan) {
    mount(viewRoot, el('div', { class: 'empty', style: { margin: 'auto' } },
      el('div', { class: 'big spinning' }, '⟳'),
      el('h3', {}, 'Reading ~/.claude…')));
    return;
  }

  const tab = TABS.find((t) => t.id === store.tab) || TABS[0];
  tab.render(viewRoot);

  // The scratchpad file preview shares the overlay with the transcript drawer.
  if (store.openScratch) renderScratchOverlay();
}

/**
 * When "Preview on launch" is on, build the sweep plan once at startup and
 * park it on the Sweep tab. It is a preview, never an execution -- the user
 * still confirms before anything moves.
 */
let launchSweepDone = false;
async function maybeLaunchSweep() {
  if (launchSweepDone || !store.settings?.sweepOnLaunch) return;
  launchSweepDone = true;
  try {
    const days = store.sweepDays ?? store.settings.sweepDays ?? 60;
    const cats = [...(store.sweepCats || new Set(store.settings.sweepCategories || []))];
    const plan = await window.api.sweepPlan(days, cats);
    set({ sweepPlan: plan, sweepChosen: new Set(plan.items.map((i) => i.id)) });
    if (plan.totalCount) {
      toast(`Age sweep: ${plan.totalCount} item${plan.totalCount === 1 ? '' : 's'} older than ${days} days (${formatBytes(plan.totalBytes)}). Open the Sweep tab to review.`);
    }
  } catch {
    /* a failed launch preview should not block the app */
  }
}

subscribe(render);
// The button and Ctrl-R mean "re-read the disk"; a rescan after one of our own
// changes just wants the index the main process already brought up to date.
refreshBtn.addEventListener('click', () => requestScan(true));
window.addEventListener('cm:rescan', () => requestScan(false));

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'r') {
    e.preventDefault();
    requestScan(true);
  }
});

render();
requestScan(true);
