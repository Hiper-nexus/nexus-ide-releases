#!/usr/bin/env node
// Harness visual dos itens WEB-12 (F-1030), WEB-17 (F-1031) e WEB-13 (F-1032).
// Empacota as cenas de scripts/render-web-harvest-ui.entry.tsx (componentes
// reais + global.css) com esbuild, abre num BrowserWindow do Electron SEM
// preload, sem IPC, com userData temporário (nunca o perfil do operador) e
// grava PNGs via capturePage em docs/qa/evidence/F-10xx/.
// Rode fora do pane do Nexus (launchd): Electron dentro do PTY supervisionado
// morre com MachPortRendezvousServer.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(`${repo}/package.json`);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-web-harvest-ui-'));
const evidence = (item) => path.join(repo, 'docs', 'qa', 'evidence', item);

const SCENES = [
  { scene: 'usage-ready', item: 'F-1030', file: 'usage-history-ready.png', width: 1100, height: 860 },
  { scene: 'usage-hover', item: 'F-1030', file: 'usage-history-day-focus.png', width: 1100, height: 860 },
  { scene: 'usage-usd', item: 'F-1030', file: 'usage-history-usd.png', width: 1100, height: 860 },
  { scene: 'usage-table', item: 'F-1030', file: 'usage-history-table.png', width: 1100, height: 1100 },
  { scene: 'usage-states', item: 'F-1030', file: 'usage-history-states.png', width: 980, height: 900 },
  { scene: 'quote-before', item: 'F-1031', file: 'quote-timeline.png', width: 920, height: 760 },
  { scene: 'quote-after', item: 'F-1031', file: 'quote-in-composer.png', width: 920, height: 760 },
  { scene: 'tabs-default', item: 'F-1032', file: 'tabs-default.png', width: 1040, height: 220 },
  { scene: 'tabs-drop', item: 'F-1032', file: 'tabs-drag-indicator.png', width: 1040, height: 220 },
  { scene: 'tabs-moved', item: 'F-1032', file: 'tabs-reordered.png', width: 1040, height: 220 },
  { scene: 'tabs-menu', item: 'F-1032', file: 'tabs-menu-move.png', width: 1040, height: 520 },
];

await build({
  entryPoints: [path.join(repo, 'scripts', 'render-web-harvest-ui.entry.tsx')],
  outfile: path.join(root, 'renderer.js'),
  bundle: true,
  // Script clássico: módulo ES em file:// esbarra em CORS no Chromium.
  format: 'iife',
  platform: 'browser',
  jsx: 'automatic',
  define: {
    'process.env.NODE_ENV': '"production"',
    'import.meta.env': '{"DEV":false,"PROD":true,"MODE":"production"}',
  },
  loader: { '.ttf': 'file', '.woff2': 'file', '.woff': 'file', '.svg': 'file', '.png': 'file', '.webp': 'file' },
  logLevel: 'warning',
});

fs.writeFileSync(
  path.join(root, 'index.html'),
  `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<link rel="stylesheet" href="renderer.css">
<style>
  html, body { margin: 0; background: var(--bg); color: var(--text); font-family: var(--font-ui); }
  #root { min-height: 100vh; }
  .harness-settings { max-width: 880px; margin: 0 auto; padding: 16px; container-type: inline-size; }
  .harness-stack { display: grid; gap: 16px; }
  .harness-mission { display: flex; flex-direction: column; height: 100vh; }
  .harness-inspector { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; padding: 12px 16px; }
  .harness-tabs { padding: 24px 0 0; display: block; }
  .harness-caption { margin: 0; padding: 12px 16px; color: var(--text-dim); font: 12px var(--font-mono); }
</style></head><body><div id="root"></div><script src="renderer.js"></script></body></html>`,
);

const main = `
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
app.setPath('userData', ${JSON.stringify(path.join(root, 'user-data'))});
app.disableHardwareAcceleration();
const scenes = ${JSON.stringify(SCENES.map((entry) => ({ ...entry, out: path.join(evidence(entry.item), entry.file) })))};
const deadline = setTimeout(() => { console.error('harness timeout'); app.exit(1); }, 120000);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1100, height: 860, backgroundColor: '#080709',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  const errors = [];
  win.webContents.on('console-message', (event) => {
    if (event.level === 'error') errors.push(event.message);
  });
  win.showInactive();
  for (const entry of scenes) {
    win.setContentSize(entry.width, entry.height);
    await win.loadFile(${JSON.stringify(path.join(root, 'index.html'))}, { search: 'scene=' + entry.scene });
    const end = Date.now() + 15000;
    while (!(await win.webContents.executeJavaScript('document.body.dataset.ready === "1"'))) {
      if (Date.now() > end) throw new Error('scene not ready: ' + entry.scene);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
    const probe = await win.webContents.executeJavaScript(\`(() => {
      const pick = (selector) => document.querySelector(selector)?.textContent?.replace(/\\\\s+/g, ' ').trim() ?? null;
      return {
        order: pick('#harness-order'),
        readout: pick('.usage-history__readout'),
        quoteNotice: pick('.mission-board__direction-quote'),
        draft: document.querySelector('.mission-board__direction-draft')?.value ?? null,
        drop: document.querySelector('.workspace-tab[data-drop]')?.getAttribute('data-drop') ?? null,
        live: pick('.workspace-tabs__live'),
        menu: [...document.querySelectorAll('[role="menuitem"] strong')].map((node) => node.textContent),
      };
    })()\`);
    fs.mkdirSync(require('path').dirname(entry.out), { recursive: true });
    fs.writeFileSync(entry.out, (await win.webContents.capturePage()).toPNG());
    console.log('SHOT', entry.scene, '->', entry.out, JSON.stringify(probe));
  }
  clearTimeout(deadline);
  if (errors.length) { console.error('renderer errors:\\n' + errors.join('\\n')); app.exit(1); return; }
  console.log('PASS web harvest UI: ' + scenes.length + ' screenshots');
  app.quit();
}).catch((error) => { console.error(error && error.stack || error); clearTimeout(deadline); app.exit(1); });
`;
fs.writeFileSync(path.join(root, 'main.cjs'), main);

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(require('electron'), [path.join(root, 'main.cjs')], { env, stdio: 'inherit' });
const timeout = setTimeout(() => child.kill('SIGTERM'), 150_000);
child.on('exit', (code) => {
  clearTimeout(timeout);
  fs.rmSync(root, { recursive: true, force: true });
  process.exitCode = code ?? 1;
});
