// Age-based cleanup: collect everything untouched for longer than N days.
//
// Two rules shape what is eligible, and both are deliberate:
//
// 1. Running sessions are never candidates, and neither is anything belonging
//    to one. Age says nothing about whether a process has the file open.
// 2. Memories are excluded by default. A memory's value has no relationship to
//    its age -- a note written six months ago about a build quirk is exactly
//    the kind of thing worth keeping -- so sweeping them by date would delete
//    the most useful data in the tree. Callers can opt in explicitly.
//
// The sweep never deletes on its own. It returns a plan; the caller decides.

const DAY_MS = 86_400_000;

export const SWEEP_CATEGORIES = [
  { key: 'sessions', label: 'Session transcripts', defaultOn: true },
  { key: 'scratchpads', label: 'Scratchpads & task output', defaultOn: true },
  { key: 'cruft', label: 'Ancillary storage', defaultOn: true },
  { key: 'emptyScratch', label: 'Empty scratchpad directories', defaultOn: true },
  { key: 'trash', label: 'Items already in the trash', defaultOn: false },
  { key: 'memories', label: 'Memories', defaultOn: false },
];

const ageDays = (mtime, now) => (mtime ? Math.floor((now - mtime) / DAY_MS) : null);

/**
 * Build a sweep plan.
 *
 * @param scan     the full scan (projects, cruft, scratchpads)
 * @param trash    current trash entries
 * @param opts.days     age threshold in days
 * @param opts.categories set of enabled category keys
 * @param opts.now      timestamp, injected for testing
 */
export function planSweep(scan, trash, opts = {}) {
  const days = Number(opts.days) > 0 ? Number(opts.days) : 60;
  const now = opts.now ?? Date.now();
  const on = opts.categories instanceof Set
    ? opts.categories
    : new Set(SWEEP_CATEGORIES.filter((c) => c.defaultOn).map((c) => c.key));
  const cutoff = now - days * DAY_MS;

  const items = [];
  const skipped = { live: 0, tooRecent: 0 };

  const consider = (item) => {
    if (item.live) {
      skipped.live += 1;
      return;
    }
    if (!(item.mtime > 0) || item.mtime >= cutoff) {
      skipped.tooRecent += 1;
      return;
    }
    items.push({ ...item, ageDays: ageDays(item.mtime, now) });
  };

  if (on.has('sessions')) {
    for (const p of scan.projects || []) {
      for (const s of p.sessions) {
        const when = s.lastTs ? Date.parse(s.lastTs) : s.mtime;
        consider({
          id: `session:${s.id}`,
          category: 'sessions',
          label: s.title || s.firstPrompt?.slice(0, 60) || s.id.slice(0, 8),
          detail: `${p.realPath} · ${s.counts.user + s.counts.assistant} messages`,
          bytes: s.totalBytes,
          mtime: Number.isNaN(when) ? s.mtime : when,
          live: s.live,
          sessionId: s.id,
          paths: [s.jsonlPath, ...s.satellites.map((x) => x.path)],
        });
      }
    }
  }

  if (on.has('cruft')) {
    for (const g of scan.cruft?.groups || []) {
      for (const i of g.items) {
        consider({
          id: `cruft:${i.id}`,
          category: 'cruft',
          label: `${g.label}: ${i.name}`,
          detail: i.note || g.dir,
          bytes: i.bytes,
          mtime: i.mtime,
          live: i.live,
          paths: [i.path],
        });
      }
    }
    for (const p of scan.projects || []) {
      for (const o of p.orphanSidecars || []) {
        consider({
          id: `sidecar:${o.id}`,
          category: 'cruft',
          label: `Orphaned session data: ${o.id.slice(0, 8)}…`,
          detail: p.realPath,
          bytes: o.bytes,
          mtime: o.mtime || 0,
          live: false,
          paths: [o.path],
        });
      }
    }
  }

  const scratch = scan.scratchpads;
  if (scratch?.exists) {
    for (const p of scratch.projects) {
      for (const s of p.sessions) {
        const isEmpty = s.empty;
        // Empty husks are their own category: they cost nothing but clutter,
        // and someone may want to clear them without touching real files.
        if (isEmpty && !on.has('emptyScratch')) continue;
        if (!isEmpty && !on.has('scratchpads')) continue;
        consider({
          id: `scratch:${p.id}/${s.sessionId || s.path}`,
          category: isEmpty ? 'emptyScratch' : 'scratchpads',
          label: isEmpty
            ? `Empty scratchpad: ${(s.sessionId || '').slice(0, 8) || s.path.split(/[\\/]/).pop()}`
            : `Scratchpad: ${(s.sessionId || '').slice(0, 8) || s.path.split(/[\\/]/).pop()}`,
          detail: `${p.id} · ${s.scratchFiles} file${s.scratchFiles === 1 ? '' : 's'}, ${s.taskFiles} task output${s.taskFiles === 1 ? '' : 's'}`,
          bytes: s.bytes,
          mtime: s.mtime,
          live: s.live,
          sessionId: s.sessionId,
          paths: [s.path],
        });
      }
    }
    if (on.has('scratchpads')) {
      for (const l of scratch.loose) {
        if (l.reserved) continue; // Claude Code's own payload, never a candidate
        consider({
          id: `scratch-loose:${l.name}`,
          category: 'scratchpads',
          label: `Scratchpad root: ${l.name}`,
          detail: l.note,
          bytes: l.bytes,
          mtime: l.mtime,
          live: l.live,
          paths: [l.path],
        });
      }
    }
  }

  if (on.has('memories')) {
    for (const p of scan.projects || []) {
      for (const f of p.memory.files || []) {
        consider({
          id: `memory:${f.path}`,
          category: 'memories',
          label: `Memory: ${f.name}`,
          detail: f.description || p.realPath,
          bytes: f.bytes,
          mtime: f.mtime,
          live: false,
          paths: [f.path],
        });
      }
    }
  }

  if (on.has('trash')) {
    for (const e of trash || []) {
      const when = Date.parse(e.deletedAt);
      consider({
        id: `trash:${e.id}`,
        category: 'trash',
        label: `Trashed: ${e.label}`,
        detail: `deleted ${new Date(e.deletedAt).toLocaleDateString()}`,
        bytes: e.bytes,
        mtime: Number.isNaN(when) ? 0 : when,
        live: false,
        trashId: e.id,
        paths: [],
      });
    }
  }

  items.sort((a, b) => b.bytes - a.bytes || a.mtime - b.mtime);

  const byCategory = {};
  for (const i of items) {
    byCategory[i.category] ??= { count: 0, bytes: 0 };
    byCategory[i.category].count += 1;
    byCategory[i.category].bytes += i.bytes;
  }

  return {
    days,
    cutoff,
    generatedAt: new Date(now).toISOString(),
    items,
    byCategory,
    totalBytes: items.reduce((n, i) => n + i.bytes, 0),
    totalCount: items.length,
    skipped,
  };
}
