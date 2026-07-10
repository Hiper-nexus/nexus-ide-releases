/**
 * Spike main (VISUAL-EDIT-001, Fase 0.4): validates the main-world bridge
 * under the EXACT webPreferences browser-manager uses for browser panes
 * (contextIsolation + sandbox + no nodeIntegration).
 *
 * Run: npx electron scripts/spikes/main-world-bridge/spike-main.mjs
 * Exit 0 = bridge works (isolated world blind, main world sees the fiber).
 */
import { app, BrowserWindow, WebContentsView, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const TIMEOUT_MS = 15_000;

function conclude(code, report) {
  console.log(JSON.stringify({ spike: 'main-world-bridge', ...report }, null, 2));
  app.exit(code);
}

app.whenReady().then(() => {
  const win = new BrowserWindow({ show: false, width: 800, height: 600 });
  const view = new WebContentsView({
    webPreferences: {
      preload: path.join(here, 'spike-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      safeDialogs: true,
      navigateOnDragDrop: false,
      spellcheck: false,
    },
  });
  win.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: 800, height: 600 });

  const timer = setTimeout(() => {
    conclude(2, { verdict: 'TIMEOUT', detail: 'no spike:result within 15s' });
  }, TIMEOUT_MS);

  ipcMain.once('spike:result', (_event, report) => {
    clearTimeout(timer);
    const isolatedBlind =
      report?.isolated?.ok === true && report.isolated.fiberKeys.length === 0;
    const mainSees =
      report?.mainWorld?.ok === true &&
      report.mainWorld.fiberKeys.some((k) => k.startsWith('__reactFiber$'));
    const componentFound = report?.mainWorld?.componentName === 'SaveButton';
    const pass =
      report?.webFrameAvailable === true &&
      isolatedBlind &&
      mainSees &&
      componentFound;
    conclude(pass ? 0 : 1, {
      verdict: pass ? 'PASS' : 'FAIL',
      webFrameAvailable: report?.webFrameAvailable,
      isolatedBlind,
      mainSees,
      componentFound,
      raw: report,
    });
  });

  view.webContents.loadFile(path.join(here, 'spike-page.html')).catch((err) => {
    clearTimeout(timer);
    conclude(3, { verdict: 'LOAD_ERROR', detail: String(err) });
  });
});
