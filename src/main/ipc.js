// The renderer's entire capability surface. Every filesystem operation the UI
// can perform is one named channel here; the preload bridge exposes nothing
// else, so the window cannot reach the disk on its own.

import path from 'node:path';
import fs from 'node:fs/promises';
import { ipcMain, shell, dialog, clipboard } from 'electron';
import { CLAUDE_ROOT, PROJECTS_DIR, TRASH_DIR, isInsideClaudeRoot, isManagedPath } from './paths.js';
import { readLiveSessions } from './scanner.js';
import { readTranscript } from './transcript.js';
import { readMemoryDir, writeMemory } from './memories.js';
import { planIndexRepairs, applyIndexRepairs } from './repair.js';
import { trashItem, listTrash, restoreEntry, purgeEntry, purgeAll } from './trash.js';
import { listDir, readScratchFile } from './scratchpads.js';
import { planSweep, SWEEP_CATEGORIES } from './sweep.js';
import { getSettings, updateSettings } from './settings.js';
import { measure, statOrNull, readDirSafe } from './util.js';
import { fullScan, refresh, scopeForPaths, getIndex, ensureIndex } from './indexer.js';

/** A session may never be deleted while a process is attached to it. */
function assertNotLive(sessionId) {
  const project = getIndex()?.projects.find((p) => p.sessions.some((s) => s.id === sessionId));
  const session = project?.sessions.find((s) => s.id === sessionId);
  if (session?.live) {
    throw new Error(
      `Session ${sessionId.slice(0, 8)}… is attached to a running Claude Code process (pid ${session.liveInfo?.pid}). Close that session first.`
    );
  }
  return { project, session };
}

