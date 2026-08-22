// A single mutable store with subscriber notification. The app is small enough
// that a full re-render of the active view on every change is imperceptible,
// and it removes any chance of the list and the selection drifting apart.

export const store = {
  scan: null,
  loading: false,
  tab: 'sessions',
  projectId: null,        // null = every project
  selected: new Set(),    // ids of checked rows in the active view
  openSession: null,
  openMemory: null,
  memoryFilter: 'all',
  scratchProject: null,   // scratchpad view scope
  openScratch: null,      // scratchpad file being previewed
  settings: null,
  sweepDays: null,
  sweepCats: null,
  sweepPlan: null,
  sweepChosen: null,
  sweepLoading: false,
  sweepCategoryDefs: [],
  sessionSort: 'recent',
  showThinking: true,
  trash: [],
};

const listeners = new Set();

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function set(patch) {
  Object.assign(store, patch);
  emit();
}

export function emit() {
  for (const fn of listeners) fn(store);
}

/** Selection is per-view, so switching tabs or projects clears it. */
export function clearSelection() {
  store.selected = new Set();
}

export function toggleSelected(id, on) {
  if (on === undefined) on = !store.selected.has(id);
  if (on) store.selected.add(id);
  else store.selected.delete(id);
  emit();
}

export function allProjects() {
  return store.scan?.projects || [];
}

export function activeProjects() {
  const list = allProjects();
  return store.projectId ? list.filter((p) => p.id === store.projectId) : list;
}

export function allSessions() {
  return activeProjects().flatMap((p) => p.sessions.map((s) => ({ ...s, project: p })));
}

export function findSession(id) {
  for (const p of allProjects()) {
    const s = p.sessions.find((x) => x.id === id);
    if (s) return { ...s, project: p };
  }
  return null;
}
