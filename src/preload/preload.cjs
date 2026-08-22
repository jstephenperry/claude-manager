// The bridge. The renderer gets exactly these functions and no Node access.

const { contextBridge, ipcRenderer } = require('electron');

const call = (channel, payload) => ipcRenderer.invoke(channel, payload);

contextBridge.exposeInMainWorld('api', {
  scan: () => call('scan'),
  live: () => call('live'),
  roots: () => call('roots'),

  readTranscript: (file, includeThinking) => call('transcript:read', { file, includeThinking }),
  readSubagents: (sidecarDir) => call('session:subagents', { sidecarDir }),

  readMemoryDir: (dir) => call('memory:read', { dir }),
  readMemoryFile: (file) => call('memory:readFile', { file }),
  writeMemoryFile: (file, text) => call('memory:writeFile', { file, text }),

  deleteSessions: (ids) => call('delete:sessions', { ids }),
  deleteMemories: (files) => call('delete:memories', { files }),
  deletePaths: (items) => call('delete:paths', { items }),
  deleteProject: (projectId) => call('delete:project', { projectId }),

  scratchList: (dir) => call('scratch:list', { dir }),
  scratchReadFile: (file) => call('scratch:readFile', { file }),

  sweepCategories: () => call('sweep:categories'),
  sweepPlan: (days, categories) => call('sweep:plan', { days, categories }),
  sweepRun: (ids, days, categories) => call('sweep:run', { ids, days, categories }),

  getSettings: () => call('settings:get'),
  setSettings: (patch) => call('settings:set', patch),

  trashList: () => call('trash:list'),
  trashRestore: (id) => call('trash:restore', { id }),
  trashPurge: (id) => call('trash:purge', { id }),
  trashPurgeAll: () => call('trash:purgeAll'),

  reveal: (target) => call('shell:reveal', { target }),
  openPath: (target) => call('shell:openPath', { target }),
  openFolder: (target) => call('shell:openFolder', { target }),
  copyText: (text) => call('shell:copy', { text }),
  pathExists: (target) => call('shell:exists', { target }),
  confirm: (opts) => call('confirm', opts),
});
