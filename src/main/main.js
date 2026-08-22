// Electron entry point.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, nativeTheme } from 'electron';
import { registerIpc } from './ipc.js';
import { initCache } from './scanner.js';
import { initSettings } from './settings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = process.argv.includes('--dev');

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1040,
    minHeight: 640,
    title: 'Claude Manager',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#16161a' : '#faf9f7',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  if (isDev) win.webContents.openDevTools({ mode: 'detach' });
}

app.whenReady().then(async () => {
  // The scan cache lives in userData, not ~/.claude -- this tool should not
  // add files to the directory it is managing.
  await initCache(path.join(app.getPath('userData'), 'scan-cache.json'));
  await initSettings(path.join(app.getPath('userData'), 'settings.json'));
  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
