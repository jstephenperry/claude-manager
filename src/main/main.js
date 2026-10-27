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
      sandbox: true,
    },
  });

  // The preload bridge is attached to this webContents, not to index.html, so
  // any page the window navigates to inherits window.api, with its deletes,
  // purges and shell.openPath. The app never navigates; a file dropped onto the
  // window would, by Electron's default. Refuse both ways off the page.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

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