export function registerIpc() {
  /**
   * `force` re-reads everything; without it the caller gets the index as it
   * stands. Every mutation below leaves the index correct, so the refresh a
   * delete triggers costs nothing rather than repeating the work.
   */
  ipcMain.handle('scan', (_e, { force } = {}) => (force ? fullScan() : ensureIndex()));

  ipcMain.handle('live', async () => [...(await readLiveSessions()).values()]);

  ipcMain.handle('transcript:read', async (_e, { file, includeThinking }) => {
    if (!isInsideClaudeRoot(file)) throw new Error('Refusing to read outside the Claude data directory.');
    return readTranscript(file, { includeThinking });
  });

  ipcMain.handle('session:subagents', async (_e, { sidecarDir }) => {
    if (!sidecarDir || !isInsideClaudeRoot(sidecarDir)) return [];
    const dir = path.join(sidecarDir, 'subagents');
    const out = [];
    for (const name of await readDirSafe(dir)) {
      if (!name.endsWith('.jsonl')) continue;
      const full = path.join(dir, name);
      const st = await statOrNull(full);
      if (!st) continue;
      let meta = null;
      try {
        meta = JSON.parse(await fs.readFile(full.replace(/\.jsonl$/, '.meta.json'), 'utf8'));
      } catch {
        /* meta is optional */
      }
      out.push({
        name,
        path: full,
        bytes: st.size,
        agentId: name.replace(/^agent-|\.jsonl$/g, ''),
        agentType: meta?.agentType || meta?.subagent_type || '',
        description: meta?.description || meta?.label || '',
        model: meta?.resolvedModel || meta?.model || '',
        status: meta?.status || '',
      });
    }
    return out.sort((a, b) => b.bytes - a.bytes);
  });

  ipcMain.handle('memory:read', async (_e, { dir }) => {
    if (!isInsideClaudeRoot(dir)) throw new Error('Refusing to read outside the Claude data directory.');
    const known = new Set(getIndex()?.sessionIds || []);
    const r = await readMemoryDir(dir, known);
    return { ...r, files: r.files.map((f) => ({ ...f, text: undefined })) };
  });

  ipcMain.handle('memory:readFile', async (_e, { file }) => {
    if (!isInsideClaudeRoot(file)) throw new Error('Refusing to read outside the Claude data directory.');
    return fs.readFile(file, 'utf8');
  });

  ipcMain.handle('memory:writeFile', async (_e, { file, text }) => {
    if (!isInsideClaudeRoot(file)) throw new Error('Refusing to write outside the Claude data directory.');
    await writeMemory(file, text);
    return true;
  });

  // ---- MEMORY.md repair ----------------------------------------------------

  /**
   * What an index line points at once it has been deleted is the app's own
   * doing, so the planner is told what is already in the trash and, for a
   * delete that has not happened yet, what is about to join it.
   */
  async function trashedPaths() {
    const entries = await listTrash();
    return entries.flatMap((e) =>
      (e.paths || []).map((p) => ({ path: p.from, label: e.label, deletedAt: e.deletedAt, id: e.id }))
    );
  }

  ipcMain.handle('memory:repairPlan', async (_e, { dir, removedFiles } = {}) => {
    if (!isInsideClaudeRoot(dir)) throw new Error('Refusing to read outside the Claude data directory.');
    const removed = (removedFiles || []).filter((f) => isInsideClaudeRoot(f));
    const memory = await readMemoryDir(dir);
    return planIndexRepairs(memory, { trashed: await trashedPaths(), removedFiles: removed });
  });

  ipcMain.handle('memory:repairApply', async (_e, { dir, ids } = {}) => {
    if (!isInsideClaudeRoot(dir)) throw new Error('Refusing to write outside the Claude data directory.');
    const result = await applyIndexRepairs(dir, { ids, trashed: await trashedPaths() });
    if (result.changed) await refresh(scopeForPaths([dir]));
    return result;
  });

  // ---- deletion -----------------------------------------------------------

  ipcMain.handle('delete:sessions', async (_e, { ids }) => {
    await ensureIndex();
    const results = [];
    const touched = [];
    for (const id of ids) {
      try {
        const { project, session } = assertNotLive(id);
        if (!session) {
          results.push({ id, ok: false, error: 'Session not found; rescan and try again.' });
          continue;
        }
        const paths = [session.jsonlPath, ...session.satellites.map((s) => s.path)];
        const entry = await trashItem({
          kind: 'session',
          label: session.title || session.firstPrompt?.slice(0, 60) || id.slice(0, 8),
          paths,
          context: {
            sessionId: id,
            projectId: project.id,
            projectPath: project.realPath,
            messages: session.counts.user + session.counts.assistant,
            lastTs: session.lastTs,
          },
        });
        results.push({ id, ok: true, entry });
        touched.push(...paths);
      } catch (err) {
        results.push({ id, ok: false, error: err.message });
      }
    }
    await refresh({ ...scopeForPaths(touched), sessions: true });
    return results;
  });

  ipcMain.handle('delete:memories', async (_e, { files }) => {
    const results = [];
    for (const file of files) {
      try {
        const entry = await trashItem({
          kind: 'memory',
          label: path.basename(file),
          paths: [file],
          context: { memoryDir: path.dirname(file) },
        });
        results.push({ id: file, ok: true, entry });
      } catch (err) {
        results.push({ id: file, ok: false, error: err.message });
      }
    }
    await refresh(scopeForPaths(files));
    return results;
  });

  ipcMain.handle('delete:paths', async (_e, { items }) => {
    const results = [];
    for (const item of items) {
      try {
        const entry = await trashItem({
          kind: item.kind || 'cruft',
          label: item.label,
          paths: item.paths,
          context: item.context || {},
        });
        results.push({ id: item.id, ok: true, entry });
      } catch (err) {
        results.push({ id: item.id, ok: false, error: err.message });
      }
    }
    await refresh(scopeForPaths(items.flatMap((i) => i.paths || [])));
    return results;
  });

  ipcMain.handle('delete:project', async (_e, { projectId }) => {
    await ensureIndex();
    const project = getIndex().projects.find((p) => p.id === projectId);
    if (!project) throw new Error('Project not found; rescan and try again.');
    const liveOnes = project.sessions.filter((s) => s.live);
    if (liveOnes.length) {
      throw new Error(
        `${liveOnes.length} session${liveOnes.length === 1 ? '' : 's'} in this project ${liveOnes.length === 1 ? 'is' : 'are'} still running. Close them first.`
      );
    }
    const satellites = project.sessions.flatMap((s) => s.satellites.map((x) => x.path));
    const entry = await trashItem({
      kind: 'project',
      label: project.realPath || project.id,
      paths: [project.dir, ...satellites],
      context: { projectId, sessions: project.sessionCount, memories: project.memory.count },
    });
    await refresh({ ...scopeForPaths(satellites), dropped: [projectId], sessions: true });
    return entry;
  });

  // ---- scratchpads --------------------------------------------------------

  ipcMain.handle('scratch:list', async (_e, { dir }) => {
    if (!isManagedPath(dir)) throw new Error('Refusing to read outside the managed directories.');
    return listDir(dir);
  });

  ipcMain.handle('scratch:readFile', async (_e, { file }) => {
    if (!isManagedPath(file)) throw new Error('Refusing to read outside the managed directories.');
    return readScratchFile(file);
  });

  // ---- age sweep -----------------------------------------------------------

  ipcMain.handle('sweep:categories', () => SWEEP_CATEGORIES);

  ipcMain.handle('sweep:plan', async (_e, { days, categories } = {}) => {
    await ensureIndex();
    const trash = await listTrash();
    return planSweep(getIndex(), trash, {
      days,
      categories: Array.isArray(categories) ? new Set(categories) : undefined,
    });
  });

  /**
   * Execute a plan. Every item is re-checked against the current scan before
   * anything moves: a plan is a snapshot, and a session that started running
   * since it was built must not be swept.
   */
  ipcMain.handle('sweep:run', async (_e, { ids, days, categories } = {}) => {
    await ensureIndex();
    const trash = await listTrash();
    const plan = planSweep(getIndex(), trash, {
      days,
      categories: Array.isArray(categories) ? new Set(categories) : undefined,
    });

    const wanted = Array.isArray(ids) && ids.length ? new Set(ids) : null;
    const chosen = wanted ? plan.items.filter((i) => wanted.has(i.id)) : plan.items;

    const results = [];
    const touched = [];
    for (const item of chosen) {
      try {
        if (item.sessionId) assertNotLive(item.sessionId);

        if (item.category === 'trash' && item.trashId) {
          await purgeEntry(item.trashId);
          results.push({ id: item.id, ok: true, purged: true, bytes: item.bytes });
          continue;
        }

        const entry = await trashItem({
          kind: item.category === 'sessions' ? 'session' : item.category === 'memories' ? 'memory' : 'cruft',
          label: item.label,
          paths: item.paths,
          context: { sweptAt: new Date().toISOString(), ageDays: item.ageDays, category: item.category },
        });
        results.push({ id: item.id, ok: Boolean(entry), bytes: item.bytes, entry });
        touched.push(...(item.paths || []));
      } catch (err) {
        results.push({ id: item.id, ok: false, error: err.message });
      }
    }
    // A sweep can empty half the tree, but it still only touches what it lists.
    await refresh({ ...scopeForPaths(touched), sessions: chosen.some((i) => i.sessionId) });
    return {
      results,
      moved: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      bytes: results.filter((r) => r.ok).reduce((n, r) => n + (r.bytes || 0), 0),
    };
  });

  // ---- settings ------------------------------------------------------------

  ipcMain.handle('settings:get', () => getSettings());
  ipcMain.handle('settings:set', (_e, patch) => updateSettings(patch || {}));

  // ---- trash --------------------------------------------------------------

  ipcMain.handle('trash:list', () => listTrash());
  ipcMain.handle('trash:restore', async (_e, { id }) => {
    const r = await restoreEntry(id);
    await refresh({ ...scopeForPaths(r.restored), sessions: true });
    return r;
  });
  ipcMain.handle('trash:purge', async (_e, { id }) => {
    const r = await purgeEntry(id);
    await refresh({}); // nothing on disk moved outside the trash itself
    return r;
  });
  ipcMain.handle('trash:purgeAll', async () => {
    const r = await purgeAll();
    await refresh({});
    return r;
  });

  // ---- shell integration --------------------------------------------------

  // "Reveal" selects the item inside its parent folder; "open" opens the thing
  // itself (a directory in Explorer, a file in its default app).
  ipcMain.handle('shell:reveal', (_e, { target }) => {
    shell.showItemInFolder(path.normalize(target));
    return true;
  });
  ipcMain.handle('shell:openPath', async (_e, { target }) => shell.openPath(path.normalize(target)));

  /** Open a path's containing directory, or the path itself when it is one. */
  ipcMain.handle('shell:openFolder', async (_e, { target }) => {
    const p = path.normalize(target);
    const st = await statOrNull(p);
    if (!st) {
      // Walk up to the nearest ancestor that still exists rather than failing.
      let up = path.dirname(p);
      while (up !== path.dirname(up) && !(await statOrNull(up))) up = path.dirname(up);
      return shell.openPath(up);
    }
    return shell.openPath(st.isDirectory() ? p : path.dirname(p));
  });

  ipcMain.handle('shell:copy', (_e, { text }) => {
    clipboard.writeText(String(text ?? ''));
    return true;
  });

  ipcMain.handle('shell:exists', async (_e, { target }) => Boolean(await statOrNull(target)));

  ipcMain.handle('confirm', async (_e, { title, message, detail, confirmLabel, danger }) => {
    const { response } = await dialog.showMessageBox({
      type: danger ? 'warning' : 'question',
      buttons: [confirmLabel || 'Delete', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: title || 'Confirm',
      message: message || '',
      detail: detail || '',
      noLink: true,
    });
    return response === 0;
  });

  ipcMain.handle('roots', async () => ({
    claudeRoot: CLAUDE_ROOT,
    projectsDir: PROJECTS_DIR,
    trashDir: TRASH_DIR,
    size: (await measure(CLAUDE_ROOT)).bytes,
  }));
}
