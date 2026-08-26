// App preferences, stored in Electron's userData directory. Nothing here is
// written into ~/.claude -- this tool should not add files to the tree it
// manages.

import path from 'node:path';
import { readJsonSafe, writeJsonAtomic } from './util.js';

const DEFAULTS = {
  sweepDays: 60,
  sweepCategories: ['sessions', 'scratchpads', 'cruft', 'emptyScratch'],
  sweepOnLaunch: false,
  // Deleting a memory orphans its MEMORY.md line. On by default because the
  // delete dialog lists every line it will drop before anything happens, and
  // the alternative is leaving behind an index this app then reports as broken.
  repairIndexOnDelete: true,
};

let file = null;
let current = { ...DEFAULTS };

export async function initSettings(settingsPath) {
  file = settingsPath;
  const saved = await readJsonSafe(file, null);
  if (saved && typeof saved === 'object') current = { ...DEFAULTS, ...saved };
  return current;
}

export function getSettings() {
  return { ...current };
}

export async function updateSettings(patch) {
  current = { ...current, ...patch };
  if (file) {
    try {
      await writeJsonAtomic(file, current);
    } catch {
      /* a preference that cannot be persisted still applies this session */
    }
  }
  return { ...current };
}
