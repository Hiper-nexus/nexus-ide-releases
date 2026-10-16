/** Real Chromium check of Git actions. Run: node --import tsx scripts/check-git-button-contrast.ts */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { launchChrome } from './mobile-visual/cdp';
import { PALETTES } from '../src/renderer/styles/ui-theme';
import { contrastRatio } from '../src/renderer/styles/palette-gen';

async function main() {
  const repo = process.cwd();
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-git-contrast-'));
  const evidence = path.join(repo, 'docs/qa/evidence/F-1546');
  const suffix = process.argv.includes('--before') ? 'before' : 'after';
  fs.mkdirSync(evidence, { recursive: true });
  await build({
    stdin: { resolveDir: repo, loader: 'tsx', contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { GitPanelBody } from './src/renderer/components/GitPanelBody';
      import { useGitScmStore } from './src/renderer/state/git-scm-store';
      import { applyUiTheme } from './src/renderer/styles/ui-theme';
      import './src/renderer/styles/global.css';
      window.setTheme = applyUiTheme;
      applyUiTheme('dracula');
      useGitScmStore.setState({ hasStatus: true, clean: true, branch: 'feature/example',
        ahead: 1191, behind: 91, hasUpstream: true, refresh: async () => {}, reset: () => {} });
      createRoot(document.getElementById('root')).render(<GitPanelBody />);
    ` },
    outfile: path.join(temporary, 'renderer.js'), bundle: true, format: 'iife', platform: 'browser', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{"DEV":false,"PROD":true,"MODE":"production"}' },
    loader: { '.ttf': 'file', '.woff2': 'file', '.woff': 'file', '.svg': 'file', '.png': 'file', '.webp': 'file' },
    plugins: [{ name: 'unused-diff-worker', setup(b) {
      b.onResolve({ filter: /\?worker$/ }, () => ({ path: 'worker', namespace: 'unused-worker' }));
      b.onLoad({ filter: /.*/, namespace: 'unused-worker' }, () => ({ contents: 'export default class Worker {}' }));
    } }], logLevel: 'warning',
  });
  fs.writeFileSync(path.join(temporary, 'index.html'), `<!doctype html><html lang="pt-BR"><head>
  <meta charset="utf-8"><link rel="stylesheet" href="renderer.css">
  <style>body{margin:0;background:var(--bg-elevated)}#root{width:500px;height:940px;margin:20px 30px;display:flex;flex-direction:column}</style>
  </head><body><div id="root"></div><script src="renderer.js"></script></body></html>`);
  const browser = await launchChrome();
  const rows: Array<Record<string, unknown>> = [];
  try {
    const { page } = browser;
    await page.send('Emulation.setDeviceMetricsOverride', { width: 560, height: 980, deviceScaleFactor: 1, mobile: false });
    await page.send('Page.navigate', { url: `file://${path.join(temporary, 'index.html')}` });
    for (let tries = 0; tries < 100; tries++) {
      if (await page.evaluate(`!!document.querySelector('.git-scm__clean-actions button')`)) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await page.evaluate('document.fonts.ready');
    await page.send('DOM.enable');
    await page.send('CSS.enable');
    const { root } = await page.send<{ root: { nodeId: number } }>('DOM.getDocument');
    const failures: string[] = [];
    for (const theme of Object.keys(PALETTES)) {
      await page.evaluate(`window.setTheme(${JSON.stringify(theme)})`);
      for (let index = 1; index <= 4; index++) {
        const selector = `.git-scm__clean-actions button:nth-child(${index})`;
        const { nodeId } = await page.send<{ nodeId: number }>('DOM.querySelector', { nodeId: root.nodeId, selector });
        for (const state of ['rest', 'hover', 'active', 'focus-visible', 'pressed']) {
          await page.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: state === 'rest' || state === 'pressed' ? [] : state === 'active' ? ['hover', 'active'] : [state] });
          await page.evaluate(`document.querySelector(${JSON.stringify(selector)}).setAttribute('aria-pressed', ${JSON.stringify(state === 'pressed' ? 'true' : 'false')})`);
          const measured = await page.evaluate<{ label: string; ink: string; background: string; transition: string; filter: string }>(`(() => {
            const button = document.querySelector(${JSON.stringify(selector)});
            const style = getComputedStyle(button);
            const ctx = document.createElement('canvas').getContext('2d', {willReadFrequently: true});
            const rgba = (value) => { ctx.clearRect(0,0,1,1); ctx.fillStyle=value; ctx.fillRect(0,0,1,1); return [...ctx.getImageData(0,0,1,1).data]; };
            const hex = (rgb) => '#' + rgb.slice(0,3).map(v=>Math.round(v).toString(16).padStart(2,'0')).join('');
            const chain = []; for (let e=button;e;e=e.parentElement) chain.unshift(e);
            let bg=[255,255,255];
            for(const e of chain) { const c=rgba(getComputedStyle(e).backgroundColor); bg=bg.map((v,i)=>c[i]*c[3]/255+v*(1-c[3]/255)); }
            return {label:button.textContent,ink:hex(rgba(style.color)),background:hex(bg),transition:style.transitionDuration,filter:style.filter};
          })()`);
          const contrast = contrastRatio(measured.ink, measured.background);
          rows.push({ theme, state, ...measured, contrast });
          if (contrast < 4.5 || measured.filter !== 'none' || measured.transition.split(',').some((v) => parseFloat(v) !== 0)) {
            failures.push(`${theme} ${index} ${state}: contrast=${contrast.toFixed(2)}, filter=${measured.filter}, transition=${measured.transition}`);
          }
        }
        await page.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] });
        await page.evaluate(`document.querySelector(${JSON.stringify(selector)}).removeAttribute('aria-pressed')`);
      }
    }
    await page.evaluate(`window.setTheme('dracula')`);
    const bounds = await page.evaluate<{ x: number; y: number; width: number; height: number }>(`(() => { const r=document.querySelector('.git-scm__clean-actions button').getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height}; })()`);
    assert(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= 560 && bounds.y + bounds.height <= 980, 'entire pressed button must fit viewport');
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 });
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 });
    assert(await page.evaluate(`document.querySelector('.git-scm__clean-actions button').matches(':active')`));
    const screenshot = await page.send<{ data: string }>('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(path.join(evidence, `dracula-pressed-${suffix}.png`), Buffer.from(screenshot.data, 'base64'));
    fs.writeFileSync(path.join(evidence, `contrast-${suffix}.json`), JSON.stringify({ rows, failures }, null, 2) + '\n');
    assert.equal(failures.length, 0, failures.join('\n'));
    console.log(`${rows.length} button/theme/state checks passed; complete Dracula :active screenshot saved.`);
  } finally {
    browser.close();
    fs.rmSync(temporary, { recursive: true, force: true });
  }

}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
